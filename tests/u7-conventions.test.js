// U7 — where and how the team keeps locators, read from the repo (spec imports) and overridden by cor.config.json;
// cor_open says what COR found. Nothing is written to the repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { conventionsLines, inferStore, readConfig, resolveConventions } from '../src/conventions.js';

const root = mkdtempSync(join(tmpdir(), 'cor-u7-'));
after(() => rmSync(root, { recursive: true, force: true }));
function repo(name, files) {
  const dir = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const PKG = { 'package.json': { name: 'x', devDependencies: { '@playwright/test': '1' } } };
const PAGE_OBJECT = "export class InventoryPage {\n  constructor(page) { this.page = page; }\n  cartBadge = () => this.page.locator('[data-test=\"shopping-cart-badge\"]');\n}\n";
const CONSTANTS = "export const inventory = { cartBadge: '[data-test=\"shopping-cart-badge\"]' };\n";

test('U7 page objects: specs importing a class with locators → page objects in that folder', () => {
  const dir = repo('po', { ...PKG, 'tests/pages/inventory.page.ts': PAGE_OBJECT, 'tests/cart.spec.ts': "import { InventoryPage } from './pages/inventory.page';\n", 'tests/list.spec.ts': "import { InventoryPage } from './pages/inventory.page';\n" });
  const c = resolveConventions(dir, 'playwright');
  assert.deepEqual([c.store.value, c.storeDir.value, c.store.from], ['page-object-class', 'tests/pages', 'inferred from 2 spec imports']);
  assert.equal(conventionsLines(c)[0], 'Locators: page objects in tests/pages/ (inferred from 2 spec imports).');
});

test('U7 a JSON map and locator constants are recognised', () => {
  const json = repo('json', { ...PKG, 'e2e/locators/inventory.json': '{"cartBadge":"[data-test=\\"x\\"]"}', 'e2e/cart.spec.js': "const loc = require('./locators/inventory.json');\n" });
  assert.equal(resolveConventions(json, 'playwright').store.value, 'json');
  const consts = repo('const', { ...PKG, 'e2e/locators/inventory.js': CONSTANTS, 'e2e/cart.spec.js': "import { inventory } from './locators/inventory.js';\n" });
  assert.deepEqual(inferStore(consts).found, [{ store: 'constants', dir: 'e2e/locators', imports: 1 }]);
});

test('U7 two shapes in use: the most-used wins and the other is reported', () => {
  const dir = repo('mixed', {
    ...PKG,
    'tests/pages/a.page.ts': PAGE_OBJECT, 'tests/locators/b.ts': CONSTANTS,
    'tests/one.spec.ts': "import { A } from './pages/a.page';\n", 'tests/two.spec.ts': "import { A } from './pages/a.page';\n", 'tests/three.spec.ts': "import { b } from './locators/b';\n",
  });
  const lines = conventionsLines(resolveConventions(dir, 'playwright'));
  assert.equal(lines[0], 'Locators: page objects in tests/pages/ (inferred from 2 spec imports).');
  assert.match(lines[1], /^Also in use: locator constants in tests\/locators\/ \(1\) — COR follows the most-used; set store in cor\.config\.json to choose\.$/);
});

test('U7 cor.config.json overrides inference; invalid values are reported and ignored', () => {
  const dir = repo('cfg', { ...PKG, 'tests/pages/a.page.ts': PAGE_OBJECT, 'tests/one.spec.ts': "import { A } from './pages/a.page';\n",
    'cor.config.json': { store: 'yaml', storeDir: 'locators', order: 'alphabetical', framework: 'cypress' } });
  const c = resolveConventions(dir, 'playwright');
  assert.deepEqual([c.store.value, c.store.from, c.storeDir.value, c.framework.value, c.order.value], ['yaml', 'cor.config.json', 'locators', 'cypress', 'framework']);
  assert.match(conventionsLines(c).at(-1), /cor\.config\.json order: "alphabetical" is not one of the accepted values — ignored/);
  assert.deepEqual(readConfig(repo('bad', { 'cor.config.json': '{oops' })).problems, ['cor.config.json is not valid JSON — ignored']);
});

test('U7 no specs: page-object defaults, said to be defaults', () => {
  const c = resolveConventions(repo('empty', PKG), 'playwright');
  assert.equal(conventionsLines(c)[0], 'Locators: page objects in tests/pages/ (default — no specs found).');
});

test('U7 reading the repo writes nothing', () => {
  const dir = repo('ro', { ...PKG, 'tests/one.spec.ts': '' });
  resolveConventions(dir, 'playwright');
  assert.deepEqual(readdirSync(dir).sort(), ['package.json', 'tests']);
});

// ── through the server ──
const site = createHttpServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>T</title><button data-test="save">Save</button><button data-test="cancel">Cancel</button>');
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });
async function connect(t, cwd) {
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
}

test('U7 (R18) order: testid-first in cor.config.json makes the test id lead under Playwright; cor_open says so', async (t) => {
  const call = await connect(t, repo('e2e-order', { ...PKG, 'cor.config.json': { order: 'testid-first' } }));
  const opened = await call('cor_open', { url: base });
  assert.match(opened, /\nLocators: page objects in tests\/pages\/ \(default — no specs found\)\.\nOrder: test id first \(cor\.config\.json\)/, opened);
  const out = await call('cor_inspect', { selector: '[data-test="save"]' });
  assert.match(out.split('\n')[1], /page\.locator\('\[data-test="save"\]'\)/, out);
});

test('U7 framework from cor.config.json renders without an argument, and cor_open names the source', async (t) => {
  const call = await connect(t, repo('e2e-fw', { ...PKG, 'cor.config.json': { framework: 'cypress', testIdAttribute: 'data-test' } }));
  assert.match(await call('cor_open', { url: base }), /\nFramework: Cypress — from cor\.config\.json\.\n/);
  assert.match((await call('cor_inspect', { selector: '[data-test="save"]' })).split('\n')[1], /cy\.get\(/);
});
