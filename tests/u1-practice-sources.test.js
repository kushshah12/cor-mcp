// U1 (plan 2026-11-26-001): practice_/site_ sources pass through normalizeSource, and mcp_installed carries source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { normalizeSource, installedEvent, announceFirstRun } from '../src/telemetry.js';
import { entryArgs, runSetup } from '../src/setup.js';
import { createServer } from '../src/server.js';

test('U1: practice_ and site_ slugs pass through unchanged', () => {
  for (const s of ['practice_xpath', 'practice_web-tables', 'site_home', 'site_mcp', 'practice_a1', ' practice_xpath ']) {
    assert.equal(normalizeSource(s), s.trim(), s);
  }
});

test('U1: malformed slugs map to other', () => {
  for (const s of ['practice_', 'site_', 'practice_XPath', 'Practice_xpath', 'practice_x y', 'practice_../etc', 'practice_x_y',
    'practicexpath', 'other_xpath', 'xpractice_xpath', `practice_${'a'.repeat(49)}`,
    'practice_5551234567', 'site_order-123456']) {
    assert.equal(normalizeSource(s), 'other', JSON.stringify(s));
  }
  assert.equal(normalizeSource(`practice_${'a'.repeat(48)}`), `practice_${'a'.repeat(48)}`);
});

test('U1: closed-list values, empty and non-string input are unchanged', () => {
  assert.equal(normalizeSource('lens'), 'lens');
  assert.equal(normalizeSource('readme'), 'readme');
  assert.equal(normalizeSource(' Lens '), 'lens');
  assert.equal(normalizeSource(''), 'unknown');
  assert.equal(normalizeSource('   '), 'unknown');
  assert.equal(normalizeSource(undefined), 'unknown');
  assert.equal(normalizeSource(42), 'unknown');
  assert.equal(normalizeSource('evil.com'), 'other');
});

test('U1: installedEvent carries the normalized source', () => {
  assert.equal(installedEvent({ version: '0.2.0', source: 'practice_xpath' }).properties.source, 'practice_xpath');
  assert.equal(installedEvent({ version: '0.2.0', source: 'practice_../etc' }).properties.source, 'other');
  assert.equal(installedEvent({ version: '0.2.0' }).properties.source, 'unknown');
});

test('U1: announceFirstRun threads source into mcp_installed', () => {
  const sent = [];
  announceFirstRun({ installCreated: true, track: (e) => sent.push(e) }, { version: '0.2.0', source: 'site_home', stderr: { write() {} } });
  assert.equal(sent[0].event, 'mcp_installed');
  assert.equal(sent[0].properties.source, 'site_home');
});

test('U1: setup writes a practice source into the client config; a bad one becomes other', async () => {
  assert.deepEqual(entryArgs('0.2.0', 'practice_xpath').slice(-2), ['--source', 'practice_xpath']);
  assert.deepEqual(entryArgs('0.2.0', 'practice_XPath').slice(-2), ['--source', 'other']);
  const root = mkdtempSync(join(tmpdir(), 'cor-u1p-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(cwd, '.cursor'), { recursive: true });
  mkdirSync(home);
  await runSetup({ cwd, home, version: '0.2.0', yes: true, source: 'practice_xpath', stdout: { write() {} }, stdin: { isTTY: false } });
  const cfg = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.cor.args, ['-y', '@corlabsdev/mcp@0.2.0', '--source', 'practice_xpath']);
});

test('U1/AE6: a session started with --source practice_xpath carries it on $mcp_initialize and $mcp_tool_call', async (t) => {
  const events = [];
  const telemetry = { track: (built) => { if (built) events.push(built); } };
  const ok = { content: [{ type: 'text', text: 'fine' }] };
  const server = createServer({ tools: [{ name: 'cor_open', config: { description: 'cor_open' }, handler: async () => ok }], telemetry, source: 'practice_xpath' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  await new Promise((r) => setTimeout(r, 20)); // the initialized notification is async
  await client.callTool({ name: 'cor_open', arguments: {} });
  const init = events.find((e) => e.event === '$mcp_initialize');
  const call = events.find((e) => e.event === '$mcp_tool_call');
  assert.equal(init?.properties.source, 'practice_xpath');
  assert.equal(call?.properties.source, 'practice_xpath');
});
