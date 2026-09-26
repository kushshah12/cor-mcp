// U19.3 — cor_grade across every value. The agent writes its own
// parameterised helper; COR proves it for every item on the page (or for the
// values given) and names the items no value reaches.
//
// Equivalent mutant, on purpose: accepting a single match without checking it
// lies inside the item the value came from changes nothing for chains that
// filter by the item's own text — that text finds its item or several, never
// one other item. The check stays for chains that step out of the item
// (a following-sibling step), where a single match can be the wrong item.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/plans.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let call;
// One hook: node:test does not wait for one root-level before() to finish before starting the next.
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  await call('cor_open', { url: `${base}/` });
});

// The agent's helper, as a page-object method body would read it.
const CHOOSE = "page.locator('div.card').filter({ visible: true }).filter({ has: page.getByText(title, { exact: true }) }).getByRole('button', { name: 'Choose' })";

test('values discovered: each card gets the value that finds it; a card no value reaches is named', async () => {
  const out = await call('cor_grade', { selector: CHOOSE, param: 'title' });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^Across every item \(title, 3 visible items of div\.card\):/m);
  assert.match(out.text, /^ {2}item 1 "Team": ✓ 1 match/m);
  assert.match(out.text, /^ {2}item 2 "Team Ultimate": ✓ 1 match/m);
  assert.match(out.text, /^ {2}item 3 "Volume": ✗ no value finds it/m);
  assert.match(out.text, /Works for 2 of 3 items/);
  // …and the durability grade still follows, on a value that works.
  assert.match(out.text, /Chain — scored by its weakest step/);
});

test('values given: each is counted, and a value that finds nothing or several is flagged', async () => {
  const out = await call('cor_grade', { selector: CHOOSE, param: 'title', values: ['Team', 'Team Pro', 'Team Ultimate', 'Enterprise', 'Choose'] });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^ {2}"Team": ✓ 1 match/m);
  assert.match(out.text, /^ {2}"Team Pro": ✓ 1 match/m);
  assert.match(out.text, /^ {2}"Enterprise": ✗ 0 matches/m);
  assert.match(out.text, /^ {2}"Choose": ✗ 2 matches/m);
  assert.match(out.text, /Works for 3 of 5 values/);
});

test('discovered values: names first, never a price', async () => {
  const perItem = await callPage(await session.getPage(), 'itemCandidates', { css: 'div.card' });
  assert.equal(perItem[0][0], 'Team', 'the toggle label naming the card comes first');
  assert.equal(perItem[1][0], 'Team Ultimate');
  for (const cands of perItem) assert.ok(cands.every((v) => !/\$\s?\d/.test(v)), JSON.stringify(cands));
});

test('param without the variable in the selector is refused clearly', async () => {
  const out = await call('cor_grade', { selector: "page.getByRole('button', { name: 'Choose' })", param: 'title' });
  assert.equal(out.isError, true);
  assert.match(out.text, /does not use the parameter "title"/);
});

test('object shorthand for the parameter ({ name, exact: true }) — how the page-object run wrote it', async () => {
  const sel = "page.locator('div.card').filter({ visible: true }).filter({ has: page.getByRole('heading', { name, exact: true }).or(page.locator('label').getByText(name, { exact: true })) }).getByRole('button', { name: 'Choose' })";
  const out = await call('cor_grade', { selector: sel, param: 'name' });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /Works for 2 of 3 items/);
});

// From the plain-prompt BrowserStack run (2026-09-26): the agent extended COR's
// plan-card template with the price and ran the suite without grading it; the
// Team card holds one price per variant, so the price step matched 2 and the
// first run failed on strict mode. One grade across every value catches it.
test('a step added to a template is proven per item: two prices in one card are flagged', async () => {
  const card = "page.locator('div.card').filter({ visible: true }).filter({ has: page.getByText(title, { exact: true }) })";
  const bad = await call('cor_grade', { selector: `${card}.locator('.card__price')`, param: 'title', values: ['Team', 'Team Ultimate'] });
  assert.match(bad.text, /^ {2}"Team": ✗ 2 matches/m, bad.text);
  assert.match(bad.text, /^ {2}"Team Ultimate": ✓ 1 match/m);
  const good = await call('cor_grade', { selector: `${card}.locator('.card__price').filter({ visible: true })`, param: 'title', values: ['Team', 'Team Ultimate'] });
  assert.match(good.text, /^ {2}"Team": ✓ 1 match/m, good.text);
});
