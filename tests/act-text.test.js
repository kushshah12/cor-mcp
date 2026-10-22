// U20 — act responses report text, not only controls. In the plain-prompt
// BrowserStack run the COR agent wrote 13.6k characters of DOM probes to read
// what an action changed: the price after switching to Monthly, an FAQ answer,
// the checkout page. cor_click reported only controls, so none of it showed.
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
  if (req.url === '/checkout') return res.end('<title>Checkout</title><h1>Checkout</h1><h2>Order summary</h2><p>You have selected the Team Ultimate plan.</p>');
  res.end(readFileSync(new URL('./fixtures/act-text.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let raw;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  raw = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
});

const fresh = async () => {
  await raw('cor_open', { url: `${base}/` });
  return raw('cor_snapshot');
};
const refFor = (snap, pattern) => {
  const line = snap.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `${pattern} not in\n${snap}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

test('a text that changed is reported with its old and new value, a ref, and where it is', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /radio "Monthly"/) });
  assert.match(out, /^~ "375" → "445" \[ref=e\d+\] in section "Team Ultimate"$/m, out);
});

test('the ref of a changed text can be inspected: the agent gets the price locator without a script', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /radio "Monthly"/) });
  const ref = /"445" \[ref=(e\d+)\]/.exec(out)[1];
  const inspected = await raw('cor_inspect', { ref });
  assert.match(inspected, /price/, inspected);
});

test('text that appears (an FAQ answer opening) is reported', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /What payment methods/) });
  assert.match(out, /^\+ "We accept all major credit cards and PayPal\." \[ref=e\d+\] in section "FAQ"$/m, out);
});

test('a re-render that shows the same text reports nothing, and a click that changes nothing still says so', async () => {
  const snap = await fresh();
  const rerender = await raw('cor_click', { ref: refFor(snap, /button "Refresh list"/) });
  assert.doesNotMatch(rerender, /"Alpha"|"Beta"/, rerender);
  const noop = await raw('cor_click', { ref: refFor(snap, /button "Nothing"/) });
  assert.match(noop, /No visible change/);
});

test('a navigation names the new page by its headings', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /link "Choose"/) });
  assert.match(out, /The page navigated\. Headings on the new page[^\n]*\n\s+h\d "Checkout" \[ref=e\d+\]\n\s+h\d "Order summary" \[ref=e\d+\]/, out);
});

test('the instructions tell the agent to read what an act changed instead of writing scripts', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'i', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
  assert.match(client.getInstructions(), /To see what an action changes, act \(cor_click, cor_fill, cor_press; many steps: cor_explore\) and read the reply/); // P4 wording; P2b adds cor_explore
});

test('a control whose own text changes is reported once, as a control — not again as text', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /button "Follow"/) });
  assert.match(out, /~ button "Following": "Follow" → "Following"/, out);
  assert.doesNotMatch(out, /^Text:/m, out);
});

test('many new lines are capped, with a count of the rest', async () => {
  const snap = await fresh();
  const out = await raw('cor_click', { ref: refFor(snap, /button "Show all features"/) });
  // U21: more new lines than the cap are summed up, with examples and refs.
  assert.match(out, /^\+ 12 new lines, e\.g\. "Feature 1" \[ref=e\d+\], "Feature 2" \[ref=e\d+\], "Feature 3" \[ref=e\d+\]$/m, out);
  assert.doesNotMatch(out, /^\+ "Feature 4"/m);
});
