// U2: a click that reveals controls answers with their entries in the same reply, so the next step needs no snapshot.
// The reply already carried entries for what an act showed (P2a); these tests pin that for a toggle that reveals controls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

const PLANS = (n) => Array.from({ length: n }, (_, i) => `<button class="choose">Choose ${['Team', 'Pro', 'Enterprise', 'Scale', 'Custom', 'Trial'][i]}</button>`).join('');
const PAGES = {
  '/three': `<title>Plans</title><h1>Plans</h1><button id="monthly" onclick="show()">Monthly</button>
    <div id="prices" hidden>${PLANS(3)}</div>
    <script>function show() { document.getElementById('prices').hidden = false; }</script>`,
  '/six': `<title>Plans</title><h1>Plans</h1><button id="monthly" onclick="show()">Monthly</button>
    <div id="prices" hidden>${PLANS(6)}</div>
    <script>function show() { document.getElementById('prices').hidden = false; }</script>`,
};

const site = createHttpServer((req, res) => {
  const body = PAGES[req.url.split('?')[0]];
  if (body === undefined) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
const session = createSession({ headless: true });
let base;
let call;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
});

after(() => {
  site.closeAllConnections?.();
  site.close();
  return session.close();
});

const refFor = (text, label) => {
  const line = text.split('\n').find((l) => l.includes(`"${label}"`) && /\[ref=e\d+\]/.test(l));
  assert.ok(line, `no outline line for "${label}"`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

test('U2: a click that reveals three controls answers with their entries in the same reply', async () => {
  const { text } = await call('cor_open', { url: `${base}/three` });
  const r = await call('cor_click', { ref: refFor(text, 'Monthly') });
  assert.equal(r.isError, false, r.text);
  for (const name of ['Choose Team', 'Choose Pro', 'Choose Enterprise']) assert.match(r.text, new RegExp(`"${name}"`), name);
  assert.match(r.text, /COR cor:/, 'entries are in the reply, so no cor_snapshot or cor_inspect is needed next');
});

test('U2: when more than four controls appear, four entries are given and the rest are counted with their refs', async () => {
  const { text } = await call('cor_open', { url: `${base}/six` });
  const r = await call('cor_click', { ref: refFor(text, 'Monthly') });
  assert.equal(r.isError, false, r.text);
  assert.equal((r.text.match(/COR cor:/g) ?? []).length, 4, 'four entries at most');
  assert.match(r.text, /\[ref=e\d+\]/, 'the rest keep their refs');
});

test('U2: a click on a selector that matches several elements says to pass the ref, not to narrow blindly', async () => {
  await call('cor_open', { url: `${base}/six` });
  const r = await call('cor_click', { target: '.choose' });
  assert.equal(r.isError, true);
  assert.match(r.text, /matches 6 elements — pass the ref of the one you mean \(from cor_snapshot\)/);
});

test('U2: a click with neither ref nor target names the parameter, so a selector argument is not guessed', async () => {
  const r = await call('cor_click', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /the parameter is named target, not selector/);
});
