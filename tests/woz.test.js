// Phase 0 Wizard-of-Oz switch (framework-aware spec §5): inert unless COR_WOZ_FILE is set.
// Delete together with src/woz.js after the runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<main><div class="card"><h3>Pro</h3><button id="buy">Buy</button></div></main>');
});
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

const session = createSession({ headless: true });
after(() => session.close());

async function inspectBuy(t) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  await client.callTool({ name: 'cor_open', arguments: { url: base } });
  const r = await client.callTool({ name: 'cor_inspect', arguments: { selector: '#buy' } });
  return r.content.map((c) => c.text).join('\n');
}

const MARK = 'WOZ-HELPER-TEXT';
const woz = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'woz-')), 'woz.json');
  writeFileSync(file, JSON.stringify([{ match: "name: 'Buy'", text: MARK }, { match: 'no-such-selector', text: 'NEVER' }]));
  return file;
};

test('without COR_WOZ_FILE, cor_inspect adds nothing', async (t) => {
  delete process.env.COR_WOZ_FILE;
  const reply = await inspectBuy(t);
  assert.ok(reply.includes("name: 'Buy'"), reply);
  // Same reply as a WoZ file with no matching entry: unset is inert, byte for byte.
  const file = join(mkdtempSync(join(tmpdir(), 'woz-')), 'woz.json');
  writeFileSync(file, JSON.stringify([{ match: 'no-such-selector', text: MARK }]));
  process.env.COR_WOZ_FILE = file;
  t.after(() => delete process.env.COR_WOZ_FILE);
  assert.equal(await inspectBuy(t), reply);
});

test('with COR_WOZ_FILE, only entries whose match is in the reply are appended', async (t) => {
  process.env.COR_WOZ_FILE = woz();
  t.after(() => delete process.env.COR_WOZ_FILE);
  const reply = await inspectBuy(t);
  assert.ok(reply.endsWith(MARK), reply);
  assert.ok(!reply.includes('NEVER'));
});
