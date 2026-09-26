// U20 — a big page's snapshot, cheaper. On BrowserStack pricing the snapshot
// was 12.3k characters, the largest single tool output of the plain-prompt run,
// and a third of it was the footer's 66 links plus runs of identical info
// buttons. A large section folds to one line that says how to expand it; a run
// of identical controls collapses to one line that keeps every ref.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/fold.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let raw;
let page;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  raw = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  await raw('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

const refOf = (line) => /\[ref=(e\d+)\]/.exec(line)?.[1];

test('a large section folds to one line: its size, its parts, and how to expand it', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /^- footer: 27 links, folded \(sections "PRODUCTS", "RESOURCES", "COMPANY"\) — cor_snapshot within: "footer" lists them$/m, snap);
  assert.doesNotMatch(snap, /link "Careers"/);
  // …and what the tests need is not folded.
  assert.match(snap, /section "Team Ultimate"/);
  assert.match(snap, /link "Sign in" \[ref=e\d+\]/);
});

test('within: "footer" expands the fold, with refs that act', async () => {
  await raw('cor_snapshot');
  const out = await raw('cor_snapshot', { within: 'footer' });
  const line = out.split('\n').find((l) => l.includes('link "Careers"'));
  assert.ok(line, out);
  await raw('cor_click', { ref: refOf(line) });
  assert.match(page.url(), /#Careers$/);
});

test('a section holding most of the page is not folded — there would be nothing left to see', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `<a href="#l${i}">Link ${i}</a>`).join(' ');
  await page.setContent(`<button>Only</button><footer>${links}</footer>`);
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /folded/);
  assert.match(snap, /link "Link 29"/);
  await page.goto(`${base}/`);
});

test('a small section is not folded', async () => {
  const links = Array.from({ length: 24 }, (_, i) => `<a href="#l${i}">Link ${i}</a>`).join(' ');
  await page.setContent(`${'<button>Main</button>'.repeat(0)}${Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join('')}<footer>${links}</footer>`);
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /folded/);
  await page.goto(`${base}/`);
});

test('a run of identical controls collapses to one line with every ref, in page order', async () => {
  const snap = await raw('cor_snapshot');
  const line = snap.split('\n').find((l) => /4× button "info"/.test(l));
  assert.ok(line, snap);
  const refs = line.match(/e\d+/g);
  assert.equal(refs.length, 4);
  assert.doesNotMatch(snap, /\(1 of 4\)/);
  // Each ref is its own button, in page order.
  const all = await page.$$('ul.bundle button');
  for (const [i, ref] of refs.entries()) {
    await raw('cor_click', { ref });
    assert.equal(await all[i].evaluate((el) => el === document.activeElement || el.matches(':focus') || window.__lastClicked === el), true, `ref ${ref} is button ${i + 1}`);
  }
});

test('two identical controls, or a run broken by a state, are listed as before', async () => {
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /2× button "More"/);
  assert.equal(snap.split('\n').filter((l) => /button "More" \[ref=/.test(l)).length, 2);
  assert.doesNotMatch(snap, /× button "Tab"/);
  assert.match(snap, /button "Tab" \[ref=e\d+\] \[disabled\]/);
});

test('the legend explains a collapsed run only when there is one', async () => {
  const snap = await raw('cor_snapshot');
  assert.match(snap, /N× role "name": identical controls, one ref each in page order/);
  await page.setContent('<button>One</button>');
  assert.doesNotMatch(await raw('cor_snapshot'), /N× role/);
  await page.goto(`${base}/`);
});

test('a large section of form controls and a table is not folded — only link lists are (selectorshub)', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => `<tr><td><input type="checkbox" aria-label="select ${i}"></td><td>User ${i}</td><td><a href="#u${i}">Edit</a></td></tr>`).join('');
  const menu = Array.from({ length: 60 }, (_, i) => `<button>Menu ${i}</button>`).join('');
  await page.setContent(`${menu}<h2>iframe and table</h2><div><input type="search" aria-label="Search"><select aria-label="Size"><option>10</option></select>${Array.from({ length: 5 }, (_, i) => `<button>Page ${i}</button>`).join('')}<table class="users">${rows}</table></div>`);
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /folded/, snap);
  assert.match(snap, /checkbox "select 9"/);
  await page.goto(`${base}/`);
});

test('a named table of links is not folded: rows are what tests read', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<tr><td><a href="#r${i}">Result ${i}</a></td></tr>`).join('');
  const menu = Array.from({ length: 40 }, (_, i) => `<button>Menu ${i}</button>`).join('');
  await page.setContent(`${menu}<table aria-label="Search results">${rows}</table>`);
  const snap = await raw('cor_snapshot');
  assert.doesNotMatch(snap, /folded/, snap);
  await page.goto(`${base}/`);
});
