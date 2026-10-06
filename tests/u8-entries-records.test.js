// U8 — cor_inspect leads with an entry to place (code in the team's store style, target file, member, a grade comment
// with its cor: id), and writes one record per id under <project>/.cor/records/. COR edits no team file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { memberName, pageName } from '../src/entries.js';

const root = mkdtempSync(join(tmpdir(), 'cor-u8-'));
after(() => rmSync(root, { recursive: true, force: true }));
function repo(name, files) {
  const dir = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
// cor.config.js as `cor init` would hold it: the SDK's framework at the top, the MCP's settings under locators.
const corConfig = ({ framework, ...locators }) => `export default ${JSON.stringify({ ...(framework ? { framework } : {}), locators })};\n`;
const PKG = { 'package.json': { name: 'x', devDependencies: { '@playwright/test': '1', typescript: '5' } } };
const PO = { 'tests/pages/home.page.ts': "export class HomePage { constructor(page) { this.page = page; } x = () => this.page.locator('#x'); }\n", 'tests/home.spec.ts': "import { HomePage } from './pages/home.page';\n" };

const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url.startsWith('/inventory')
    ? readFileSync(new URL('./fixtures/data-test.html', import.meta.url))
    : '<title>Login</title><label for="u">Username</label><input id="u" data-test="username" value="jane@example.com"><button data-test="login-button">Login</button>');
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, cwd, { enabled = true, ids = null } = {}) {
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  let n = 0;
  const records = createRecordStore({ root: () => session.root, enabled, ...(ids ? { newId: () => ids[n++] } : {}) });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((x) => x.text).join('\n');
  return { call, records };
}
const idOf = (text) => /cor:([0-9a-f]{6})/.exec(text)?.[1];

test('U8 names: a page file from the URL path, a member from the action, the test id, or role + name', () => {
  assert.equal(pageName('https://www.saucedemo.com/inventory.html'), 'inventory');
  assert.equal(pageName('https://x.com/'), 'home');
  assert.equal(memberName({ element: { tag: 'span', testIds: { 'data-test': 'shopping-cart-badge' } } }), 'shoppingCartBadge');
  assert.equal(memberName({ element: { tag: 'button', accessibleName: 'Login', testIds: {} } }), 'loginButton');
  assert.equal(memberName({ params: { model: { leaf: { name: 'Add to cart' } } } }, { param: 'name' }), 'addToCart');
});

