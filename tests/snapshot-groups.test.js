// Repeated items collapse to one "each:" line plus one line per item with its
// own refs. Accuracy must not move: every item keeps its name and refs (no
// ranges to count through), every per-item marker stays beside its ref, and
// an item with other controls is listed on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { expandGroups } from './helpers/outline.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/groups.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let raw; // raw tool text: these tests read the grouped form itself
let page;
// One hook: node:test does not wait for one root-level before() to finish before starting the next.
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  raw = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
  await raw('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

/** What an agent does: find the item's line, take the ref at the control's position in "each:". */
function refFor(snap, item, control) {
  const lines = snap.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(`- "${item}": `));
  assert.ok(at >= 0, `no line for ${item}`);
  let h = at;
  while (!/, each: /.test(lines[h])) h--;
  const controls = lines[h].split(', each: ')[1].split(/, (?=\w+ ")/);
  const refs = lines[at].trim().slice(`- "${item}": `.length).split(/, (?=e\d+)/).map((r) => r.split(' ')[0]);
  return refs[controls.indexOf(control)];
}

test('list items collapse: one each-line, one line per item with its own refs', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /^- 4 items, each: button "Remove", button "Add to cart"$/m);
  assert.match(snap, /^ {2}- "iPhone 12": e\d+, e\d+$/m);
  assert.match(snap, /^ {2}- "Pixel 4": e\d+, e\d+$/m);
});

test('a per-item marker stays beside its ref', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /^ {2}- "iPhone 12 Mini": e\d+, e\d+ ✓id$/m);
  assert.match(snap, /^ {2}- "Galaxy S20": e\d+, e\d+ \[disabled\]$/m);
});

test('an item with other controls is listed on its own, not in the group', async () => {
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /- "Pixel 3": /);
  assert.match(snap, /^- item "Pixel 3"\n {2}- button "Remove" \[ref=e\d+\]\n {2}- button "Add to cart" \[ref=e\d+\]\n {2}- button "Notify me" \[ref=e\d+\]$/m);
});

test('table rows and plain hinted cards (the bstackdemo shape) group too', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /- 3 rows, each: button "Edit"/);
  assert.match(snap, /^ {4}- "Grace": e\d+$/m);
  assert.match(snap, /- 3 items, each: button "Buy", button "Save"/);
  assert.match(snap, /^ {2}- "One Plus 8T": e\d+, e\d+$/m);
});

test('items with the same roles but different names are separate groups', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /^- 3 items, each: button "Buy"\n {2}- "Apples": e\d+\n {2}- "Pears": e\d+\n {2}- "Plums": e\d+\n- 3 items, each: button "Sell"$/m);
});

test('two alike items are listed as they are, not grouped', async () => {
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /- 2 items, each/);
  assert.match(snap, /item "Left" › button "Go" \[ref=e\d+\]/);
});

test('an agent reads the right ref straight off the item line', async () => {
  const snap = await raw('cor_snapshot');
  for (const [item, control, expected] of [
    ['Galaxy S20', 'button "Add to cart"', 'Galaxy S20'],
    ['Pixel 4', 'button "Remove"', 'Pixel 4'],
    ['One Plus 8T', 'button "Save"', 'One Plus 8T'],
    ['Grace', 'button "Edit"', 'Grace'],
    ['Silver', 'button "Sell"', 'Silver'],
  ]) {
    const ref = refFor(snap, item, control);
    const el = await page.evaluateHandle((r) => window.__corMcp.element({ ref: r }), ref);
    const found = await el.evaluate((e) => ({ text: e.textContent, owner: (e.closest('li,tr,.card')?.querySelector('span,td,p')?.textContent ?? '') }));
    assert.equal(found.owner, expected, `${item} / ${control}`);
    assert.equal(`button "${found.text}"`, control);
  }
});

test('the group legend appears only when a group is shown; ungrouped lines are unchanged', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /"N items, each: …": every item has those controls/);
  assert.match(snap, /^- button "Checkout" \[ref=e\d+\]$/m);
  await raw('cor_open', { url: 'data:text/html,<button>Solo</button><button>Other</button>' });
  assert.doesNotMatch(await raw('cor_snapshot'), /N items, each/);
  await raw('cor_open', { url: `${base}/` });
});

test('grouping keeps every element: the expanded snapshot lists the same refs as an ungrouped render', async () => {
  const snap = await raw('cor_snapshot');
  const refs = (t) => [...t.matchAll(/\be\d+\b/g)].map((m) => m[0]).sort();
  const expanded = expandGroups(snap);
  assert.deepEqual(refs(expanded.split('\n').filter((l) => l.includes('[ref=')).join('\n')), refs(snap.split('\n').slice(2).join('\n')));
  assert.equal(new Set(refs(snap.split('\n').slice(2).join('\n'))).size, Number(/— (\d+) interactive/.exec(snap)[1]));
});
