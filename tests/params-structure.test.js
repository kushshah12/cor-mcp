// U18b.2 — structural repeats: items that share a class rather than a name,
// with a target that can be a non-control (an FAQ answer). From the BrowserStack
// comparison: both agents built the FAQ locator inline for one question.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { verifyTemplate } from '../src/tools/inspect.js';
import { interpolateTemplate } from '../../client/src/interpolate.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/faq.html', import.meta.url), 'utf8'));
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

const params = async (selector) => {
  const p = (await callPage(page, 'inspect', { selector, framework: 'playwright', max: 1 })).params;
  if (p) await verifyTemplate(page, p);
  return p;
};
const run = (code, name, value) => new Function('page', name, `return ${code};`)(page, value);
const registry = (p, v) => interpolateTemplate({ selectorTemplate: p.template.playwright.selectorTemplate, vars: [{ varName: p.param, syntax: p.template.playwright.syntax }] }, { [p.param]: v });
const QUESTIONS = ['What is the cancellation policy?', 'How secure is my payment?', 'Can I get invoices?'];

test('a hidden FAQ answer: found by its question, for every item', async () => {
  const p = await params('.faq-item:nth-child(2) .faq-item__answer');
  assert.equal(p.param, 'question');
  assert.equal(p.value, 'How secure is my payment?');
  assert.deepEqual(p.values, QUESTIONS);
  assert.equal(p.counted, 3);
  for (const [i, v] of QUESTIONS.entries()) {
    const answer = run(p.code, p.param, v);
    assert.equal(await answer.count(), 1, v);
    assert.equal(await page.locator(registry(p, v)).count(), 1, v);
    assert.equal(await answer.evaluate((el) => el.closest('.faq-item').querySelector('.faq-item__question').textContent), QUESTIONS[i]);
  }
});

test('the question itself: its own text is the parameter, and the template opens the right answer', async () => {
  const p = await params('.faq-item:nth-child(3) .faq-item__question');
  assert.equal(p.param, 'question');
  assert.deepEqual(p.values, QUESTIONS);
  await run(p.code, p.param, 'Can I get invoices?').click();
  assert.equal(await page.locator('.faq-item.open .faq-item__answer').textContent(), 'Yes, from the billing page.');
});

test('items with nothing to tell them apart get no template, and the reason', async () => {
  const p = await params('.tile:nth-child(2) .tile__icon');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /no attribute or label inside the item tells the items apart|two items share/);
});

test('cor_inspect leads with the structural template', async () => {
  const out = await call('cor_inspect', { selector: '.faq-item:nth-child(1) .faq-item__answer' });
  assert.match(out, /^Recommended — parameterised: 3 items share this shape/m);
  assert.match(out, /question = "What is the cancellation policy\?"/);
  assert.match(out, /page\.locator\('div\.faq-item'\)\.filter\(\{ has: page\.locator\('p\.faq-item__question'\)\.getByText\(question, \{ exact: true \}\) \}\)\.locator\('div\.faq-item__answer'\)/);
});

test('an attribute holding a path or an image is never the parameter', async () => {
  const p = await params('.menu-group:nth-child(2) button');
  assert.ok(!p?.template || !/\//.test(p.value), JSON.stringify(p));
  const out = await call('cor_inspect', { selector: '.menu-group:nth-child(2) button' });
  assert.doesNotMatch(out, /openIcon =|Recommended — parameterised/);
  assert.match(out, /Not parameterised — 2 items share this shape, but no attribute or label inside the item tells the items apart/);
});

test('a target whose class repeats inside its item is not located by class alone', async () => {
  const p = await params('.plan:nth-child(2) .plan__price:nth-of-type(2)');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /not the only one of its kind inside its item/);
});

test('an item holding only its link gets no own-text template', async () => {
  const p = await params('.nav__item:nth-child(2) a');
  assert.ok(!p?.template, JSON.stringify(p));
});
