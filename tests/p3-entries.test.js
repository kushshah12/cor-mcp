// P3 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — complete entries: the every-item locator is a
// member with its own id; a variant's toggle click is in the entry; an item that starts open is noted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p3-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIRS = [new URL('./fixtures/', import.meta.url), new URL('../scripts/conformance/fixtures/', import.meta.url)];
const site = createHttpServer((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  for (const dir of DIRS) {
    try { const body = readFileSync(new URL(`${name}.html`, dir)); return res.writeHead(200, { 'content-type': 'text/html' }).end(body); } catch { /* next */ }
  }
  res.writeHead(404).end();
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

const DEPS = { playwright: { '@playwright/test': '1' }, cypress: { cypress: '13' }, webdriverio: { webdriverio: '9' } };
async function connect(t, framework = 'playwright') {
  const dir = join(root, `${framework}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: DEPS[framework] }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: createRecordStore({ root: () => session.root }) });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return { dir, call: async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') }; } };
}

test('P3 the every-item locator is a member with its own id; a loop written with it passes cor_check; items share one record', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  const first = (await call('cor_inspect', { selector: '.faq-item:nth-child(1) .faq-item__question' })).text;
  const second = (await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__answer' })).text;
  const every = /^ {2}\/\/ COR cor:([0-9a-f]{6}) · faqItems\n {2}faqItems = \(\) => this\.page\.locator\('div\.faq-item'\);$/m;
  assert.match(first, every, first);
  assert.equal(every.exec(first)[1], every.exec(second)[1], 'every item of the template shares the every-item record');
  const block = first.split('\n').filter((l) => /^ {2}(\/\/ COR|\w+ = )/.test(l)).join('\n');
  writeFileSync(join(dir, 'faq.page.js'), `export class FaqPage {\n  constructor(page) { this.page = page; }\n${block}\n}\n`);
  const check = (await call('cor_check', { files: ['faq.page.js'] })).text;
  assert.match(check, /^cor_check: 2 locators in 1 file \(the given files\) — 2 carry a COR id, 0 to fix\./, check);
  const heal = await call('cor_heal', { id: every.exec(first)[1] });
  assert.match(heal.text, /is an every-item locator — it finds every item, not one element/);
  assert.equal(readdirSync(join(dir, '.cor/records')).length, 3, 'question, answer, and one every-item record');
});

for (const [fw, show] of [
  ['playwright', /showVariant = \(title\) => this\.page\.locator\('div\.plan'\)\.filter\(\{ visible: true \}\)\.locator\('label'\)\.getByText\(title, \{ exact: true \}\);/],
  ['cypress', /showVariant = \(title\) => plan\(title\)\n {4}\.contains\('label', [^\n]*\n {4}\.click\(\)\n {4}\.closest\('label'\)[^\n]*\.should\('be\.checked'\);/],
  ['webdriverio', /showVariant = \(title\) => plan\(title\)\.\$\(`label=\$\{title\}`\)\.click\(\);/],
]) {
  test(`P3 a variant's toggle click is in the entry (${fw}) and the note names it`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3a-either` });
    const out = (await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' })).text;
    assert.match(out, show, out);
    assert.match(out, /\/\/ COR cor:[0-9a-f]{6} · showVariant · variant — click it first/);
    assert.match(out, /^note: "Team Pro" sits behind the "Team" item's toggle — showVariant\("Team Pro"\) first\.$/m);
  });
}

test('P3 an item that is open now is noted — by class, or by aria-expanded — and only when the items differ', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-accordion-open` });
  assert.match((await call('cor_inspect', { selector: '.qa:nth-child(2) .qa__q' })).text, /^note: "Do you offer refunds\?" is open now — clicking it closes it; check its state before clicking$/m);
  assert.match((await call('cor_inspect', { selector: '.acc__item:nth-child(1) .acc__btn' })).text, /^note: "Returns" is open now/m);
  assert.doesNotMatch((await call('cor_inspect', { selector: '.tip:nth-child(2) .tip__t' })).text, /(is|are) open now/, 'every item open: nothing to note');
  await call('cor_open', { url: `${base}/faq` }); // every item closed: nothing to note
  assert.doesNotMatch((await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__question' })).text, /(is|are) open now/);
});

for (const [fw, check] of [['playwright', 'toBeVisible\\(\\)'], ['cypress', "should\\('be\\.visible'\\)"], ['webdriverio', 'isDisplayed\\(\\)']]) {
  test(`P3 an element a closed item clips to 0 height (not hidden) is noted, with ${fw}'s own visibility check named`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-accordion-open` });
    await call('cor_click', { target: '.bs:nth-child(1) .bs__q' });
    const out = (await call('cor_inspect', { selector: '.bs:nth-child(1) .bs__a' })).text;
    assert.match(out, new RegExp(`^note: when its item is closed, bsA is clipped to 0 height, not hidden — ${check} still passes; assert the item's open state or bsA's height instead$`, 'm'), out);
  });
}

test('P3 a 0-height wrapper that does not clip (its text spills and is seen) gets no note', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-accordion-open` });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.sp:nth-child(2) .sp__a' })).text, /clipped to 0 height/);
});

test('P3 a closed item that hides its content (display: none) gets no 0-height note', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  await call('cor_click', { target: '.faq-item:nth-child(3) .faq-item__question' });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.faq-item:nth-child(3) .faq-item__answer' })).text, /clipped to 0 height/);
});
