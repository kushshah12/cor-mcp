// U9 — cor_check: every locator in the changed test files carries a COR id; typed and positional ones fail with COR's
// entry to paste; a working one COR has a record of gets the id to add. It never edits a file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { scanLocators } from '../src/check-scan.js';

const root = mkdtempSync(join(tmpdir(), 'cor-u9-'));
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

const site = createHttpServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(new URL('./fixtures/data-test.html', import.meta.url))); });
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, cwd, { records = true } = {}) {
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  const store = records ? createRecordStore({ root: () => session.root }) : null;
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: store });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(clientSide(c))]);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  return call;
}
const clientSide = (c) => c;
const idOf = (s) => /cor:([0-9a-f]{6})/.exec(s)?.[1];

test('U9 scan: one site per statement, the id from the comment above, positional picks flagged', () => {
  const sites = scanLocators([
    'export class P {',
    '  // COR cor:aaaaaa · 99 Excellent · 1 match',
    "  badge = () => this.page.getByTestId('b');",
    "  first = () => this.page.locator('button').first();",
    '}',
  ].join('\n'));
  assert.deepEqual(sites.map((s) => [s.line, s.id, Boolean(s.positional)]), [[3, 'aaaaaa', false], [4, null, true]]); // P1: the reason, or null
});

test('U9 (AE8) a typed positional locator fails and comes back with COR\'s entry to paste', async (t) => {
  const dir = repo('ae8', { ...PKG, 'tests/cart.spec.ts': "test('x', async ({ page }) => {\n  await page.locator('[data-test=\"inventory-item\"] button').first().click();\n});\n" });
  const call = await connect(t, dir);
  await call('cor_open', { url: base });
  const out = await call('cor_check', { all: true });
  assert.equal(out.isError, true);
  assert.match(out.text, /^cor_check: 1 locator in 1 file \(all project files\) — 0 carry a COR id, 1 to fix\./);
  assert.match(out.text, /✗ tests\/cart\.spec\.ts:2 — .*picks by position/);
  assert.match(out.text, /Replace it with COR's entry:\n {4}Entry — place in tests\/pages\/home\.page\.js, member/);
  assert.match(out.text, /\/\/ COR cor:[0-9a-f]{6}/);
});

test('U9 (AE11, R44) a working locator without its id: COR has a record of the element, so it returns the id to add', async (t) => {
  const dir = repo('ae11', PKG);
  const call = await connect(t, dir);
  await call('cor_open', { url: base });
  const id = idOf((await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' })).text);
  writeFileSync(join(dir, 'tests', 'pages', 'home.page.ts').replace('/tests/pages/home.page.ts', '/home.page.ts'), "export class Home {\n  constructor(page) { this.page = page; }\n  shoppingCartBadge = () => this.page.locator('[data-test=\"shopping-cart-badge\"]');\n}\n");
  const out = await call('cor_check', { files: ['home.page.ts'] });
  assert.match(out.text, /✗ home\.page\.ts:3 — .* no COR id\./, out.text);
  assert.match(out.text, new RegExp(`COR already has a record of this element: add \`// COR cor:${id}\` on the line above it`));
});

test('U9 an entry placed as given passes, even reformatted, renamed and moved (identity is the id)', async (t) => {
  const dir = repo('pass', PKG);
  const call = await connect(t, dir);
  await call('cor_open', { url: base });
  const id = idOf((await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' })).text);
  mkdirSync(join(dir, 'e2e', 'objects'), { recursive: true });
  writeFileSync(join(dir, 'e2e/objects/cart.ts'), `export class Cart {\n  // COR cor:${id} · 99 Excellent · 1 match\n  badge = () =>\n    this.page\n      .locator("[data-test='shopping-cart-badge']");\n}\n`);
  writeFileSync(join(dir, 'e2e/cart.spec.ts'), `test('t', async ({ page }) => {\n  await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1'); // cor:${id}\n});\n`);
  const out = await call('cor_check', { all: true });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^cor_check: 2 locators in 2 files \(all project files\) — 2 carry a COR id, 0 to fix\.$/);
});

test('U9 (AE13) an inline assertion without an id fails; an id COR did not issue fails', async (t) => {
  const dir = repo('inline', { ...PKG, 'tests/a.spec.ts': "test('t', async ({ page }) => {\n  await expect(page.getByText('Onesie', { exact: true })).toBeVisible();\n  // COR cor:abcdef · 99 Excellent · 1 match\n  await page.locator('[data-test=\"shopping-cart-badge\"]').click();\n});\n" });
  const call = await connect(t, dir);
  await call('cor_open', { url: base });
  await call('cor_inspect', { selector: '[data-test="inventory-list"]' }); // creates .cor/records/
  const out = await call('cor_check', { all: true });
  assert.match(out.text, /✗ tests\/a\.spec\.ts:2 — .*getByText\('Onesie'.* no COR id\./);
  assert.match(out.text, /✗ tests\/a\.spec\.ts:4 — cor:abcdef is not a record COR issued in this project/);
});

test('U9 (R47) by default only files changed on the branch are checked', async (t) => {
  const dir = repo('git', { ...PKG, 'tests/old.spec.ts': "page.locator('#old');\n" });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'tests/new.spec.ts'), "page.locator('#new');\n");
  const call = await connect(t, dir);
  const out = await call('cor_check');
  assert.match(out.text, /^cor_check: 1 locator in 1 file \(files changed on this branch\)/, out.text);
  assert.match(out.text, /tests\/new\.spec\.ts:1/);
  assert.doesNotMatch(out.text, /old\.spec/);
  assert.match(out.text, /Open the page it targets \(cor_open\)/, 'no page open: says how to get the fix');
});

test('U9 a JSON map: keys need their id in COR\'s sidecar; the map is never edited', async (t) => {
  const MAP = '{"badge":"[data-test=\\"shopping-cart-badge\\"]"}';
  const dir = repo('json', { ...PKG, 'e2e/locators/home.json': MAP, 'e2e/a.spec.js': "const l = require('./locators/home.json');\n" });
  const call = await connect(t, dir);
  await call('cor_open', { url: base });
  await call('cor_inspect', { selector: '[data-test="inventory-list"]' });
  const out = await call('cor_check', { files: ['e2e/locators/home.json'] });
  assert.match(out.text, /✗ e2e\/locators\/home\.json:1 — badge: .* no COR id\./, out.text);
  assert.equal(readFileSync(join(dir, 'e2e/locators/home.json'), 'utf8'), MAP);
});

test('U9 records off: ids are checked for presence only, and the reply says so', async (t) => {
  const dir = repo('off', { ...PKG, 'tests/a.spec.ts': "// COR cor:123456 · 99 Excellent · 1 match\npage.locator('#a');\n" });
  const call = await connect(t, dir, { records: false });
  const out = await call('cor_check', { all: true });
  assert.equal(out.isError, false);
  assert.match(out.text, /No \.cor\/records\/ in this project \(records off\)/);
});
