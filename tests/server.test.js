import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, TOOLS } from '../src/server.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

async function connect(t, server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return client;
}

test('lists exactly the registered tools — no placeholders', async (t) => {
  const client = await connect(t, createServer());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
});

test('a throwing tool returns an error result and the session survives', async (t) => {
  const boom = { name: 'boom', config: { description: 'throws' }, handler: () => { throw new Error('kaput'); } };
  const ok = { name: 'ok', config: { description: 'works' }, handler: () => ({ content: [{ type: 'text', text: 'fine' }] }) };
  const client = await connect(t, createServer({ tools: [boom, ok] }));

  const failed = await client.callTool({ name: 'boom', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /kaput/);

  const after = await client.callTool({ name: 'ok', arguments: {} });
  assert.equal(after.content[0].text, 'fine');
});

test('stdio handshake against the bin, with no credentials, env or config', async (t) => {
  // Empty HOME and cwd: no ~/.cor/credentials, no cor.config.js, no COR_* vars.
  const empty = mkdtempSync(join(tmpdir(), 'cor-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pkgDir, 'bin/cor-mcp.js')],
    cwd: empty,
    env: { PATH: process.env.PATH, HOME: empty },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0' });
  t.after(() => client.close());
  await client.connect(transport);

  assert.deepEqual(client.getServerVersion(), { name: pkg.name, version: pkg.version });
  const { tools } = await client.listTools();
  assert.ok(Array.isArray(tools));
});

test('manifest: engine is not a published dependency, playwright-core not playwright', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/sdk', 'playwright-core', 'zod']);
  assert.equal(pkg.devDependencies['@corlabs/engine'] !== undefined, true);
  assert.match(pkg.dependencies['playwright-core'], /^\d+\.\d+\.\d+$/, 'playwright-core is pinned exact');
  assert.notEqual(pkg.license, 'MIT');
});

test('production install tree has playwright-core, not playwright, and no engine', () => {
  // --omit=dev is what a customer's `npx @corlabs/mcp` installs.
  const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '-w', pkg.name], { cwd: pkgDir, encoding: 'utf8' }));
  const names = new Set();
  const walk = (deps = {}) => { for (const [n, d] of Object.entries(deps)) { names.add(n); walk(d.dependencies); } };
  walk(tree.dependencies);
  assert.ok(names.has('playwright-core'));
  assert.ok(!names.has('playwright'), 'full playwright must not be in the tree');
  assert.ok(!names.has('@corlabs/engine'), 'engine must not reach a customer install');
});
