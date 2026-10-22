import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, installId, installedEvent, toolCalledEvent, createTelemetry } from '../src/telemetry.js';

const KEY = 'phc_test';
const HOST = 'https://ph.example.test';
const REGISTERED = ['cor_open', 'cor_click'];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cor-telemetry-'));
}

test('COR_TELEMETRY=off disables telemetry even with a key', () => {
  assert.equal(resolveConfig({ COR_TELEMETRY: 'off' }, { key: KEY, host: HOST }).enabled, false);
});

test('COR_OFFLINE=true disables telemetry, like @corlabs/client', () => {
  assert.equal(resolveConfig({ COR_OFFLINE: 'true' }, { key: KEY, host: HOST }).enabled, false);
});

test('no injected key or host means telemetry is off', () => {
  assert.equal(resolveConfig({}, { key: '', host: HOST }).enabled, false);
  assert.equal(resolveConfig({}, { key: KEY, host: '' }).enabled, false);
  assert.equal(resolveConfig({}, { key: KEY, host: HOST }).enabled, true);
});

test('installId creates the file on first call and reuses it after', () => {
  const dir = tempDir();
  const first = installId(dir);
  assert.equal(first.created, true);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(readFileSync(join(dir, 'install-id'), 'utf8'), first.id);
  const second = installId(dir);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
});

test('installId with an unwritable directory returns an id and does not throw', () => {
  const dir = tempDir();
  chmodSync(dir, 0o500);
  const blocked = join(dir, 'nested');
  const result = installId(blocked);
  assert.equal(result.created, false);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(existsSync(blocked), false);
  chmodSync(dir, 0o700);
});

test('mcp_tool_called rejects a tool name that is not registered', () => {
  assert.equal(toolCalledEvent({ tool: 'cor_evil', durationMs: 5, outcome: 'ok', version: '0.1.4' }, REGISTERED), null);
});

test('mcp_tool_called rejects an unknown outcome or a bad duration', () => {
  assert.equal(toolCalledEvent({ tool: 'cor_open', durationMs: 5, outcome: 'weird', version: 'x' }, REGISTERED), null);
  assert.equal(toolCalledEvent({ tool: 'cor_open', durationMs: -1, outcome: 'ok', version: 'x' }, REGISTERED), null);
  assert.equal(toolCalledEvent({ tool: 'cor_open', durationMs: 1.5, outcome: 'ok', version: 'x' }, REGISTERED), null);
});

test('builders return exactly the allow-listed fields', () => {
  const tool = toolCalledEvent({ tool: 'cor_open', durationMs: 42, outcome: 'ok', version: '0.1.4' }, REGISTERED);
  assert.deepEqual(Object.keys(tool.properties).sort(), ['duration_ms', 'outcome', 'tool', 'version']);
  const installed = installedEvent({ version: '0.1.4', node: 'v20.0.0', platform: 'darwin' });
  assert.deepEqual(Object.keys(installed.properties).sort(), ['node', 'platform', 'version']);
});

test('builder fields never carry a URL, an email or an error message', () => {
  const built = [
    installedEvent({ version: '0.1.4' }),
    toolCalledEvent({ tool: 'cor_open', durationMs: 1, outcome: 'exception', version: '0.1.4' }, REGISTERED),
  ];
  const serialized = JSON.stringify(built);
  assert.doesNotMatch(serialized, /https?:\/\//);
  assert.doesNotMatch(serialized, /@/);
});

test('send posts the event to the capture endpoint with the install id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const telemetry = createTelemetry({ env: {}, key: KEY, host: `${HOST}/`, dir: tempDir(), fetchImpl });
  telemetry.track(installedEvent({ version: '0.1.4' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HOST}/capture/`);
  assert.equal(calls[0].body.api_key, KEY);
  assert.equal(calls[0].body.event, 'mcp_installed');
  assert.match(calls[0].body.distinct_id, /^[0-9a-f-]{36}$/);
});

test('send resolves and never throws when fetch rejects or throws synchronously', async () => {
  const rejecting = createTelemetry({ env: {}, key: KEY, host: HOST, dir: tempDir(), fetchImpl: async () => { throw new Error('offline'); } });
  assert.doesNotThrow(() => rejecting.track(installedEvent({ version: '0.1.4' })));
  const throwing = createTelemetry({ env: {}, key: KEY, host: HOST, dir: tempDir(), fetchImpl: () => { throw new Error('sync'); } });
  assert.doesNotThrow(() => throwing.track(installedEvent({ version: '0.1.4' })));
  await new Promise((r) => setImmediate(r));
});

test('a disabled telemetry sends nothing and writes no install id', () => {
  const dir = tempDir();
  let sent = 0;
  const telemetry = createTelemetry({ env: { COR_TELEMETRY: 'off' }, key: KEY, host: HOST, dir, fetchImpl: () => { sent += 1; return Promise.resolve({}); } });
  telemetry.track(installedEvent({ version: '0.1.4' }));
  assert.equal(telemetry.enabled, false);
  assert.equal(sent, 0);
  assert.equal(existsSync(join(dir, 'install-id')), false);
});

test('a null builder result is not sent', () => {
  let sent = 0;
  const telemetry = createTelemetry({ env: {}, key: KEY, host: HOST, dir: tempDir(), fetchImpl: () => { sent += 1; return Promise.resolve({}); } });
  telemetry.track(toolCalledEvent({ tool: 'cor_nope', durationMs: 1, outcome: 'ok', version: 'x' }, REGISTERED));
  assert.equal(sent, 0);
});

test('an existing install-id file is read, not overwritten', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'install-id'), 'abc-123');
  assert.deepEqual(installId(dir), { id: 'abc-123', created: false });
});
