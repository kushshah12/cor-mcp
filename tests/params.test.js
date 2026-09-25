// U18 — parameterised locators. Every template is checked by counting it on
// the page with real Playwright, value by value — never by comparing strings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { interpolateTemplate } from '../../client/src/interpolate.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/params.html', import.meta.url), 'utf8'));
});
after(() => site.close());

const session = createSession({ headless: true });
after(() => session.close());

let call;
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
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

const params = async (selector) => (await callPage(page, 'inspect', { selector, framework: 'playwright', max: 1 })).params;

/** Count the registry template with each value filled in, as the client would fill it. */
async function countEach(p, form = 'playwright') {
  const { selectorTemplate, syntax } = p.template[form];
  const entry = { selectorTemplate, vars: [{ varName: p.param, syntax }] };
  return Promise.all(p.values.map(async (v) => {
    const selector = interpolateTemplate(entry, { [p.param]: v });
    return page.locator(form === 'xpath' ? `xpath=${selector}` : selector).count();
  }));
}

/** Run the readable code the agent is told to write, with each value. */
async function countCode(p) {
  const locatorFor = new Function('page', p.param, `return ${p.code};`);
  return Promise.all(p.values.map((v) => locatorFor(page, v).count()));
}

test('titles that start with one another: exact matching, each title finds its own card', async () => {
  const p = await params('#shop .card:nth-child(1) button');
  assert.equal(p.param, 'title');
  assert.equal(p.value, 'Phone 12');
  assert.deepEqual(p.values, ['Phone 12', 'Phone 12 Mini', 'Phone 12 Pro', '12" Monitor', "Kid's Tee"]);
  assert.deepEqual(await countEach(p), [1, 1, 1, 1, 1]);
  assert.deepEqual(await countCode(p), [1, 1, 1, 1, 1]);
  // The trap the exact match avoids: a substring filter picks three cards.
  assert.equal(await page.locator('div.card').filter({ hasText: 'Phone 12' }).count(), 3);
});

test('the template finds the right card, not just one card', async () => {
  const p = await params('#shop .card:nth-child(2) button');
  const entry = { selectorTemplate: p.template.playwright.selectorTemplate, vars: [{ varName: p.param, syntax: p.template.playwright.syntax }] };
  for (const [i, v] of p.values.entries()) {
    const title = await page.locator(interpolateTemplate(entry, { title: v })).evaluate((el) => el.closest('.card').querySelector('h3').textContent);
    assert.equal(title, p.values[i]);
  }
});

test('quotes in values are escaped for the Playwright string and for XPath', async () => {
  const p = await params('#shop .card:nth-child(4) button');
  assert.equal(p.value, '12" Monitor');
  assert.ok(p.template.xpath, 'an XPath form exists');
  assert.deepEqual(await countEach(p, 'xpath'), [1, 1, 1, 1, 1]);
  assert.deepEqual(await countEach(p), [1, 1, 1, 1, 1]);
});

test('a test attribute on the item beats its title', async () => {
  const p = await params('.tile:nth-child(2) button');
  assert.equal(p.param, 'testId');
  assert.deepEqual(p.values, ['tile-alpha', 'tile-beta']);
  assert.deepEqual(await countEach(p), [1, 1]);
  assert.deepEqual(await countCode(p), [1, 1]);
});

test('two items with the same label: no template, and the reason names it', async () => {
  const p = await params('.rows li:nth-child(3) button');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /two items share the label "Alice"/);
});

test('a generated id or a price is never the parameter', async () => {
  const p = await params('#box-8121 button');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /numbers or prices|no attribute or label/);
  const out = await call('cor_inspect', { selector: '#box-8121 button' });
  assert.match(out, /Not parameterised — 2 items share this shape/);
  assert.doesNotMatch(out.slice(out.indexOf('Not parameterised')).split('\n')[0], /box-8121/);
});

test('a title that also names an item outside the list is not a parameter', async () => {
  const p = await params('.film-strip .film:nth-child(1) button');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /does not pick each item on its own/);
});

test('a table row is named by its key column, and the header names the parameter', async () => {
  const p = await params('tbody tr:nth-child(2) button');
  assert.equal(p.param, 'name');
  assert.deepEqual(p.values, ['Ada', 'Grace']);
  assert.deepEqual(await countEach(p), [1, 1]);
  assert.deepEqual(await countCode(p), [1, 1]);
});

test('a one-off element gets no Parameterised block', async () => {
  assert.equal(await params('#checkout'), null);
  assert.doesNotMatch(await call('cor_inspect', { selector: '#checkout' }), /arameterised/);
});

test('cor_inspect renders the block: code for Playwright, XPath for others', async () => {
  const pw = await call('cor_inspect', { selector: '#shop .card:nth-child(1) button' });
  assert.match(pw, /Parameterised — 5 items share this shape; every value checked, each finds exactly its own item \(5\/5\)/);
  assert.match(pw, /title = "Phone 12" {3}\(also: "Phone 12 Mini", "Phone 12 Pro", "12\\" Monitor"|title = "Phone 12" {3}\(also: "Phone 12 Mini", "Phone 12 Pro", "12" Monitor"/);
  assert.match(pw, /getByText\(title, \{ exact: true \}\)/);
  assert.match(pw, /Registry template \(css-string\): div\.card:has\(h3\.card-title:text-is\("__title__"\)\)/);
  assert.match(pw, /write one function taking title/);
  const se = await call('cor_inspect', { selector: '#shop .card:nth-child(1) button', framework: 'selenium' });
  assert.match(se, /XPath: \/\/div\[contains\(concat\(' ', normalize-space\(@class\), ' '\), ' card '\)\]/);
  assert.doesNotMatch(se, /getByText\(title/);
});

test('a template Playwright cannot count as one per value is withdrawn', async () => {
  // Break the page after the in-page check would pass: a second card titled
  // "Phone 12" appears only for Playwright's count.
  const { verifyTemplate } = await import('../src/tools/inspect.js');
  const p = await params('#shop .card:nth-child(1) button');
  await page.evaluate(() => document.querySelector('#shop').insertAdjacentHTML('beforeend',
    '<div class="card" id="late"><h3 class="card-title">Phone 12</h3><button>Add to cart</button></div>'));
  try {
    await verifyTemplate(page, p);
    assert.equal(p.template, undefined);
    assert.match(p.reason, /matched 2 for "Phone 12" when Playwright counted it/);
  } finally {
    await page.evaluate(() => document.querySelector('#late').remove());
  }
});
