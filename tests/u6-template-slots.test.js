// U6 (D1) — each part of a parameterised locator follows the decision rule: the item scope and the name slot use a
// test attribute before a class; the leaf follows the framework's order, falling back to a test-id prefix checked in
// every item; never a position. On saucedemo COR scoped on `div.inventory_item` and Cypress clicked `button.btn`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

const site = createHttpServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/u6-slots.html', import.meta.url)));
});
const session = createSession({ headless: true, cwd: '/' });
let call;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `http://127.0.0.1:${site.address().port}` });
});
after(() => { site.closeAllConnections?.(); site.close(); return session.close(); });

const POSITIONAL = /\.first\(\)|\.last\(\)|\.nth\(|\.eq\(|>> nth=|\)\[\d+\]/;

test('U6 (AE2) Playwright: test-id scope, test-id name slot, role leaf unique in the item', async () => {
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-bike-light"]' });
  assert.match(out, /every value checked, each finds exactly its own item \(3\/3\)/, out);
  assert.match(out, /page\.locator\('\[data-test="inventory-item"\]'\)\.filter\(\{ has: page\.locator\('\[data-test="inventory-item-name"\]'\)\.getByText\(name, \{ exact: true \}\) \}\)\.getByRole\('button', \{ name: 'Add to cart', exact: true \}\)/, out);
  assert.match(out, /Every item \(3 now\): page\.locator\('\[data-test="inventory-item"\]'\)/);
  assert.doesNotMatch(out, /div\.inventory_item/);
  assert.doesNotMatch(out, POSITIONAL);
});

test('U6 (AE1) the test touches one item: its own test id is the single locator, never a position', async () => {
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-onesie"]' });
  assert.match(out, /For this one item alone \(playwright\):\n {2}page\.locator\('\[data-test="add-to-cart-onesie"\]'\)/, out);
  assert.doesNotMatch(out, POSITIONAL);
});

test('U6 Cypress: data-* scope and name, and a test-id prefix leaf checked in every item', async () => {
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-bike-light"]', framework: 'cypress' });
  assert.match(out, /cy\.get\('\[data-test="inventory-item"\]'\)/, out);
  assert.match(out, /\.contains\('\[data-test="inventory-item-name"\]', new RegExp/);
  assert.match(out, /inventoryItem\(name\)\.find\('button\[data-test\^="add-to-cart-"\]'\)/, out);
  assert.doesNotMatch(out, /button\.btn/);
  assert.doesNotMatch(out, POSITIONAL);
});

test('U6 WebdriverIO: data-* scope, a getText name check for the attribute slot, aria leaf (its guidance)', async () => {
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-bike-light"]', framework: 'webdriverio' });
  assert.match(out, /\$\$\('\[data-test="inventory-item"\]'\)/, out);
  assert.match(out, /\(await el\.\$\('\[data-test="inventory-item-name"\]'\)\.getText\(\)\) === name/, out);
  assert.match(out, /inventoryItem\(name\)\.\$\('aria\/Add to cart'\)/);
  assert.doesNotMatch(out, POSITIONAL);
});

test('U6 a prefix that also names a sibling control is not offered (add-to- would match Buy and Save)', async () => {
  const out = await call('cor_inspect', { selector: '[data-test="add-to-basket-pen"]', framework: 'cypress' });
  assert.match(out, /\.find\('button\[data-test\^="add-to-basket-"\]'\)/, out);
  assert.doesNotMatch(out, /\^="add-to-"/);
  assert.doesNotMatch(out, POSITIONAL);
});

test('U6 no test attributes: the class scope and name stay as before', async () => {
  const out = await call('cor_inspect', { selector: '#plain .tile:nth-child(2) button' });
  assert.match(out, /page\.locator\('div\.tile'\)/, out);
  assert.doesNotMatch(out, POSITIONAL);
});
