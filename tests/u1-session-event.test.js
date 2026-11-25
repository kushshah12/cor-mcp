// U1 (plan 2026-11-24-002): mcp_session_started carries the connected client, CI/container flags and install source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sessionStartedEvent, normalizeSource, envFlags, createTelemetry } from '../src/telemetry.js';
import { createServer } from '../src/server.js';

const KEY = 'phc_test';
const HOST = 'https://ph.example.test';
const noDocker = () => false;

test('U1: event carries exactly the allow-listed keys', () => {
  const built = sessionStartedEvent({ clientName: 'claude-code', clientVersion: '2.1.0', version: '0.2.0', ci: false, container: false, source: 'smithery', url: 'https://secret' });
  assert.equal(built.event, 'mcp_session_started');
  assert.deepEqual(Object.keys(built.properties).sort(), ['ci', 'client_name', 'client_version', 'container', 'source', 'version']);
  assert.equal(built.properties.client_name, 'claude-code');
  assert.equal(built.properties.source, 'smithery');
});

test('U1: normalizeSource keeps known values, maps unknown to other and missing to unknown', () => {
  assert.equal(normalizeSource('lens'), 'lens');
  assert.equal(normalizeSource(' Smithery '), 'smithery');
  assert.equal(normalizeSource('evil.com'), 'other');
  assert.equal(normalizeSource(undefined), 'unknown');
  assert.equal(normalizeSource(''), 'unknown');
});

test('U1: envFlags reads CI variables and /.dockerenv', () => {
  assert.deepEqual(envFlags({ CI: 'true' }, noDocker), { ci: true, container: false });
  assert.deepEqual(envFlags({ GITHUB_ACTIONS: 'true' }, noDocker), { ci: true, container: false });
  assert.deepEqual(envFlags({ CI: 'false' }, noDocker), { ci: false, container: false });
  assert.deepEqual(envFlags({}, noDocker), { ci: false, container: false });
  assert.deepEqual(envFlags({}, (p) => p === '/.dockerenv'), { ci: false, container: true });
  assert.deepEqual(envFlags({}, () => { throw new Error('denied'); }), { ci: false, container: false });
});

test('U1: client strings are truncated to 64 printable ASCII characters', () => {
  const built = sessionStartedEvent({ clientName: 'a\u0000b\nc' + 'x'.repeat(100), clientVersion: 7 });
  assert.equal(built.properties.client_name, ('abc' + 'x'.repeat(100)).slice(0, 64));
  assert.equal(built.properties.client_version, '');
});

async function connect({ env = {}, fetchImpl, source, clientName = 'claude-code' }) {
  const telemetry = createTelemetry({ env, key: KEY, host: HOST, dir: mkdtempSync(join(tmpdir(), 'cor-u1-')), fetchImpl });
  const server = createServer({ tools: [], telemetry, source, env });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '9.9.9' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await new Promise((r) => setTimeout(r, 20)); // the initialized notification is async
  return { client, server };
}

test('U1: the handshake sends one mcp_session_started with the client name and source', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => { sent.push(JSON.parse(init.body)); return {}; };
  const { client } = await connect({ env: { CI: 'true' }, fetchImpl, source: 'lens' });
  const sessions = sent.filter((b) => b.event === 'mcp_session_started');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].properties.client_name, 'claude-code');
  assert.equal(sessions[0].properties.client_version, '9.9.9');
  assert.equal(sessions[0].properties.source, 'lens');
  assert.equal(sessions[0].properties.ci, true);
  await client.close();
});

test('U1: COR_TELEMETRY=off sends nothing on the handshake', async () => {
  const sent = [];
  const { client } = await connect({ env: { COR_TELEMETRY: 'off' }, fetchImpl: async (_u, i) => { sent.push(i); return {}; } });
  assert.equal(sent.length, 0);
  await client.close();
});

test('U1: a throwing fetch does not break the handshake', async () => {
  const { client } = await connect({ fetchImpl: () => { throw new Error('network'); } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools, []);
  await client.close();
});
