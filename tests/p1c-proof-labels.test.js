// P1c: proof labels (spec §8: V1, V3), the Variants / every-item lines in the detected framework (R5),
// the Cypress data-cy note (§7.3, moved here from P1b), and the ambiguity wording in cor_grade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { verifyTemplate } from '../src/tools/inspect.js';

const INLINE = {
  '/nodata': '<title>Plain</title><button class="save">Save</button><button class="cancel">Cancel</button>',
  '/onlycy': '<title>Only cy</title><button data-cy="save">Save</button><button>Cancel</button>',
  '/twins': '<title>Twins</title><div id="a" class="row"><span class="v">1</span></div><div id="b" class="row"><span class="v">2</span></div>',
};
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  const path = req.url.split('?')[0];
  if (INLINE[path]) return res.end(INLINE[path]);
  try { res.end(readFileSync(new URL(`./fixtures${path}`, import.meta.url), 'utf8')); } catch { res.end('missing'); }
});

let base;
let clientOf;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => { site.closeAllConnections?.(); site.close(); });

/** A fresh session and server per test: notes said once per session start over. */
async function connect(t) {
  const session = createSession({ headless: true });
  t.after(() => session.close());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  clientOf = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  return { call: clientOf, session };
}
const CARD = '.grid .card:nth-child(2) button';

// ── V1: what "every value checked" rests on ──
test('P1c V1: an item template names what checked it — Playwright counted it; the XPath was checked with the browser\'s engine', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  const pw = await call('cor_inspect', { selector: CARD, framework: 'playwright' });
  assert.match(pw, /^ {2}Proof: counted by Playwright, every value\.$/m);
  // P3a: WebdriverIO now gets a rendered helper with its own proof line (tests/p3a-wdio-renderer.test.js); Cypress waits for P3b.
  for (const fw of ['cypress']) {
    const out = await call('cor_inspect', { selector: CARD, framework: fw });
    assert.match(out, /^ {2}Proof: checked with the browser's XPath engine for every value; the XPath is used as it is\.$/m, fw);
    assert.doesNotMatch(out, /counted by Playwright/, `${fw} is not told Playwright counted it`);
  }
});

