// U1 — the golden suite: COR's replies for fixed pages × elements × frameworks, recorded in
// expected/<case>.txt and compared exactly. No LLM, no network (frozen pages, external requests
// blocked). A change in output fails until it is accepted on purpose:
//
//   npm run test:golden                       # compare
//   COR_GOLDEN_ACCEPT=1 npm run test:golden   # rewrite expected/ for the cases that changed
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordStore } from '../../src/records.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createSession } from '../../src/session.js';
import { CASES } from './cases.mjs';

const ACCEPT = process.env.COR_GOLDEN_ACCEPT === '1';
const EXPECTED = new URL('./expected/', import.meta.url);
const MAX_GROWTH = 1.15;
const MAX_MS = 20_000; // per case; the suite records output, not timings (U13 measures time)

const TYPES = { html: 'text/html', js: 'text/javascript' };
const site = createHttpServer((req, res) => {
  const path = req.url.split('?')[0];
  // Frozen real pages, fixtures, and COR Shop — the suite's own app (app/), which runs its JS.
  const m = /^\/(site|fixture)\/([\w-]+)$/.exec(path) ?? /^\/(app)\/([\w-]+\.(?:html|js))$/.exec(path);
  const file = m && (m[1] === 'site' ? new URL(`./sites/${m[2]}/page.html`, import.meta.url)
    : m[1] === 'app' ? new URL(`./app/${m[2]}`, import.meta.url) : new URL(`../fixtures/${m[2]}.html`, import.meta.url));
  if (!file || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[file.pathname.split('.').pop()] ?? 'text/html' });
  res.end(readFileSync(file));
});
// An empty project: detection finds no framework, config or locator store, so output does not depend on this repo.
const CWD = new URL('./projects/empty/', import.meta.url).pathname;
let base;

before(() => new Promise((resolve) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; resolve(); })));
after(() => site.close());

/** A fresh session per case: session state (the framework argument, refs) must not leak between cases. */
async function connect(project, { records = false } = {}) {
  // `project` names a folder under projects/ (a package.json and test config) to detect conventions from. A case with
  // records runs in a temporary copy of it (records and files are written there), with ids 000001, 000002, … in order.
  let cwd = project ? new URL(`./projects/${project}/`, import.meta.url).pathname : CWD;
  let store = null;
  if (records) {
    const copy = mkdtempSync(join(tmpdir(), 'cor-golden-'));
    cpSync(cwd, copy, { recursive: true });
    cwd = copy;
    let n = 0;
    store = createRecordStore({ root: () => copy, newId: () => String(++n).padStart(6, '0') });
  }
  const session = createSession({ headless: true, cwd });
  const page = await session.getPage();
  // Frozen pages still reference images and fonts on their origin; only the local server answers.
  await page.context().route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'golden', version: '0' });
  const server = createServer({ session, records: store });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args) => {
    // P4: the cases record cor_inspect's full reply (detail) unless a case asks for the default with detail: false.
    const full = name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args;
    const r = await client.callTool({ name, arguments: full });
    return `${r.isError ? '[error] ' : ''}${r.content.map((c) => c.text).join('\n')}`;
  };
  return { call, close: () => { if (store) rmSync(cwd, { recursive: true, force: true }); return session.close(); } };
}

// The local port and the installed Chrome version change between runs; nothing else may.
// U8: entry ids are random per issue.
const normalise = (text, keepIds = false) => (keepIds ? text : text.replace(/cor:[0-9a-f]{6}\b/g, 'cor:{id}')).split(base).join('{base}').replace(/Browser: [^\n]*?\d+(\.\d+)+\./g, 'Browser: {browser}.').replace(/\(recorded \d{4}-\d{2}-\d{2}\)/g, '(recorded {date})');

for (const c of CASES) {
  test(`golden ${c.id}${c.defect ? ` (${c.defect})` : ''}`, { timeout: MAX_MS }, async (t) => {
    const { call, close } = await connect(c.project, { records: c.records });
    t.after(close);
    const parts = [`# ${c.id}${c.defect ? ` — pins ${c.defect}` : ''}`, normalise(await call('cor_open', { url: `${base}/${c.open}` }), c.records)];
    for (const [tool, raw] of c.calls) {
      const args = raw.url?.startsWith('{base}') ? { ...raw, url: raw.url.replace('{base}', base) } : raw;
      const reply = normalise(await call(tool, args), c.records);
      parts.push(`--- ${tool} ${JSON.stringify(raw)} (${reply.length} chars)`, reply);
    }
    const actual = `${parts.join('\n')}\n`;
    const file = new URL(`${c.id}.txt`, EXPECTED);
    if (ACCEPT) {
      mkdirSync(EXPECTED, { recursive: true });
      // U11: the token budget — accepting a reply more than 15% longer needs COR_GOLDEN_ALLOW_GROWTH=1, so growth is a decision.
      const before = existsSync(file) ? readFileSync(file, 'utf8').length : null;
      assert.ok(before === null || actual.length <= before * MAX_GROWTH || process.env.COR_GOLDEN_ALLOW_GROWTH === '1',
        `${c.id} grew ${before} → ${actual.length} characters (> ${Math.round((MAX_GROWTH - 1) * 100)}%) — trim it, or accept with COR_GOLDEN_ALLOW_GROWTH=1`);
      if (before === null || readFileSync(file, 'utf8') !== actual) writeFileSync(file, actual);
      return;
    }
    assert.ok(existsSync(file), `no expected output for ${c.id} — run with COR_GOLDEN_ACCEPT=1 to record it`);
    assert.equal(actual, readFileSync(file, 'utf8'), `${c.id} changed — review the diff; accept with COR_GOLDEN_ACCEPT=1 if intended`);
  });
}
