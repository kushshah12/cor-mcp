// Scoping to a card with no heading. Found in the BrowserStack pricing
// benchmark (2026-09-25): `within` the Team card's seats button answered
// "not inside any section" — the card's name is a toggle label, not a heading
// — and the agent wrote DOM probes to read the card's price instead.
//
// Equivalent mutant, on purpose: a hidden toggle is emitted from its input
// OR from its label; for a label beside its input either path alone lists it
// once, so removing just one of them changes nothing there. The wrapped-label
// case below is what needs the label path.
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
  res.end(readFileSync(new URL('./fixtures/cards.html', import.meta.url), 'utf8'));
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
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `${base}/` });
});

const refOf = (snap, re) => re.exec(snap)?.[1];

test('a control in a heading-less card scopes to that card: its price, not the neighbour\'s', async () => {
  const snap = await call('cor_snapshot');
  const out = await call('cor_snapshot', { within: refOf(snap, /button "5 users \| \$30 per user" \[ref=(e\d+)\]/) });
  assert.doesNotMatch(out, /not inside any section/);
  assert.match(out, /card "Team" in full/, 'named by its first line, not the features heading below its controls');
  assert.match(out, /radio "Team" \[ref=e\d+\] \[checked\] \[via label\]/, 'the card\'s hidden toggles are listed with refs');
  assert.match(out, /radio "Team Pro" \[ref=e\d+\] \[via label\]/);
  assert.match(out, /checkbox "Annual billing" \[ref=e\d+\] \[via label\]/, 'a label that wraps its hidden input stands in for it');
  assert.equal((out.split('\nEntries —')[0].match(/Annual billing/g) ?? []).length, 1, 'the label text is not repeated as a text line'); // P2a: entries follow the region
  assert.match(out, /\$150/);
  assert.match(out, /Test on real devices/);
  assert.match(out, /button "Choose" \[ref=e\d+\]/);
  assert.doesNotMatch(out, /\$375|Team Ultimate/, 'the other card stays out');
});

test('the other card scopes to itself', async () => {
  const snap = await call('cor_snapshot');
  const out = await call('cor_snapshot', { within: refOf(snap, /button "5 users \| \$75 per user" \[ref=(e\d+)\]/) });
  assert.match(out, /\$375/);
  assert.doesNotMatch(out, /\$150/);
});

test('a lone control with no container and no like siblings still gets the actionable message', async () => {
  const snap = await call('cor_snapshot');
  const out = await call('cor_snapshot', { within: refOf(snap, /button "Lonely" \[ref=(e\d+)\]/) });
  assert.match(out, /not inside any section, table, list or landmark/);
});
