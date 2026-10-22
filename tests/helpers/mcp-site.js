// A test site (tests/fixtures, scripts/conformance/fixtures) and an MCP client on a fresh project — P2b, P6.
import { before, after } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createSession } from '../../src/session.js';
import { createRecordStore } from '../../src/records.js';

export const root = mkdtempSync(join(tmpdir(), 'cor-p6-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIRS = [new URL('../fixtures/', import.meta.url), new URL('../../scripts/conformance/fixtures/', import.meta.url)];
const site = createHttpServer((req, res) => {
  for (const dir of DIRS) {
    let body;
    try { body = readFileSync(new URL(`${req.url.slice(1).split('?')[0]}.html`, dir)); } catch { continue; }
    return res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  }
  res.writeHead(404).end();
});
let base;
export const baseUrl = () => base;
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


// G1d: the member lines of a reply's entries, and the first entry as placed (its // COR line and member line).
export const members = (reply) => reply.split('\n').filter((l) => /^\s+\w+ = \(/.test(l)).map((l) => l.trim());
export const entry = (reply) => reply.split('\n').filter((l) => /^\s*\/\/ COR cor:|^\s+\w+ = \(/.test(l)).slice(0, 2).map((l) => l.trim()).join('\n');
