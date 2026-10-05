// U1 — the golden suite: COR's replies for fixed pages × elements × frameworks, recorded in
// expected/<case>.txt and compared exactly. No LLM, no network (frozen pages, external requests
// blocked). A change in output fails until it is accepted on purpose:
//
//   npm run test:golden                       # compare
//   COR_GOLDEN_ACCEPT=1 npm run test:golden   # rewrite expected/ for the cases that changed
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createSession } from '../../src/session.js';
import { CASES } from './cases.mjs';

const ACCEPT = process.env.COR_GOLDEN_ACCEPT === '1';
const EXPECTED = new URL('./expected/', import.meta.url);
const MAX_MS = 20_000; // per case; the suite records output, not timings (U13 measures time)

const site = createHttpServer((req, res) => {
  const m = /^\/(site|fixture)\/([\w-]+)$/.exec(req.url);
  const file = m && (m[1] === 'site' ? new URL(`./sites/${m[2]}/page.html`, import.meta.url) : new URL(`../fixtures/${m[2]}.html`, import.meta.url));
  if (!file || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(file));
});
// An empty project: detection finds no framework, config or locator store, so output does not depend on this repo.
const CWD = new URL('./projects/empty/', import.meta.url).pathname;
let base;

before(() => new Promise((resolve) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; resolve(); })));
after(() => site.close());

/** A fresh session per case: session state (the framework argument, refs) must not leak between cases. */
async function connect(project) {
  // `project` names a folder under projects/ (a package.json and test config) to detect conventions from.
  const session = createSession({ headless: true, cwd: project ? new URL(`./projects/${project}/`, import.meta.url).pathname : CWD });
  const page = await session.getPage();
  // Frozen pages still reference images and fonts on their origin; only the local server answers.
  await page.context().route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'golden', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return `${r.isError ? '[error] ' : ''}${r.content.map((c) => c.text).join('\n')}`;
  };
  return { call, close: () => session.close() };
}

// The local port and the installed Chrome version change between runs; nothing else may.
const normalise = (text) => text.split(base).join('{base}').replace(/Browser: [^\n]*?\d+(\.\d+)+\./g, 'Browser: {browser}.');

for (const c of CASES) {
  test(`golden ${c.id}${c.defect ? ` (${c.defect})` : ''}`, { timeout: MAX_MS }, async (t) => {
    const { call, close } = await connect(c.project);
    t.after(close);
    const parts = [`# ${c.id}${c.defect ? ` — pins ${c.defect}` : ''}`, normalise(await call('cor_open', { url: `${base}/${c.open}` }))];
    for (const [tool, args] of c.calls) {
      const reply = normalise(await call(tool, args));
      parts.push(`--- ${tool} ${JSON.stringify(args)} (${reply.length} chars)`, reply);
    }
    const actual = `${parts.join('\n')}\n`;
    const file = new URL(`${c.id}.txt`, EXPECTED);
    if (ACCEPT) {
      mkdirSync(EXPECTED, { recursive: true });
      if (!existsSync(file) || readFileSync(file, 'utf8') !== actual) writeFileSync(file, actual);
      return;
    }
    assert.ok(existsSync(file), `no expected output for ${c.id} — run with COR_GOLDEN_ACCEPT=1 to record it`);
    assert.equal(actual, readFileSync(file, 'utf8'), `${c.id} changed — review the diff; accept with COR_GOLDEN_ACCEPT=1 if intended`);
  });
}
