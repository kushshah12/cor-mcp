import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

// A long legal section, to show the line cap.
const LONG = `<!doctype html><title>Terms</title><h1>Site</h1>
  <section><h2>Price</h2><div style="display:flex"><span>$</span><span>375</span><span>/ month</span></div><p>Hel<b>lo</b> world</p><button>Buy</button></section>
  <section><h2>Terms</h2>${Array.from({ length: 100 }, (_, i) => `<p>Clause ${i + 1} applies.</p>`).join('')}<button>Accept</button></section>`;

let base;
const site = createHttpServer((req, res) => {
  let html;
  try {
    html = req.url === '/long' ? LONG : readFileSync(new URL(`./fixtures/${req.url.slice(1)}`, import.meta.url));
  } catch {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
const session = createSession({ headless: true });
let client;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
});
after(async () => {
  await client.close();
  await session.close();
  site.close();
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
}
const open = (page) => call('cor_open', { url: `${base}/${page}` });
const refIn = (text, pattern) => text.split('\n').find((l) => pattern.test(l))?.match(/\[ref=(e\d+)\]/)?.[1];

test('"the $375 plan" is answerable with one extra call: a name lists its regions, a ref shows one in full', async () => {
  await open('pricing.html');
  const full = await call('cor_snapshot');
  assert.doesNotMatch(full.text, /\$375/, 'the default outline carries no prices');
  const cardRef = refIn(full.text, /section "Team Ultimate" › button "Choose"/);

  // A name that fits two regions is not guessed at.
  const byName = await call('cor_snapshot', { within: 'Team Ultimate' });
  assert.equal(byName.isError, false);
  assert.match(byName.text, /^"Team Ultimate" names 2 regions\. Pick one and pass a ref from inside it as within:/);
  assert.match(byName.text, new RegExp(`1\\. section "Team Ultimate" — e\\.g\\. button "Choose" \\[ref=${cardRef}\\]`));
  assert.match(byName.text, /2\. table › column "Team Ultimate" — e\.g\. combobox \[ref=e\d+\]/);

  const card = await call('cor_snapshot', { within: cardRef });
  assert.match(card.text, /section "Team Ultimate" in full/);
  assert.match(card.text, /- text "\$375 \/ month"/);
  assert.match(card.text, new RegExp(`- button "Choose" \\[ref=${cardRef}\\]`), 'the same element keeps its ref');
  assert.doesNotMatch(card.text, /5 users/, "the table column's dropdown is another region");
  assert.doesNotMatch(card.text, /\$450/, 'hidden text stays hidden');
});

test("refs from both snapshots resolve, and a scoped snapshot alone issues real refs", async () => {
  await open('pricing.html');
  const full = await call('cor_snapshot');
  const outside = refIn(full.text, /item "Alice" › button "Delete"/);
  const scoped = await call('cor_snapshot', { within: refIn(full.text, /section "Team Ultimate" › button "Choose"/) });
  const inside = refIn(scoped.text, /button "Choose"/);
  assert.equal((await call('cor_inspect', { ref: outside })).isError, false, 'a default-snapshot ref outside the region');
  assert.equal((await call('cor_inspect', { ref: inside })).isError, false, 'a ref shown in the scoped snapshot');

  // No snapshot current: the scoped one issues the refs.
  await open('pricing.html');
  const alone = await call('cor_snapshot', { within: 'Users' });
  const deleteRef = refIn(alone.text, /button "Delete"/);
  assert.ok(deleteRef);
  assert.equal((await call('cor_inspect', { ref: deleteRef })).isError, false);
});

test('a section led by a page-level heading runs to the next heading of its level, heading first', async () => {
  await open('pricing.html');
  const users = await call('cor_snapshot', { within: 'Users' });
  const lines = users.text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines[0], '- heading "Users"');
  assert.deepEqual(lines.slice(1, 4).map((l) => l.replace(/ \[ref=e\d+\]/, '')), ['- text "Alice"', '- button "Delete"', '- text "Bob"']);
  assert.doesNotMatch(users.text, /Team Ultimate|Choose/, 'nothing before the heading');
});

test('an unknown name is an actionable error listing the headings; a stale ref is refused', async () => {
  await open('pricing.html');
  const missing = await call('cor_snapshot', { within: 'Nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No region is named "Nope"\. Headings on this page: "Plans", "Team Ultimate", "Volume"/);
  assert.match(missing.text, /pass a ref from inside the region/);

  const full = await call('cor_snapshot');
  const ref = refIn(full.text, /button "Choose"/);
  await call('cor_click', { target: '#plain-box' });
  const stale = await call('cor_snapshot', { within: ref });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /is stale/);
  // A name still works after an act, with a fresh set of refs.
  assert.equal((await call('cor_snapshot', { within: 'Users' })).isError, false);
});

test('a flex row reads as one line; inline markup does not split words', async () => {
  await open('long');
  const price = await call('cor_snapshot', { within: 'Price' });
  assert.match(price.text, /- text "\$ 375 \/ month"\n- text "Hello world"/);
});

test('a long region is capped and says how to narrow it', async () => {
  await open('long');
  const terms = await call('cor_snapshot', { within: 'Terms' });
  const lines = terms.text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 80);
  assert.match(terms.text, /… \d+ more lines — pass a narrower region as within\./);
});
