// U18b.4 — row × column cells: one XPath with two parameters, the row's key
// and the column's header. From the BrowserStack comparison: both agents read
// one comparison cell inline (a row header + a computed column index).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { verifyTemplate } from '../src/tools/inspect.js';
import { interpolateTemplate } from './helpers/interpolate.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/tables.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let call;
let page;
// One hook: node:test does not wait for one root-level before() to finish before starting the next.
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

const params = async (selector) => {
  const p = (await callPage(page, 'inspect', { selector, framework: 'playwright', max: 1 })).params;
  if (p) await verifyTemplate(page, p);
  return p;
};
const fill = (p, row, column) => interpolateTemplate(
  { selectorTemplate: p.template.playwright.selectorTemplate, vars: p.vars.map((v) => ({ varName: v, syntax: p.template.playwright.syntax })) },
  { [p.vars[0]]: row, [p.vars[1]]: column },
);
// The code is a helper taking (row, column) since U21 — readable parts, not one long XPath.
const run = (p, row, column) => new Function('page', `return ${p.code};`)(page)(row, column);

test('a cell: two parameters, the row key and the column header, every combination on its row and column checked', async () => {
  const p = await params('table.users tbody tr:nth-child(2) td:nth-child(2)');
  assert.equal(p.kind, 'cell');
  assert.deepEqual(p.vars, ['name', 'column']);
  assert.deepEqual(p.rows, ['Ada', 'Grace', 'Linus']);
  assert.deepEqual(p.columns, ['Name', 'Role', 'Status', 'Action']);
  assert.deepEqual([p.row, p.column], ['Grace', 'Role']);
  assert.equal(p.counted, 3 + 4);
  for (const [row, column, want] of [['Grace', 'Role', 'Viewer'], ['Ada', 'Status', 'Active'], ['Linus', 'Role', 'Editor'], ['Grace', 'Name', 'Grace']]) {
    assert.equal(await page.locator(fill(p, row, column)).textContent(), want, `${row}/${column} registry`);
    assert.equal(await run(p, row, column).textContent(), want, `${row}/${column} code`);
  }
});

test('a value with quotes is escaped by the client (xpath-literal)', async () => {
  const p = await params('table.users tbody tr:nth-child(1) td:nth-child(3)');
  const xp = fill(p, `O'Brien "Jr"`, 'Status');
  assert.match(xp, /concat\(/);
  assert.equal(await page.locator(xp).count(), 0, 'valid XPath, simply no such row');
});

test('a header spanning columns: no cell template, and the reason', async () => {
  const p = await params('table.spans tr:nth-child(2) td:nth-child(3)');
  assert.equal(p?.kind, 'cell');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /spans more than one column/);
});

test('no column names every row uniquely: no cell template, and the reason', async () => {
  const p = await params('table.dupes tr:nth-child(3) td:nth-child(3)');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /two rows share the key "Sam"/);
});

test('a control inside a row keeps U18\'s row template', async () => {
  const p = await params('table.users tbody tr:nth-child(2) button');
  assert.notEqual(p.kind, 'cell');
  assert.equal(p.param, 'name');
});

test('cor_inspect renders the cell template', async () => {
  const out = await call('cor_inspect', { selector: 'table.users tbody tr:nth-child(2) td:nth-child(2)' });
  assert.match(out, /^Recommended — parameterised by row and column: 3 rows × 4 columns; every row and column checked \(7\/7\)\./m);
  assert.match(out, /name = "Grace" {3}\(also: "Ada", "Linus"\)/);
  assert.match(out, /column = "Role" {3}\(also: "Name", "Status", "Action"\)/);
  assert.match(out, /page\.locator\(`xpath=/);
});

test('a leading checkbox column with no header: the key is the first column that names rows', async () => {
  const p = await params('table.picks tr:nth-child(3) td:nth-child(3)');
  assert.ok(p.template, JSON.stringify(p));
  assert.deepEqual(p.vars, ['username', 'column']);
  assert.deepEqual(p.rows, ['joe', 'ann']);
  assert.deepEqual(p.columns, ['Username', 'Role'], 'the empty header is not offered');
  assert.equal(await page.locator(fill(p, 'ann', 'Role')).textContent(), 'Viewer');
  assert.equal(await page.locator(fill(p, 'joe', 'Role')).textContent(), 'Admin');
});
