import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { expandGroups } from './helpers/outline.js';

const PAGES = {
  '/next': '<title>Next</title><button>Only</button>',
  // U5's multi-step flow: the name field exists only after Next.
  '/flow': `<title>Start</title>
    <button id="next" onclick="document.getElementById('step2').innerHTML = '<label>Your name <input id=name name=name></label>'">Next</button>
    <form id="step2" action="/done"></form>`,
};
let base;
const site = createHttpServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/done') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<title>Done</title><p>Hello ${url.searchParams.get('name')}</p>`);
  }
  let html = PAGES[url.pathname];
  try {
    html ??= readFileSync(new URL(`./fixtures${url.pathname}`, import.meta.url));
  } catch {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
const session = createSession({ headless: true });
let client;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
});
after(async () => {
  await client.close();
  await session.close();
  site.close();
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: expandGroups(result.content.map((c) => c.text).join('\n')) };
}
/** Open a page and snapshot it; `ref(pattern)` finds a ref by its outline path. */
async function fresh(page = 'acts.html') {
  await call('cor_open', { url: `${base}/${page}` });
  const snap = await call('cor_snapshot');
  const stack = [];
  const paths = [];
  for (const line of snap.text.split('\n')) {
    const m = /^( *)- (.*)$/.exec(line);
    if (!m) continue;
    stack.length = m[1].length / 2;
    stack.push(m[2]);
    if (/\[ref=e\d+\]/.test(m[2])) paths.push(stack.join(' › '));
  }
  return (pattern) => paths.find((p) => pattern.test(p))?.match(/\[ref=(e\d+)\]/)[1];
}
const inspectOk = async (ref) => !(await call('cor_inspect', { ref })).isError;

// ── U16: refs survive an act ────────────────────────────────────────────────
test('a click that only toggles a class elsewhere keeps every ref', async () => {
  const ref = await fresh();
  const draft = ref(/button "Save draft"/);
  const clicked = await call('cor_click', { target: '#highlight' });
  assert.match(clicked.text, /Refs: \d+ still valid\.$/m);
  assert.ok(await inspectOk(draft));
});

test('a removed element\'s ref is stale and says so; its twin in another row keeps its ref', async () => {
  const ref = await fresh();
  const alice = ref(/item "Alice" › button "Remove"/);
  const bob = ref(/item "Bob" › button "Remove"/);
  const removed = await call('cor_click', { ref: alice });
  assert.match(removed.text, new RegExp(`stale: ${alice} \\(was removed\\)`));
  const stale = await call('cor_inspect', { ref: alice });
  assert.match(stale.text, new RegExp(`Ref ${alice} is stale: its element was removed after an act`));
  assert.ok(await inspectOk(bob));
});

test('a re-rendered unique control is re-bound to its new node', async () => {
  const ref = await fresh();
  const draft = ref(/button "Save draft"/);
  const result = await call('cor_click', { target: '#rerender' });
  assert.match(result.text, new RegExp(`${draft} re-bound to the re-rendered element`));
  assert.match(result.text, /No visible change/, 'a re-render is not reported as a change');
  const page = await session.getPage();
  const bound = await page.evaluate((r) => window.__corMcp.element({ ref: r }) === document.querySelector('#draft button'), draft);
  assert.equal(bound, true, 'the ref names the new node');
});

test('a re-rendered control that moved position is not re-bound', async () => {
  const ref = await fresh();
  const exportRef = ref(/button "Export"/);
  const result = await call('cor_click', { target: '#move' });
  assert.match(result.text, new RegExp(`${exportRef} \\(`), 'reported stale');
  assert.equal(await inspectOk(exportRef), false);
});

test('re-rendered identical twins are never re-bound: nothing tells them apart', async () => {
  const ref = await fresh();
  const [a, b] = ['(1 of 2)', '(2 of 2)'].map((n) => ref(new RegExp(`button "Add" \\[ref=e\\d+\\] ${n.replace(/[()]/g, '\\$&')}`)));
  assert.ok(a && b);
  const result = await call('cor_click', { target: '#rerender-twins' });
  assert.match(result.text, new RegExp(`${a} \\(was replaced and now has lookalikes, so it is not guessed\\)`));
  assert.equal(await inspectOk(a), false);
});

