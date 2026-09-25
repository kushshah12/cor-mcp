import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createFingerprintStore, FORMAT_VERSION, RETENTION_DAYS, redactText } from '../src/fingerprints.js';
import { expandGroups } from './helpers/outline.js';

const COOKIE = 'SEKRET-COOKIE-9f8e7d6c5b4a39281706';
const TOKEN = 'abcDEF1234567890abcdef12345';
const ENGINE_SRC = fileURLToPath(new URL('../../../../cor-locator-engine/src/', import.meta.url));

// An authenticated page carrying the data a silent capture must not keep.
const ACCOUNT = `<!doctype html><title>Account</title>
  <a href="/orders/123?token=${TOKEN}#details" aria-label="Orders for jane.doe@example.com">Order 4815162342 for Jane</a>
  <button title="Pay" class="btn user-99887766">Pay now</button>
  <input name="email" placeholder="you@example.com" value="typed@secret.com">`;

let base;
const site = createHttpServer((req, res) => {
  if (req.url.startsWith('/engine/')) {
    // The real engine source, so the test heals with the real healLocator().
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(readFileSync(join(ENGINE_SRC, req.url.slice('/engine/'.length))));
  }
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

const tempDir = () => mkdtempSync(join(tmpdir(), 'cor-fp-'));
const readRecords = (dir) => JSON.parse(readFileSync(join(dir, '.cor', 'fingerprints.json'), 'utf8'));

async function connect(t, fingerprints) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, fingerprints });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return expandGroups(result.content.map((c) => c.text).join('\n'));
  };
  await call('cor_open', { url: `${base}/account`, storageState: statePath });
  return call;
}

test('AE3: an inspected element is recorded with a format version and retrievable by its locator', async (t) => {
  const dir = tempDir();
  const store = createFingerprintStore({ dir });
  const call = await connect(t, store);
  const out = await call('cor_inspect', { selector: 'button', framework: 'cypress' });
  const { version, records } = readRecords(dir);
  assert.equal(version, FORMAT_VERSION);
  assert.equal(records.length, 1);
  assert.equal(records[0].v, FORMAT_VERSION);
  assert.equal(records[0].page, `${base}/account`);
  const code = out.split('\n')[1].trim(); // cy.get('…')
  const value = records[0].locators.find((l) => code.includes(l));
  assert.ok(value, `the recommended locator is among the record's keys: ${records[0].locators}`);
  assert.deepEqual(store.lookup(`${base}/account?tab=2`, value), records, 'lookup ignores the query string');
});

test('the stored snapshot heals through healLocator() with no transformation', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ dir }));
  await call('cor_inspect', { selector: 'button' });
  const { fingerprint } = readRecords(dir).records[0];

  const page = await session.getPage();
  // The page changes the way pages do: the class the test relied on is renamed.
  await page.evaluate(() => { document.querySelector('button').className = 'button-primary'; });
  const healed = await page.evaluate(async (stored) => {
    const { healLocator } = await import('/engine/engine/healer.js');
    const result = healLocator('.btn', stored);
    return { same: result.element === document.querySelector('button'), similarity: result.similarity };
  }, fingerprint);
  // `healed` additionally needs a generateLocators() to write the new string;
  // what the record must do is let healLocator find the same element.
  assert.equal(healed.same, true, 'the stored snapshot finds the same element');
  assert.ok(healed.similarity >= 0.4, `similarity ${healed.similarity} clears healLocator's default threshold`);
});

test('the ignore entry is created when absent and never duplicated', async (t) => {
  const fresh = tempDir();
  const store = createFingerprintStore({ dir: fresh });
  const call = await connect(t, store);
  await call('cor_inspect', { selector: 'button' });
  await call('cor_inspect', { selector: 'a' });
  assert.equal(readFileSync(join(fresh, '.cor', '.gitignore'), 'utf8'), 'fingerprints.json\n');

  // An existing .cor/.gitignore (no trailing newline) is appended to, once.
  const existing = tempDir();
  mkdirSync(join(existing, '.cor'));
  writeFileSync(join(existing, '.cor', '.gitignore'), 'telemetry-pending.json');
  const other = createFingerprintStore({ dir: existing });
  const record = (n) => other.record({ url: `${base}/x`, elementKey: `k${n}`, fingerprint: { tag: 'a', attrs: {}, text: null, classes: [] }, locators: ['a'] });
  record(1);
  record(2);
  assert.equal(readFileSync(join(existing, '.cor', '.gitignore'), 'utf8'), 'telemetry-pending.json\nfingerprints.json\n');
});

