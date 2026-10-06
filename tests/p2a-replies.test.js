// P2a (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — replies that carry the next step: cor_inspect
// targets (many elements, one entry each), act replies and cor_snapshot within with the entries for what they show.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { memberName } from '../src/entries.js';

const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`./fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t) {
  const session = createSession({ headless: true, cwd: new URL('./golden/projects/empty/', import.meta.url).pathname });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') }; };
}
const refOf = (text, re) => re.exec(text)?.[1];

test('P2a cor_inspect targets: one call, one entry each; a template\'s items share one entry; bad targets are reported inline', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/pricing` });
  const snap = (await call('cor_snapshot')).text;
  const alice = refOf(snap, /item "Alice" › button "Delete" \[ref=(e\d+)\]/);
  const bob = refOf(snap, /item "Bob" › button "Delete" \[ref=(e\d+)\]/);
  const sales = refOf(snap, /section "Volume" › button "Contact Sales" \[ref=(e\d+)\]/);
  const out = (await call('cor_inspect', { targets: [alice, bob, sales, 'e99', '#nope'] })).text;
  assert.match(out, /^Entries — place in tests\/pages\/pricing\.page\.js/);
  assert.match(out, new RegExp(`^${alice}, ${bob} → delete$`, 'm'), 'both items under one template entry');
  assert.equal((out.match(/· 2\/2 items checked/g) ?? []).length, 1);
  assert.match(out, new RegExp(`^${sales} → contactSalesButton$`, 'm'));
  assert.match(out, /^e99 ✗ Ref e99 does not exist/m);
  assert.match(out, /^#nope ✗ No element matches "#nope"/m);
  assert.doesNotMatch(out, /Alternatives:|Why this order|Durable —/, 'entries only — the detail is for one ref alone');
  assert.match((await call('cor_inspect', { ref: alice, targets: [bob] }).catch((e) => ({ text: e.message }))).text, /exactly one of ref .*, selector, or targets/);
});

test('P2a cor_inspect targets: two elements named alike get two member names', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/pricing` });
  const snap = (await call('cor_snapshot')).text;
  const out = (await call('cor_inspect', { targets: [refOf(snap, /"Item 1": (e\d+)/), refOf(snap, /"Item 2": (e\d+)/)] })).text;
  const members = [...out.matchAll(/→ (\w+)$/gm)].map((m) => m[1]);
  assert.equal(new Set(members).size, members.length, out);
});

test('P2a an act reply carries the entry for what it showed: open an FAQ answer → its template entry, named by its class', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  const snap = (await call('cor_snapshot')).text;
  const out = (await call('cor_click', { ref: refOf(snap, /clickable "Can I get invoices\?" \[ref=(e\d+)\]/) })).text;
  const answer = refOf(out, /\+ "Yes, from the billing page\." \[ref=(e\d+)\]/);
  assert.ok(answer, out);
  assert.match(out, new RegExp(`^${answer} → faqItemAnswer$`, 'm'), 'named by its class, not by one answer\'s words');
  assert.match(out, /faqItemAnswer = \(question\) => this\.page\.locator\('div\.faq-item'\)/);
});

test('P2a cor_snapshot within carries the region\'s entries after its lines', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/cards` });
  const out = (await call('cor_snapshot', { within: 'Team' })).text;
  const [region, entries] = out.split('\nEntries —');
  assert.match(region, /text "\$150 \/ month" \[ref=e\d+\]/);
  assert.ok(entries, out);
  assert.match(entries, /→ cardPrice\n {2}\/\/ COR cor:[0-9a-f]{6} · 2\/2 items checked/);
  assert.match(entries, /→ choose\n/);
});

test('P2a member names: a name that differs per item is not the member name; a constant label is', () => {
  const item = (leaf, values, tag = 'h3', code = "x.locator('h3.card__name')") => memberName({ element: { tag }, params: { values, model: { leaf } } }, { param: 'title', code });
  assert.equal(item({ role: 'heading', name: 'Coffee Mug', css: 'h3.card__name' }, ['Coffee Mug', 'Gel Pen']), 'cardName', 'an item\'s own title');
  assert.equal(item({ role: null, name: 'Yes, from the billing page.', css: 'div.faq-item__answer' }, ['Can I get invoices?'], 'div'), 'faqItemAnswer');
  assert.equal(item({ role: null, name: 'Remove', css: 'button.btn' }, ['Gel Pen'], 'button'), 'remove', 'a control\'s constant label');
  assert.equal(item({ role: null, name: 'Add to cart', css: 'div.buy' }, ['iPhone'], 'div', "x.getByText('Add to cart')"), 'addToCart', 'named in the code: constant');
  assert.equal(memberName({ element: { tag: 'span', id: 'plan', testIds: {} } }), 'plan', 'no name: its id');
  assert.equal(memberName({ element: { tag: 'span', id: 'item-42', testIds: {} } }), 'element', 'not a numbered id');
});