test('U8 page objects (TypeScript): the entry leads cor_inspect, and its record is written by id', async (t) => {
  const dir = repo('po', { ...PKG, ...PO });
  const { call, records } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-onesie"]' });
  const lines = out.split('\n').slice(out.split('\n').findIndex((l) => l.startsWith('Entry — ')));
  assert.equal(lines[0], 'Entry — place in tests/pages/inventory.page.ts, member addToCart (cor_check reads the cor: id; keep the comment):', out);
  assert.match(lines[1], /^ {2}\/\/ COR cor:[0-9a-f]{6} · addToCart$/); // P4: the comment names the member
  assert.match(lines[2], /^ {2}addToCart = \(name: string\) => this\.page\.locator\('\[data-test="inventory-item"\]'\)\.filter\(/);
  const record = records.read(idOf(out));
  assert.equal(record.page, `${base}/inventory.html`);
  assert.equal(record.fingerprint.tag, 'button');
  assert.ok(record.strategies.length >= 2 && record.strategies.length <= 12);
  assert.deepEqual(Object.keys(record.strategies[0]), ['kind', 'value']);
  assert.doesNotMatch(JSON.stringify(record), /this\.page|page\.getBy|cy\.get/, 'data, not ready-to-paste code');
  assert.deepEqual(readdirSync(dir).sort(), ['.cor', 'package.json', 'tests'], 'nothing else is written');
  assert.equal(readFileSync(join(dir, 'tests/pages/home.page.ts'), 'utf8'), PO['tests/pages/home.page.ts'], 'the team file is untouched');
});

test('U8 a single locator, constants store: member taking page, test-id member name', async (t) => {
  const dir = repo('const', { ...PKG, 'e2e/locators/home.ts': "export const home = { a: '[data-test=\"a\"]' };\n", 'e2e/a.spec.ts': "import { home } from './locators/home';\n" });
  const { call } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const out = await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' });
  assert.match(out, /\nEntry — place in e2e\/locators\/inventory\.locators\.ts, member shoppingCartBadge/);
  assert.match(out, /\n {2}shoppingCartBadge: \(page\) => page\.locator\('\[data-test="shopping-cart-badge"\]'\),\n/);
});

test('U8 (R15, R42) JSON store: a plain string, no comment, and the id in COR\'s sidecar', async (t) => {
  const dir = repo('json', { ...PKG, 'e2e/locators/home.json': '{"a":"#a"}', 'e2e/a.spec.js': "const l = require('./locators/home.json');\n" });
  const { call } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const out = await call('cor_inspect', { selector: '[data-test="add-to-cart-onesie"]' });
  assert.match(out, /\nEntry — place in e2e\/locators\/inventory\.json, member addToCart/);
  assert.match(out, /\n {2}"addToCart": "\/\/\*\[@data-test='inventory-item'\]/, out);
  assert.match(out, /\{name\}/);
  const id = /→ "([0-9a-f]{6})"/.exec(out)[1];
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.cor/ids.json'), 'utf8')), { 'e2e/locators/inventory.json#addToCart': id });
  assert.equal(readFileSync(join(dir, 'e2e/locators/home.json'), 'utf8'), '{"a":"#a"}');
});

test('U8 YAML store: a # comment carries the id', async (t) => {
  const dir = repo('yaml', { ...PKG, 'cor.config.js': corConfig({ store: 'yaml', storeDir: 'locators' }) });
  const { call } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const out = await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' });
  assert.match(out, /\nEntry — place in locators\/inventory\.yml, member shoppingCartBadge.*\n {2}# COR cor:[0-9a-f]{6} · shoppingCartBadge\n {2}shoppingCartBadge: "\[data-test=\\"shopping-cart-badge\\"\]"/);
});

test('U8 an id that already has a record file is issued again', async (t) => {
  const dir = repo('clash', { ...PKG, '.cor/records/aaaaaa.json': '{}' });
  const { call } = await connect(t, dir, { ids: ['aaaaaa', 'bbbbbb'] });
  await call('cor_open', { url: `${base}/inventory.html` });
  assert.equal(idOf(await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' })), 'bbbbbb');
  assert.equal(readFileSync(join(dir, '.cor/records/aaaaaa.json'), 'utf8'), '{}');
});

test('U8 records hold no typed values, and mask emails', async (t) => {
  const dir = repo('mask', PKG);
  const { call, records } = await connect(t, dir);
  await call('cor_open', { url: `${base}/login` });
  await call('cor_fill', { target: '#u', value: 'secret-typed-value' });
  const out = await call('cor_inspect', { selector: '#u' });
  const raw = JSON.stringify(records.read(idOf(out)));
  assert.doesNotMatch(raw, /secret-typed-value|jane@example\.com/);
});

test('U8 capture off: entries still carry an id, and no .cor/ is created', async (t) => {
  const dir = repo('off', PKG);
  const { call } = await connect(t, dir, { enabled: false });
  await call('cor_open', { url: `${base}/inventory.html` });
  assert.ok(idOf(await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' })));
  assert.equal(existsSync(join(dir, '.cor')), false);
});

test('U8 (AE12) a committed record is read from a fresh checkout with no home-directory state', async (t) => {
  const dir = repo('checkout', PKG);
  const { call } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const id = idOf(await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' }));
  const fresh = createRecordStore({ root: () => dir });
  assert.equal(fresh.read(id).id, id);
  assert.ok(fresh.read(id).strategies.some((s) => s.value.includes('shopping-cart-badge')));
});

test('U8 a re-inspect of the same element reuses its id: one record per element, not per call', async (t) => {
  const dir = repo('reuse', PKG);
  const { call } = await connect(t, dir);
  await call('cor_open', { url: `${base}/inventory.html` });
  const a = idOf(await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' }));
  const b = idOf(await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]', framework: 'cypress' }));
  const c = idOf(await call('cor_inspect', { selector: '[data-test="add-to-cart-onesie"]' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(readdirSync(join(dir, '.cor/records')).length, 2);
});
