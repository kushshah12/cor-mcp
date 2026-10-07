// P6 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md): quality work that saves no turns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p6-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIRS = [new URL('./fixtures/', import.meta.url), new URL('../scripts/conformance/fixtures/', import.meta.url)];
const site = createHttpServer((req, res) => {
  for (const dir of DIRS) {
    let body;
    try { body = readFileSync(new URL(`${req.url.slice(1).split('?')[0]}.html`, dir)); } catch { continue; }
    return res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  }
  res.writeHead(404).end();
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

export async function connect(t, dep = '@playwright/test', { records = false } = {}) {
  const dir = join(root, Math.random().toString(16).slice(2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { [dep]: '9' } }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: records ? createRecordStore({ root: () => session.root }) : null });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
  return { dir, call };
}

test('P6 (R8) a control whose name an act changed says so: both names, and that a name locator holds in one state only', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p6-cart` });
  assert.doesNotMatch(await call('cor_inspect', { selector: 'a.cart', detail: true }), /name changes/, 'not before the change is seen');
  await call('cor_click', { target: '[data-test=add]' });
  const after = await call('cor_inspect', { selector: 'a.cart', detail: true });
  assert.match(after, /its name changes with the page state \("Cart, empty" → "Cart, 1 item"\) — this locator holds in one state only/);
});

test('P6 template heal: a working item template is "Healthy" for every item; after a release breaks it, the proposal is checked against every recorded item', async (t) => {
  const { call } = await connect(t, '@playwright/test', { records: true });
  await call('cor_open', { url: `${base}/p6-cards` });
  const reply = await call('cor_inspect', { selector: '.card:nth-child(2) .price' });
  const id = /cor:([0-9a-f]{6})/.exec(reply)[1];
  assert.match(reply, /\(title\)|\(name\)|\(plan\)|__/, 'an item template');
  const lines = reply.split('\n');
  const at = lines.findIndex((l) => l.includes(`// COR cor:${id}`));
  const line = `${lines[at].trim()}\n${lines[at + 1].trim()}`; // the entry's member line, as placed
  assert.match(await call('cor_heal', { locator: line }), /Healthy — cor:\w+'s template still finds every recorded item \(3\)/);
  await call('cor_open', { url: `${base}/p6-cards?release=2` });
  const healed = await call('cor_heal', { id });
  assert.match(healed, /The proposed template finds every recorded item \(3: "Basic", "Pro", "Team"\)\./);
  assert.match(healed, /div\.plan/, 'the new card class');
});

test('P6 two COR sessions writing .cor/ids.json at once lose nothing (a lock); a crashed session\'s stale lock is taken over', async () => {
  const { spawn } = await import('node:child_process');
  const { utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(root, 'ids-'));
  const script = (tag) => `import { createRecordStore } from ${JSON.stringify(new URL('../src/records.js', import.meta.url).href)};
const s = createRecordStore({ root: () => ${JSON.stringify(dir)} });
for (let i = 0; i < 60; i++) s.link('pages/${tag}.json#k' + i, 'abc' + String(i).padStart(3, '0'));
if (s.lastError) { console.error(s.lastError); process.exit(1); }`;
  const run = (tag) => new Promise((ok, no) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script(tag)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code ? no(new Error(err)) : ok()));
  });
  await Promise.all([run('a'), run('b'), run('c')]);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, '.cor/ids.json'), 'utf8'))).length, 180, 'every id from all three sessions');
  mkdirSync(join(dir, '.cor/ids.json.lock'));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, '.cor/ids.json.lock'), old, old);
  const { createRecordStore } = await import('../src/records.js');
  const store = createRecordStore({ root: () => dir });
  store.link('pages/d.json#k', 'abcdef');
  assert.equal(store.lastError, null);
  assert.equal(JSON.parse(readFileSync(join(dir, '.cor/ids.json'), 'utf8'))['pages/d.json#k'], 'abcdef');
});
