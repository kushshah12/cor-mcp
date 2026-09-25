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
import { createFingerprintStore, FORMAT_VERSION, RETENTION_DAYS, redactText, storeFileFor } from '../src/fingerprints.js';
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
// The store lives under the user's home, outside the project; tests use their own.
const HOME = tempDir();
const readRecords = (dir, home = HOME) => JSON.parse(readFileSync(storeFileFor(dir, home), 'utf8'));

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
  const store = createFingerprintStore({ home: HOME, dir });
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
  const call = await connect(t, createFingerprintStore({ home: HOME, dir }));
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

test('the store lives outside the project: nothing is written in the working folder', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ home: HOME, dir }));
  await call('cor_inspect', { selector: 'button' });
  assert.deepEqual(readdirSync(dir), [], 'the project folder is untouched');
  assert.equal(readRecords(dir).records.length, 1);
  assert.equal(readRecords(dir).folder, realpathSync(dir));
  // Two folders with the same name never share a file.
  const a = join(tempDir(), 'tests');
  const b = join(tempDir(), 'tests');
  assert.notEqual(storeFileFor(a, HOME), storeFileFor(b, HOME));
  assert.match(storeFileFor(a, HOME), /[/\\]\.cor[/\\]fingerprints[/\\]tests-[0-9a-f]{6}\.json$/);
});

test('a store an earlier version left in <folder>/.cor/ is moved once, and its .cor/ removed only if it was ours', () => {
  const fp = { tag: 'a', attrs: {}, text: null, classes: [] };
  const legacyRecord = { v: 1, page: `${base}/old`, elementKey: 'legacy', fingerprint: fp, locators: ['a.old'], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() };
  const seed = (dir, extra = {}, ignore = 'fingerprints.json\n') => {
    mkdirSync(join(dir, '.cor'));
    writeFileSync(join(dir, '.cor', 'fingerprints.json'), JSON.stringify({ version: 1, records: [legacyRecord] }));
    writeFileSync(join(dir, '.cor', '.gitignore'), ignore);
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, '.cor', name), body);
  };

  const ours = tempDir();
  seed(ours);
  const store = createFingerprintStore({ home: HOME, dir: ours });
  assert.equal(store.lookup(`${base}/old`, 'a.old').length, 1, 'readable before the first write');
  store.record({ url: `${base}/new`, elementKey: 'new', fingerprint: fp, locators: ['a.new'] });
  assert.deepEqual(readRecords(ours).records.map((r) => r.elementKey).sort(), ['legacy', 'new']);
  assert.equal(existsSync(join(ours, '.cor')), false, 'our own .cor/ is removed');

  const shared = tempDir();
  seed(shared, { 'telemetry-pending.json': '[]' }, 'fingerprints.json\ntelemetry-pending.json\n');
  createFingerprintStore({ home: HOME, dir: shared }).record({ url: `${base}/new`, elementKey: 'n2', fingerprint: fp, locators: ['a'] });
  assert.deepEqual(readdirSync(join(shared, '.cor')).sort(), ['.gitignore', 'telemetry-pending.json'], 'someone else\'s files stay; only ours goes');
});

test('inspecting the same element twice keeps one record and a valid file', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ home: HOME, dir }));
  await call('cor_inspect', { selector: 'button', framework: 'cypress' });
  await call('cor_inspect', { selector: 'button', framework: 'playwright' });
  await call('cor_inspect', { selector: 'a' });
  const { records } = readRecords(dir);
  assert.equal(records.length, 2, 'one per element, whatever the framework');
  assert.ok(records.every((r) => r.firstSeen <= r.lastSeen));
});

test('only the fingerprint fields are stored, with emails, long numbers, tokens and URL queries masked', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ home: HOME, dir }));
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
  const file = readFileSync(storeFileFor(dir, HOME), 'utf8');
  for (const secret of ['typed@secret.com', 'jane.doe@example.com', '4815162342', TOKEN, 'token=']) {
    assert.ok(!file.includes(secret), `${secret} leaked into the file`);
  }
});

test('no cookie or token value reaches a record or a tool response', async (t) => {
  const dir = tempDir();
  const call = await connect(t, createFingerprintStore({ home: HOME, dir }));
  const responses = [];
  responses.push(await call('cor_snapshot'));
  for (const selector of ['a', 'button', 'input']) responses.push(await call('cor_inspect', { selector }));
  const file = readFileSync(storeFileFor(dir, HOME), 'utf8');
  // The adopted storage state's cookie appears nowhere.
  assert.ok(!file.includes(COOKIE) && !responses.join('\n').includes(COOKIE));
  // A token in the page's own href is page content the agent sees anyway —
  // but it must not be written to disk, in the fingerprint or a stored locator.
  assert.ok(!file.includes(TOKEN), 'token written to the fingerprint file');
  assert.ok(!file.includes('jane.doe@example.com'));
  // …and a locator carrying them is still found by its original, unmasked text.
  const store = createFingerprintStore({ home: HOME, dir });
  assert.equal(store.lookup(`${base}/account`, `a[aria-label="Orders for jane.doe@example.com"]`).length, 1);
  assert.equal(store.lookup(`${base}/account`, `a[href="/orders/123?token=${TOKEN}#details"]`).length, 1);
});

test('a write failure (read-only home) does not fail the inspect', async (t) => {
  const home = tempDir();
  const dir = tempDir();
  chmodSync(home, 0o555);
  t.after(() => chmodSync(home, 0o755));
  const call = await connect(t, createFingerprintStore({ home, dir }));
  const out = await call('cor_inspect', { selector: 'button' });
  assert.match(out, /^Best locator/);
  assert.equal(existsSync(join(home, '.cor')), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('records unseen for the retention period are pruned on the next write', () => {
  const dir = tempDir();
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = createFingerprintStore({ home: HOME, dir, now: () => now });
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
  const home = tempDir();
  const withCapture = await runBin(t, { cwd: on, env: { HOME: home } });
  assert.equal(withCapture.stderr, '', 'capture is silent');
  assert.equal(readRecords(on, home).records.length, 3, 'four inspects of three elements');
  assert.deepEqual(readdirSync(on), [], 'nothing inside the working folder');

  const flagged = tempDir();
  const flaggedHome = tempDir();
  const withFlag = await runBin(t, { cwd: flagged, args: ['--no-fingerprints'], env: { HOME: flaggedHome } });
  assert.equal(existsSync(join(flaggedHome, '.cor')), false, '--no-fingerprints writes no file at all');
  assert.deepEqual(withFlag.texts, withCapture.texts, 'tool responses are identical with capture on or off');
  assert.equal(withFlag.stderr, '');

  const env = tempDir();
  const envHome = tempDir();
  await runBin(t, { cwd: env, env: { COR_FINGERPRINTS: 'off', HOME: envHome } });
  assert.equal(existsSync(join(envHome, '.cor')), false, 'COR_FINGERPRINTS=off writes no file');
});
