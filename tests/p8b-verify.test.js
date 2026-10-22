// P8b (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md, origin docs/brainstorms/2026-10-06-cor-record-reuse-requirements.md
// R13–R20): what the repo's records say is on a page is verified on cor_open and cor_check instead of rediscovered — states
// replayed in a background tab, failures reported with cor_heal or "re-inspect", never "verified" when the element changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { verifyPages, verifyRecord } from '../src/verify.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p8b-'));
after(() => rmSync(root, { recursive: true, force: true }));
const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`./fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, dir = join(root, Math.random().toString(16).slice(2))) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const records = createRecordStore({ root: () => session.root });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
  return { dir, call, session, records };
}
const idOf = (text) => /cor:([0-9a-f]{6})/.exec(text)[1];

/** A first run: the heading and the Team Pro price (a state after the toggle) are placed in shop.spec.js. */
async function firstRun(t) {
  const run = await connect(t);
  await run.call('cor_open', { url: `${base}/p8b-shop` });
  const heading = idOf(await run.call('cor_inspect', { selector: 'h1' }));
  await run.call('cor_click', { target: 'label[for=t2]' });
  const price = idOf(await run.call('cor_inspect', { selector: '.card:nth-child(1) .card__price:not([hidden])' }));
  writeFileSync(join(run.dir, 'shop.spec.js'), `// COR cor:${heading} · title\nconst title = (page) => page.locator('h1');\n// COR cor:${price} · cardPrice\nconst cardPrice = (page) => page.locator('.x');\n`);
  const checked = await run.call('cor_check', { files: ['shop.spec.js'] });
  return { ...run, heading, price, checked };
}

test('P8b cor_open lists what the code already uses on the page, verified — the price through its replayed state (R13, R14, R18)', async (t) => {
  const { call, checked } = await firstRun(t);
  assert.match(checked, /Records: 2 of 2 verified on the live page\./, 'cor_check verifies every placed record (R19)');
  const reply = await call('cor_open', { url: `${base}/p8b-shop` });
  assert.match(reply, /Already in your code on \/p8b-shop \(shop\.spec\.js\): 2 elements\./);
  assert.match(reply, /verified: cardPrice \(2 values\), \w+\n/, 'the heading, and the price after replaying the toggle');
  assert.doesNotMatch(reply, /cardName/, 'the toggle its state replays is kept, but no code uses it: not listed (AE4)');
});

test('P8b after a release, a changed element is never "verified": the heading is broken, the price "state not reached" with its step (AE1, AE2)', async (t) => {
  const { call, heading, price } = await firstRun(t);
  const reply = await call('cor_open', { url: `${base}/p8b-shop?release=2` });
  assert.doesNotMatch(reply, /verified: /);
  assert.match(reply, new RegExp(`broken, (cor_heal has a proposal|re-inspect): \\w+ cor:${heading} — `));
  assert.match(reply, new RegExp(`state not reached: cardPrice \\(2 values\\) cor:${price} — step click "Team Pro" \\(cor:[0-9a-f]{6}\\) finds 0 elements`));
  const checked = await call('cor_check', { files: ['shop.spec.js'] });
  assert.match(checked, new RegExp(`✗ shop\\.spec\\.js:2 — cor:${heading} \\(\\w+\\) broken on /p8b-shop`), 'cor_check reports per code location');
  assert.match(checked, new RegExp(`✗ shop\\.spec\\.js:4 — cor:${price} \\(cardPrice\\) state not reached`));
  assert.match(checked, /Records: 0 of 2 verified/);
});

test('P8b an item template is checked for every value: renaming the second card breaks the price (R13)', async (t) => {
  const { call, price } = await firstRun(t);
  const reply = await call('cor_open', { url: `${base}/p8b-shop?release=3` });
  assert.match(reply, new RegExp(`broken, (cor_heal has a proposal|re-inspect): cardPrice \\(2 values\\) cor:${price} — finds 0 elements for "Team Ultimate"`));
});

