// Review (2026-10-05): the old ~/.cor/fingerprints store is retired — entry records in <project>/.cor/records/ (U8)
// carry the fingerprint now. These are its privacy and capture guarantees, kept for the records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { redactText } from '../src/redact.js';
import { createRecordStore } from '../src/records.js';
import { expandGroups } from './helpers/outline.js';

const COOKIE = 'SEKRET-COOKIE-9f8e7d6c5b4a39281706';
const TOKEN = 'abcDEF1234567890abcdef12345';

// An authenticated page carrying the data a silent capture must not keep.
const ACCOUNT = `<!doctype html><title>Account</title>
  <a href="/orders/123?token=${TOKEN}#details" aria-label="Orders for jane.doe@example.com">Order 4815162342 for Jane</a>
  <button title="Pay" class="btn user-99887766">Pay now</button>
  <input name="email" placeholder="you@example.com" value="typed@secret.com">`;

let base;
const site = createHttpServer((req, res) => {
  if (req.url === '/account' && (req.headers.cookie ?? '').includes(COOKIE)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(ACCOUNT);
  }
  res.writeHead(req.url === '/account' ? 403 : 404);
  res.end();
});
const session = createSession({ headless: true });
let statePath;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  statePath = join(mkdtempSync(join(tmpdir(), 'cor-state-')), 'state.json');
  writeFileSync(statePath, JSON.stringify({
    cookies: [{ name: 'sid', value: COOKIE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
});
after(async () => {
  await session.close();
  site.close();
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'cor-rec-'));
// P8a: an entry is pending until cor_check finds its id in code; both folders hold records
const jsonIn = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)); } catch { return []; } };
const recordsIn = (dir) => ['records', 'pending'].flatMap((d) => jsonIn(join(dir, '.cor', d))).map((f) => JSON.parse(readFileSync(f, 'utf8')));

async function connect(t, records) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return expandGroups(result.content.map((c) => c.text).join('\n'));
  };
  await call('cor_open', { url: `${base}/account`, storageState: statePath });
  return call;
}

test('records hold only the fingerprint fields, with emails, long numbers, tokens and URL queries masked', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createRecordStore({ root: () => dir }));
  for (const selector of ['a', 'button', 'input']) await call('cor_inspect', { selector });
  const records = recordsIn(dir);
  const allowed = new Set(['aria-label', 'aria-labelledby', 'name', 'placeholder', 'type', 'role', 'title', 'alt', 'href', 'for']);
  for (const { fingerprint } of records) {
    assert.deepEqual(Object.keys(fingerprint).sort(), ['attrs', 'classes', 'tag', 'text']);
    for (const name of Object.keys(fingerprint.attrs)) assert.ok(allowed.has(name), name);
  }
  const byTag = Object.fromEntries(records.map((r) => [r.fingerprint.tag, r.fingerprint]));
  assert.deepEqual(byTag.a.attrs, { 'aria-label': 'Orders for [email]', href: '/orders/123' });
  assert.equal(byTag.a.text, 'Order [number] for Jane');
  assert.deepEqual(byTag.button.classes, ['btn', 'user-[number]']);
  assert.equal(byTag.input.attrs.placeholder, '[email]');
  const files = records.map((r) => JSON.stringify(r)).join('\n');
  for (const secret of ['typed@secret.com', 'jane.doe@example.com', '4815162342', TOKEN, 'token=']) {
    assert.ok(!files.includes(secret), `${secret} leaked into a record`);
  }
});

test('no cookie value reaches a record or a tool response', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createRecordStore({ root: () => dir }));
  const responses = [await call('cor_snapshot')];
  for (const selector of ['a', 'button', 'input']) responses.push(await call('cor_inspect', { selector }));
  const files = recordsIn(dir).map((r) => JSON.stringify(r)).join('\n');
  assert.ok(!files.includes(COOKIE) && !responses.join('\n').includes(COOKIE));
});

test('redaction keeps ordinary text and short numbers', () => {
  assert.equal(redactText('Step 2 of 3'), 'Step 2 of 3');
  assert.equal(redactText('Call 555-123-4567'), 'Call [number]');
  assert.equal(redactText('Qty 12'), 'Qty 12');
  assert.equal(redactText('Hi a@b.co'), 'Hi [email]');
});

// ── through the real bin: flags, env, stdout/stderr ─────────────────────────
async function runBin(t, { cwd, args = [], env = {} }) {
  const bin = fileURLToPath(new URL('../bin/cor-mcp.js', import.meta.url));
  const child = spawn(process.execPath, [bin, '--headless', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  let id = 0;
  const request = async (method, params) => {
    const n = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    for (let i = 0; i < 200; i++) {
      const line = out.split('\n').find((l) => l.includes(`"id":${n}`));
      if (line) return JSON.parse(line).result;
      await sleep(50);
    }
    throw new Error(`no response to ${method}`);
  };
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tool = async (name, args) => (await request('tools/call', { name, arguments: args })).content.map((c) => c.text).join('\n');
  await tool('cor_open', { url: `${base}/account`, storageState: statePath });
  const texts = [];
  for (const selector of ['a', 'button', 'input', 'button']) texts.push(await tool('cor_inspect', { selector }));
  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));
  return { texts, stderr: err };
}

test('through the bin: one record per element, nothing on stderr, nothing outside .cor/; --no-records and COR_RECORDS=off write nothing', async (t) => {
  const on = tempDir();
  const withCapture = await runBin(t, { cwd: on });
  assert.equal(withCapture.stderr, '', 'capture is silent');
  assert.deepEqual(readdirSync(on), ['.cor'], 'only .cor/ inside the working folder');
  assert.equal(recordsIn(on).length, 3, 'four inspects of three elements: one record each');

  const noId = (texts) => texts.map((s) => s.replace(/cor:[0-9a-f]{6}/g, 'cor:{id}'));
  for (const [args, env] of [[['--no-records'], {}], [['--no-fingerprints'], {}], [[], { COR_RECORDS: 'off' }], [[], { COR_FINGERPRINTS: 'off' }]]) {
    const off = tempDir();
    const run = await runBin(t, { cwd: off, args, env });
    assert.equal(existsSync(join(off, '.cor')), false, `${args.join(' ') || JSON.stringify(env)} writes nothing`);
    assert.deepEqual(noId(run.texts), noId(withCapture.texts), 'responses are identical with capture on or off, ids aside');
  }
});
