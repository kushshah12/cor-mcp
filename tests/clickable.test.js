// Script-handled click targets with no role (cursor: pointer) are controls:
// listed in the snapshot, inspectable, actable, diffed, parameterised.
// Found on bstackdemo.com (2026-09-25): "Add to cart" is a <div>, and COR's
// snapshot never listed it while Playwright MCP's did.
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
  res.end(readFileSync(new URL('./fixtures/clickable.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let call;
// One hook: node:test does not wait for one root-level before() to finish before starting the next.
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => expandGroups((await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n'));
});

const open = () => call('cor_open', { url: `${base}/` });
const lines = (snap, re) => snap.split("\n").filter((l) => l.includes("[ref=") && re.test(l));
const refIn = (line) => /\[ref=(e\d+)\]/.exec(line)[1];

test('a script-handled <div> with cursor: pointer is listed as clickable, under its card', async () => {
  await open();
  const snap = await call('cor_snapshot');
  const buys = lines(snap, /clickable "Add to cart"/);
  assert.equal(buys.length, 3, snap);
  assert.match(buys.join('\n'), /Phone 12 Mini/);
});

test('inherited pointer is one target; an aria-label names an empty icon', async () => {
  await open();
  const snap = await call('cor_snapshot');
  assert.equal(lines(snap, /clickable "Check out"/).length, 1, snap);
  assert.equal(lines(snap, /"Check"|"out"/).length, 0, snap);
  assert.equal(lines(snap, /clickable "Close banner"/).length, 1, snap);
});

test('real controls stay listed once by role; containers, labels and long panels are not clickables', async () => {
  await open();
  const snap = await call('cor_snapshot');
  assert.equal(lines(snap, /button "Real button"/).length, 1);
  assert.equal(lines(snap, /link "Docs"/).length, 1);
  assert.equal(lines(snap, /button "Claim"/).length, 1);
  assert.equal(lines(snap, /button "Inner"/).length, 1);
  assert.equal(lines(snap, /clickable/).length, 5, snap); // 3 × Add to cart, Check out, Close banner
  assert.doesNotMatch(snap, /clickable "(Promo|Remember|Docs|Inner|This whole panel)/);
});

test('a clickable ref inspects, with the lookalike guard and a parameterised template', async () => {
  await open();
  const snap = await call('cor_snapshot');
  const ref = refIn(lines(snap, /clickable "Add to cart"/)[1]);
  const out = await call('cor_inspect', { ref });
  assert.match(out, /The 2 lookalike clickable "Add to cart" elements are the other items — pass their title instead/);
  assert.match(out, /title = "Phone 12 Mini"/);
  assert.match(out, /getByText\('Add to cart', \{ exact: true \}\)/);
});

test('clicking a clickable ref acts, and the diff reports what appeared', async () => {
  await open();
  const snap = await call('cor_snapshot');
  const ref = refIn(lines(snap, /clickable "Add to cart"/)[2]);
  const out = await call('cor_click', { ref });
  assert.match(out, /\+ clickable "Remove Pixel 4"/);
});
