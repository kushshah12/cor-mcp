// Found in an agent run on bstackdemo.com (2026-09-25): the cart badge's
// locator matched nothing once the cart opened, because the header badge is
// removed then. COR now says the element is state-bound and names the twin.
// Also: a fixed drawer is a region; a number-named clickable shows its class;
// the durable line reads as English.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { durableLine } from '../src/format.js';
import { expandGroups } from './helpers/outline.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/cart.html', import.meta.url), 'utf8'));
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
  call = async (name, args = {}) => expandGroups((await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n'));
  await call('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

/** The twin locator from a State-bound note, as Playwright code. */
const twinCode = (out) => /The same value is also shown by an element with no state class: (.+?) {3}\(/.exec(out)?.[1];

test('the header badge is state-bound, and the twin it names is the float cart badge', async () => {
  const out = await call('cor_inspect', { selector: 'header .bag' });
  assert.match(out, /State-bound: this element carries the state class "bag--float-cart-closed"/);
  const code = twinCode(out);
  assert.ok(code, out);
  const twin = new Function('page', `return ${code};`)(page);
  assert.equal(await twin.count(), 1);
  assert.equal(await twin.evaluate((el) => Boolean(el.closest('.float-cart'))), true);
});

test('the badge count inside it is state-bound through its ancestor', async () => {
  const out = await call('cor_inspect', { selector: 'header .bag__quantity' });
  assert.match(out, /State-bound: .*"bag--float-cart-closed"/);
  const twin = new Function('page', `return ${twinCode(out)};`)(page);
  assert.equal(await twin.evaluate((el) => el.matches('.float-cart .bag__quantity')), true);
});

test('the twin itself, and a state class with no twin, get no note', async () => {
  assert.doesNotMatch(await call('cor_inspect', { selector: '.float-cart .bag' }), /State-bound/);
  assert.doesNotMatch(await call('cor_inspect', { selector: 'li.active a' }), /State-bound/);
});

test('a twin that is itself state-bound is not offered', async () => {
  assert.doesNotMatch(await call('cor_inspect', { selector: '.menu .count' }), /State-bound/);
});

test('a fixed-position drawer is a region for a scoped snapshot', async () => {
  const snap = await call('cor_snapshot');
  const ref = /button "Checkout" \[ref=(e\d+)\]/.exec(snap)[1];
  const out = await call('cor_snapshot', { within: ref });
  assert.doesNotMatch(out, /not inside any section/);
  assert.match(out, /Checkout/);
  assert.match(out, /Cart/);
  assert.doesNotMatch(out, /Home|Shop/);
});

test('a clickable named only by a number shows its class', async () => {
  const snap = await call('cor_snapshot');
  assert.match(snap, /clickable "0" \(\.bag\) \[ref=e\d+\]/);
  assert.match(snap, /clickable "X" \[ref=/); // a letter is a name: no hint
});

test('the durable line reads as English whatever the anchor signal says', () => {
  const locator = (message) => ({ value: 'x', code: 'x', strategy: 'css', score: 60, signals: [{ id: 'a', direction: 'positive', message, points: 5 }], primaryRisk: null });
  const line = (message) => durableLine({ framework: 'playwright', locators: [locator(message)] });
  assert.match(line('Scoped under a stable ancestor anchor — survives layout changes'), /^\/\/ COR: scoped under a stable ancestor anchor; /);
  assert.match(line('Anchored on a test attribute'), /^\/\/ COR: anchored on a test attribute; /);
  assert.doesNotMatch(line('Scoped under a stable ancestor anchor'), /anchored on Scoped/);
});