test('a node reused for another row\'s data is not the same element', async () => {
  const ref = await fresh();
  const redHat = ref(/item "Red Hat" › button "Buy"/);
  const result = await call('cor_click', { target: '#shift' }); // "Blue Shirt" moves into Red Hat's node
  assert.match(result.text, new RegExp(`${redHat} \\(changed what it shows or where it sits\\)`));
  assert.equal(await inspectOk(redHat), false, 'the ref does not follow the node to Blue Shirt');
});

test('a URL change in place (pushState) is not a navigation: refs survive', async () => {
  const ref = await fresh();
  const draft = ref(/button "Save draft"/);
  const result = await call('cor_click', { target: '#tab' });
  assert.match(result.text, /\?tab=2/);
  assert.doesNotMatch(result.text, /The page navigated/);
  assert.ok(await inspectOk(draft));
});

test('navigation still expires every ref', async () => {
  const ref = await fresh();
  const draft = ref(/button "Save draft"/);
  const result = await call('cor_click', { target: '#away' });
  assert.match(result.text, /The page navigated\. (?:Headings on the new page|Earlier refs expired — call cor_snapshot\.)/);
  assert.match((await call('cor_inspect', { ref: draft })).text, /stale: the page navigated/);
});

// ── U17: what changed ───────────────────────────────────────────────────────
test('opening a dialog reports it with refs usable at once; closing reports what left', async () => {
  await fresh();
  const opened = await call('cor_click', { target: '#checkout' });
  const line = opened.text.split('\n').find((l) => l.startsWith('+ dialog "Checkout"'));
  assert.match(line, /^\+ dialog "Checkout": textbox "Email" \[ref=(e\d+)\], button "Pay" \[ref=(e\d+)\]$/);
  const [, email, pay] = line.match(/\[ref=(e\d+)\].*\[ref=(e\d+)\]/);
  assert.ok(await inspectOk(email), 'a ref from the act response works without a snapshot');

  const closed = await call('cor_click', { ref: pay });
  // U21: several removed controls are one line.
  assert.match(closed.text, /^- gone \(2\): textbox "Email", button "Pay"$/m);
});

test('a state change is reported; a no-op says nothing visibly changed', async () => {
  await fresh();
  assert.match((await call('cor_click', { target: '#agree' })).text, /^~ checkbox "Agree": now checked$/m);
  assert.match((await call('cor_click', { target: '#noop' })).text, /^No visible change\. If you expected one, the act may not have landed/m);
});

test('a control appearing in an existing section is reported as itself, not as a new section', async () => {
  await fresh();
  const result = await call('cor_click', { target: '#addnote' });
  assert.match(result.text, /^\+ button "Undo" \[ref=e\d+\]$/m);
});

test('a flood of changes is capped', async () => {
  await fresh();
  const flood = await call('cor_click', { target: '#flood' });
  assert.equal(flood.text.split('\n').filter((l) => /^[+~-] /.test(l)).length, 15);
  assert.match(flood.text, /…and 5 more changes — cor_snapshot for the whole page\./);
});

test('verification: the U5 multi-step flow needs no snapshot between steps', async () => {
  await call('cor_open', { url: `${base}/flow` });
  const next = await call('cor_click', { target: '#next' }); // no snapshot taken at all
  const name = next.text.match(/^\+ .*textbox "Your name" \[ref=(e\d+)\]/m)?.[1];
  assert.ok(name, next.text);
  const filled = await call('cor_fill', { ref: name, value: 'Ada' });
  assert.equal(filled.isError, false);
  const submitted = await call('cor_press', { key: 'Enter', ref: name });
  assert.match(submitted.text, /\/done\?name=Ada — "Done"/);
  assert.match(submitted.text, /The page navigated/);
});