test('P8b past the time cap the rest is "not checked"; a version-1 record "needs state"; pending entries are never listed (R12, R17, R22, AE5)', async (t) => {
  const { session, records, dir, heading } = await firstRun(t);
  const v1 = '0a0b0c';
  writeFileSync(join(dir, `.cor/records/${v1}.json`), JSON.stringify({ v: 1, id: v1, page: `${base}/p8b-shop`, member: 'old', fingerprint: { tag: 'h1', attrs: {}, text: 'Pricing' }, strategies: [{ kind: 'css', value: 'h1' }], usedIn: [{ file: 'old.spec.js', line: 1 }] }));
  const page = await session.getPage();
  const pages = records.listPages();
  const capped = await verifyPages({ context: page.context(), records, pages, slugs: Object.keys(pages), capMs: 0 });
  assert.equal(capped.get(heading).status, 'not checked');
  assert.equal(capped.get(v1).status, 'needs state');
  const done = await verifyPages({ context: page.context(), records, pages, slugs: Object.keys(pages), capMs: 20_000 });
  assert.equal(done.get(heading).status, 'verified');
  assert.ok(![...done.values()].some((r) => records.listPending().includes(r.record.id)), 'pending entries are not verified');
});

test('P8b a locator that still finds one element is not "verified" when the element is not the recorded one (AE1, R13)', async (t) => {
  const session = createSession({ headless: true, cwd: root });
  t.after(() => session.close());
  const page = await session.getPage();
  const record = { strategies: [{ kind: 'css', value: 'h1' }], fingerprint: { tag: 'h1', attrs: {}, text: 'Pricing', classes: ['shop__title'] } };
  await page.goto(`${base}/p8b-shop`);
  assert.deepEqual(await verifyRecord(page, record), { ok: true });
  await page.goto(`${base}/p8b-shop?release=2`);
  assert.deepEqual(await verifyRecord(page, record), { ok: false, why: 'finds one element, but not the recorded one' });
});

// Run 6efb7196 (WDIO, BrowserStack): four elements the passing tests used were reported broken.
test('P8b run 6efb7196: a cell is checked at its recorded row × column — never through a header class; recorded without one, it is "not checked"', async (t) => {
  const { call, records, session } = await connect(t);
  await call('cor_open', { url: `${base}/p8b-shop` });
  const id = idOf(await call('cor_inspect', { selector: 'tbody tr:nth-child(1) td:nth-child(3)' }));
  const record = records.read(id);
  assert.equal(record.kind, 'cell');
  assert.deepEqual(Object.values(record.cell), ['Bug Capture', 'Team Ultimate']);
  const page = await session.getPage();
  assert.deepEqual(await verifyRecord(page, record), { ok: true });
  const { cell: _, ...old } = record;
  assert.deepEqual(await verifyRecord(page, old), { skip: 'recorded before COR kept its row and column: cor_inspect it once' });
});

test('P8b run 6efb7196: a masked stored locator ([token]) is not run — the next one is; none left is "not checked", not broken', async (t) => {
  const session = createSession({ headless: true, cwd: root });
  t.after(() => session.close());
  const page = await session.getPage();
  await page.goto(`${base}/p8b-shop`);
  const fingerprint = { tag: 'h1', attrs: {}, text: 'Pricing', classes: ['shop__title'] };
  const masked = { kind: 'css', value: 'div[data-toggle-group="[token]"] h1' };
  assert.deepEqual(await verifyRecord(page, { strategies: [masked, { kind: 'css', value: 'h1' }], fingerprint }), { ok: true });
  assert.ok((await verifyRecord(page, { strategies: [masked], fingerprint })).skip);
});

test('P8b run 6efb7196: a template that finds the wrapper of the recorded text element (its only child) verifies', async (t) => {
  const session = createSession({ headless: true, cwd: root });
  t.after(() => session.close());
  const page = await session.getPage();
  await page.goto(`${base}/p8b-shop`);
  const record = { kind: 'item', values: ['How do I pay?', 'Can I cancel?'], fingerprint: { tag: 'p', attrs: {}, text: 'By card.', classes: [] },
    strategies: [{ kind: 'template', value: 'div.faq:has(p.faq__q:text-is("__question__")) >> div.faq__a' }] };
  assert.deepEqual(await verifyRecord(page, record), { ok: true });
});

test('P8b run 6efb7196: "already in your code" lists only code that still holds the id — a rewritten file drops it', async (t) => {
  const { call, dir, price } = await firstRun(t);
  writeFileSync(join(dir, 'shop.spec.js'), `// COR cor:${price} · cardPrice\nconst cardPrice = (page) => page.locator('.x');\n`); // the heading is gone from the code
  const reply = await call('cor_open', { url: `${base}/p8b-shop` });
  assert.match(reply, /Already in your code on \/p8b-shop \(shop\.spec\.js\): 1 element\.\n  verified: cardPrice \(2 values\)\n/);
});