test('P1c V1: a row × column cell carries the same labels', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/compare.html` });
  const cell = 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)';
  assert.match(await call('cor_inspect', { selector: cell, framework: 'playwright' }), /^ {2}Proof: counted by Playwright, every value\.$/m);
  assert.match(await call('cor_inspect', { selector: cell, framework: 'webdriverio' }), /^ {2}Proof: checked with the browser's XPath engine/m);
});

test('P1c V1: the XPath form must find the same element as Playwright\'s form for every value — one element is not enough', async (t) => {
  const { session } = await connect(t);
  await session.getPage().then((page) => page.goto(`${base}/twins`));
  const page = await session.getPage();
  const params = (xpath) => ({
    kind: 'item', param: 'n', values: ['1', '2'], count: 2,
    code: "page.locator('.row')", 
    template: {
      playwright: { selectorTemplate: '.row:has(.v:text-is("__n__"))', syntax: 'css-string' },
      xpath: { selectorTemplate: xpath, syntax: 'xpath-literal' },
    },
  });
  // finds the right row for both values
  const good = params('//div[@class="row"][.//span[normalize-space()=__n__]]');
  await verifyTemplate(page, good);
  assert.ok(good.template.xpath, 'the same element for every value keeps the XPath form');
  // one element for each value, but the other row's: a count of 1 would pass
  const wrong = params('//div[@class="row"][not(.//span[normalize-space()=__n__])]');
  await verifyTemplate(page, wrong);
  assert.equal(wrong.template.xpath, null, 'a different single element drops the XPath form');
  assert.ok(wrong.template.playwright, 'the Playwright form stays');
});

test('P1c V1: a cell XPath the browser\'s engine does not count as one is dropped, whatever Playwright counted', async (t) => {
  const { session } = await connect(t);
  const real = await session.getPage();
  await real.goto(`${base}/twins`);
  // Playwright "counts" one for every combination (stubbed); only the browser's own count can tell
  const page = { locator: () => ({ count: async () => 1 }), evaluate: real.evaluate.bind(real) };
  const cell = (xpath) => ({
    kind: 'cell', vars: ['r', 'c'], row: '1', column: 'x', rows: ['1'], columns: ['x'],
    template: { playwright: { selectorTemplate: `xpath=${xpath}`, syntax: 'xpath-literal' }, xpath: { selectorTemplate: xpath, syntax: 'xpath-literal' } },
  });
  const one = cell('//span[normalize-space()=__r__ and normalize-space()!=__c__]');
  await verifyTemplate(page, one);
  assert.ok(one.template.xpath, 'one hit per combination keeps the XPath form');
  const two = cell('//span[@class="v"][normalize-space()!=__c__ or normalize-space()=__r__]');
  await verifyTemplate(page, two);
  assert.equal(two.template.xpath, null, 'two hits in the browser withdraws it');
  assert.ok(two.template.playwright, 'the Playwright form is left as it was');
});

test('P1c V1: an XPath that finds the right element and others is not "one element": it is dropped', async (t) => {
  const { session } = await connect(t);
  const page = await session.getPage();
  await page.goto(`${base}/twins`);
  const params = { kind: 'item', param: 'n', values: ['1'], count: 1, code: "page.locator('.row')",
    template: { playwright: { selectorTemplate: '.row:has(.v:text-is("__n__"))', syntax: 'css-string' }, xpath: { selectorTemplate: '//div[@class="row"][__n__ or true()]', syntax: 'xpath-literal' } } };
  await verifyTemplate(page, params); // the first hit is the right row, but there are two hits
  assert.equal(params.template.xpath, null);
});

// ── V3 ──
test('P1c V3: cor_grade says what its count rests on — Playwright, or emulated for a Cypress / WebdriverIO form', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  assert.match(await call('cor_grade', { selector: "page.getByRole('heading', { name: 'Volume' })" }), /^Proof: counted by Playwright\.$/m);
  assert.match(await call('cor_grade', { selector: 'h1' }), /^Proof: counted by Playwright\.$/m);
  const cy = await call('cor_grade', { selector: "cy.get('h1')" });
  assert.match(cy, /^Proof: emulated — not run in Cypress; counted with Playwright\.$/m);
  assert.doesNotMatch(cy, /counted by Playwright/);
  assert.match(await call('cor_grade', { selector: "cy.contains('h1', 'Plans')" }), /^Proof: emulated — not run in Cypress/m);
  assert.match(await call('cor_grade', { selector: "$('h1')" }), /^Proof: emulated — not run in WebdriverIO; counted with Playwright\.$/m);
  // a fragile / ambiguous verdict carries it too, not only a Healthy one
  assert.match(await call('cor_grade', { selector: "cy.get('button')" }), /^Proof: emulated — not run in Cypress/m);
});

test('P1c V3: no proof is claimed when the selector could not be counted', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  const out = await call('cor_grade', { selector: "page.locator('myengine=anything')" });
  assert.match(out, /^Match count unknown/m);
  assert.doesNotMatch(out, /Proof:/);
});

test('P1c: an ambiguous grade says what this framework does, from the engine\'s failure mode', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  assert.match(await call('cor_grade', { selector: "page.locator('button')" }), /^Ambiguous — matches \d+ elements, so it is not usable as written\. In this framework the test fails at once\.$/m);
  assert.match(await call('cor_grade', { selector: "$('button')" }), /In this framework the run acts on the first match and does not fail\.$/m);
  assert.match(await call('cor_grade', { selector: "cy.get('button')" }), /In this framework an action fails, an assertion runs on all of them\.$/m);
});

// ── R5 ──
test('P1c R5: the Variants line is never Playwright syntax for WebdriverIO or Cypress', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  const pw = await call('cor_inspect', { selector: CARD, framework: 'playwright' });
  assert.match(pw, /Variants: "Team Pro" sits behind the "Team" item's toggle\. Show a variant: page\./);
  // P3a: WebdriverIO's Variants line names its own helper's click (tests/p3a-wdio-renderer.test.js); Cypress waits for P3b.
  for (const [fw, name] of [['cypress', 'Cypress']]) {
    const out = await call('cor_inspect', { selector: CARD, framework: fw });
    const line = out.split('\n').find((l) => l.includes('Variants:'));
    assert.ok(line, fw);
    assert.doesNotMatch(line, /page\.|getByText|\.click\(\)/, `${fw}: ${line}`);
    assert.match(line, new RegExp(`\\(No ${name} form for the click yet\\.\\)$`), fw);
  }
});

test('P1c R5: the every-item line renders in WebdriverIO and Cypress, with the same CSS the item template proved', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/plans.html` });
  const wdio = await call('cor_inspect', { selector: CARD, framework: 'webdriverio' });
  assert.match(wdio, /^ {2}Every item \(2 now\): \$\$\('div\[data-product-id="live"\] div\.card'\) — loop over it when the test covers every item/m);
  const cy = await call('cor_inspect', { selector: CARD, framework: 'cypress' });
  assert.match(cy, /^ {2}Every item \(2 now\): cy\.get\('div\[data-product-id="live"\] div\.card'\) — loop over it/m);
  assert.doesNotMatch(cy + wdio, /\.all\(\)/);
});

// ── the Cypress data-cy note ──
test('P1c D3: Cypress on a page with no test attributes gets the data-cy note once per session, and no other framework does', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/nodata` });
  const first = await call('cor_inspect', { selector: '.save', framework: 'cypress' });
  assert.match(first, /^Note: Cypress guidance prefers data-cy attributes and this page has none — ask for data-cy on the elements you test\.$/m);
  const second = await call('cor_inspect', { selector: '.cancel', framework: 'cypress' });
  assert.doesNotMatch(second, /data-cy attributes/, 'said once');
  for (const fw of ['playwright', 'webdriverio']) assert.doesNotMatch(await call('cor_inspect', { selector: '.save', framework: fw }), /data-cy attributes/, fw);
});

test('P1c D3: a data-cy alone is a test attribute — no note', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/onlycy` });
  assert.doesNotMatch(await call('cor_inspect', { selector: 'button:nth-child(2)', framework: 'cypress' }), /data-cy attributes/);
});

test('P1c D3: no note when the page has a test attribute; the locator itself is the engine\'s', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '#email', framework: 'cypress' });
  assert.doesNotMatch(out, /data-cy attributes/);
  assert.match(out, /cy\.get\('\[data-cy="email-input"\]'\)/);
});

