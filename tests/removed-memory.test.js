// A locator that is unique only because an act removed its other match.
// Found in an agent run on bstackdemo.com (2026-09-25): after "Add to cart"
// opened the cart, `span.bag__quantity` was called unique — the header badge
// was gone. Close the cart and it matches two.
//
// Equivalent mutant, on purpose: remembering hidden elements too (dropping
// the isConnected guard) changes no output — a hidden element is still in the
// DOM and counted, so a locator matching it is never unique and never flagged.
// The guard stays so hidden-element churn cannot evict real removals from the
// 50-slot memory.
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
  res.end(readFileSync(new URL('./fixtures/cart-live.html', import.meta.url), 'utf8'));
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
  page = await session.getPage();
});

const fresh = () => call('cor_open', { url: `${base}/` });
const safer = (out) => /Unique in both states: page\.locator\('(.+)'\)$/m.exec(out)?.[1];

test('after an act removes the other match, the pick is flagged and a form unique in both states is offered', async () => {
  await fresh();
  await call('cor_click', { target: '#add' });
  const out = await call('cor_inspect', { selector: '.float-cart .bag__quantity' });
  assert.match(out, /^ {2}page\.locator\('span\.bag__quantity'\)$/m, out);
  assert.match(out, /⚠ Unique only in this state: it also matches clickable "1" \(\.bag\)|⚠ Unique only in this state: it also matches clickable "0"/, out);
  const css = safer(out);
  assert.ok(css, out);
  assert.equal(await page.locator(css).count(), 1, 'unique with the cart open');
  // Close the cart: the header badge is back. The plain pick now matches two; the safer one still one.
  await page.click('#close');
  assert.equal(await page.locator('span.bag__quantity').count(), 2);
  assert.equal(await page.locator(css).count(), 1);
  assert.equal(await page.locator(css).evaluate((el) => Boolean(el.closest('.float-cart'))), true);
});

test('alternatives that share the problem carry the warning', async () => {
  await fresh();
  await call('cor_click', { target: '#add' });
  const out = await call('cor_inspect', { selector: '.float-cart .bag__quantity', all: true });
  const alts = out.split('Alternatives:')[1] ?? '';
  assert.match(alts, /span\.bag span'\)\n.*\n(?:.*\n)*? {3}! Unique only in this state/);
});

test('before any act there is nothing to remember and no warning', async () => {
  await fresh();
  assert.doesNotMatch(await call('cor_inspect', { selector: '.float-cart .bag__quantity' }), /Unique only in this state/);
});

test('a hidden element needs no memory: it is still counted, and no warning is added', async () => {
  await fresh();
  await call('cor_click', { target: '#hide' });
  const out = await call('cor_inspect', { selector: '.float-cart .bag__quantity' });
  assert.doesNotMatch(out, /Unique only in this state/);
  assert.doesNotMatch(out, /^ {2}page\.locator\('span\.bag__quantity'\)$/m, 'the hidden copy is still counted, so the plain class is not unique');
});

test('a new document forgets what the old one removed', async () => {
  await fresh();
  await call('cor_click', { target: '#add' });
  await fresh();
  await page.evaluate(() => document.querySelector('#top .bag').remove()); // removed by the page, not by an act
  assert.doesNotMatch(await call('cor_inspect', { selector: '.float-cart .bag__quantity' }), /Unique only in this state/);
});