test('inspecting the same element twice keeps one record and a valid file', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ dir }));
  await call('cor_inspect', { selector: 'button', framework: 'cypress' });
  await call('cor_inspect', { selector: 'button', framework: 'playwright' });
  await call('cor_inspect', { selector: 'a' });
  const { records } = readRecords(dir);
  assert.equal(records.length, 2, 'one per element, whatever the framework');
  assert.ok(records.every((r) => r.firstSeen <= r.lastSeen));
});

test('only the fingerprint fields are stored, with emails, long numbers, tokens and URL queries masked', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ dir }));
  for (const selector of ['a', 'button', 'input']) await call('cor_inspect', { selector });
  const { records } = readRecords(dir);
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
  const file = readFileSync(join(dir, '.cor', 'fingerprints.json'), 'utf8');
  for (const secret of ['typed@secret.com', 'jane.doe@example.com', '4815162342', TOKEN, 'token=']) {
    assert.ok(!file.includes(secret), `${secret} leaked into the file`);
  }
});

test('no cookie or token value reaches a record or a tool response', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ dir }));
  const responses = [];
  responses.push(await call('cor_snapshot'));
  for (const selector of ['a', 'button', 'input']) responses.push(await call('cor_inspect', { selector }));
  const file = readFileSync(join(dir, '.cor', 'fingerprints.json'), 'utf8');
  // The adopted storage state's cookie appears nowhere.
  assert.ok(!file.includes(COOKIE) && !responses.join('\n').includes(COOKIE));
  // A token in the page's own href is page content the agent sees anyway —
  // but it must not be written to disk, in the fingerprint or a stored locator.
  assert.ok(!file.includes(TOKEN), 'token written to the fingerprint file');
  assert.ok(!file.includes('jane.doe@example.com'));
  // …and a locator carrying them is still found by its original, unmasked text.
  const store = createFingerprintStore({ dir });
  assert.equal(store.lookup(`${base}/account`, `a[aria-label="Orders for jane.doe@example.com"]`).length, 1);
  assert.equal(store.lookup(`${base}/account`, `a[href="/orders/123?token=${TOKEN}#details"]`).length, 1);
});

test('a write failure (read-only directory) does not fail the inspect', async (t) => {
  const dir = tempDir();
  chmodSync(dir, 0o555);
  t.after(() => chmodSync(dir, 0o755));
  const call = await connect(t, createFingerprintStore({ dir }));
  const out = await call('cor_inspect', { selector: 'button' });
  assert.match(out, /^Best locator/);
  assert.equal(existsSync(join(dir, '.cor')), false);
});

test('records unseen for the retention period are pruned on the next write', () => {
  const dir = tempDir();
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = createFingerprintStore({ dir, now: () => now });
  const fp = { tag: 'a', attrs: {}, text: null, classes: [] };
  store.record({ url: `${base}/old`, elementKey: 'old', fingerprint: fp, locators: ['a'] });
  now += (RETENTION_DAYS + 1) * 86_400_000;
  store.record({ url: `${base}/new`, elementKey: 'new', fingerprint: fp, locators: ['a'] });
  assert.deepEqual(readRecords(dir).records.map((r) => r.elementKey), ['new']);
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

test('verification: through the bin, one record per element, nothing on stderr, identical responses; disabled writes nothing', async (t) => {
  const on = tempDir();
  const withCapture = await runBin(t, { cwd: on });
  assert.equal(withCapture.stderr, '', 'capture is silent');
  assert.equal(readRecords(on).records.length, 3, 'four inspects of three elements');

  const flagged = tempDir();
  const withFlag = await runBin(t, { cwd: flagged, args: ['--no-fingerprints'] });
  assert.equal(existsSync(join(flagged, '.cor')), false, '--no-fingerprints writes no file at all');
  assert.deepEqual(withFlag.texts, withCapture.texts, 'tool responses are identical with capture on or off');
  assert.equal(withFlag.stderr, '');

  const env = tempDir();
  await runBin(t, { cwd: env, env: { COR_FINGERPRINTS: 'off' } });
  assert.equal(existsSync(join(env, '.cor')), false, 'COR_FINGERPRINTS=off writes no file');
});
