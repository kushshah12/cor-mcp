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

test('an entry matches the element\'s template data, in any framework mode, and takes a list of alternatives', async (t) => {
  const { wozNotes } = await import('../src/woz.js');
  const file = join(mkdtempSync(join(tmpdir(), 'woz-')), 'woz.json');
  writeFileSync(file, JSON.stringify([{ match: ['nope', 'div.card'], text: 'CARD' }, { match: 'nope', text: 'NEVER' }]));
  process.env.COR_WOZ_FILE = file;
  t.after(() => delete process.env.COR_WOZ_FILE);
  assert.equal(wozNotes('await $("#x")', { item: 'div.card' }), '\n\nCARD');
  assert.equal(wozNotes('await $("#x")', null), '');
});

test('the framework comes from the argument, else the project package.json', async () => {
  const { wozFramework } = await import('../src/woz.js');
  const project = (deps) => {
    const dir = mkdtempSync(join(tmpdir(), 'woz-proj-'));
    if (deps) writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: deps }));
    return dir;
  };
  assert.equal(wozFramework('cypress', project({ '@wdio/cli': '9' })), 'cypress');
  assert.equal(wozFramework('playwright', project({ '@wdio/cli': '9' })), 'webdriverio');
  assert.equal(wozFramework(undefined, project({ webdriverio: '9' })), 'webdriverio');
  assert.equal(wozFramework('playwright', project({ cypress: '16' })), 'cypress');
  assert.equal(wozFramework('playwright', project({ '@playwright/test': '1' })), null);
  assert.equal(wozFramework('playwright', project(null)), null);
});

test('with no COR_WOZ_FILE, the helpers shipped for the framework are used', async () => {
  const { wozNotes } = await import('../src/woz.js');
  delete process.env.COR_WOZ_FILE;
  const params = { item: 'div[data-plan-type="teams"] div.simplification-card' };
  assert.match(wozNotes('', params, 'webdriverio'), /WebdriverIO \(8 and 9\) helper/);
  assert.match(wozNotes('', params, 'cypress'), /Cypress \(15 and 16\) helper/);
  assert.equal(wozNotes('', { item: 'div.other' }, 'webdriverio'), '');
});
