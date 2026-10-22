// U3 (D7) — counting and grading use the project's Playwright testIdAttribute. On saucedemo
// `getByTestId('inventory-item')` graded 0 matches on a page full of data-test="inventory-item",
// because nothing read playwright.config and Playwright's default is data-testid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { detectFramework, frameworkLine, readTestIdAttribute } from '../src/detect.js';

const root = mkdtempSync(join(tmpdir(), 'cor-u3-'));
after(() => rmSync(root, { recursive: true, force: true }));
function project(name, files) {
  const dir = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const PW = { 'package.json': { name: 'x', devDependencies: { '@playwright/test': '^1.55.0' } } };
const config = (body) => `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ use: { ${body} } });\n`;

// ── reading the config ──
test('U3 readTestIdAttribute: a literal is read; a computed value is reported, not guessed; no mention is null', () => {
  assert.deepEqual(readTestIdAttribute(project('lit', { 'playwright.config.ts': config("testIdAttribute: 'data-test'") })), { value: 'data-test', file: 'playwright.config.ts', readable: true });
  assert.deepEqual(readTestIdAttribute(project('var', { 'playwright.config.js': config('testIdAttribute: process.env.TID') })), { value: null, file: 'playwright.config.js', readable: false });
  assert.equal(readTestIdAttribute(project('none', { 'playwright.config.ts': config("baseURL: 'http://x'") })), null);
  assert.equal(readTestIdAttribute(project('nofile', {})), null);
});

test('U3 frameworkLine says which attribute getByTestId reads, or that it could not be read', () => {
  assert.match(frameworkLine(detectFramework(project('l1', { ...PW, 'playwright.config.ts': config('testIdAttribute: "data-test"') }))), / getByTestId reads data-test \(playwright\.config\.ts\)\.$/);
  assert.match(frameworkLine(detectFramework(project('l2', { ...PW, 'playwright.config.ts': config('testIdAttribute: attr') }))), /testIdAttribute in playwright\.config\.ts is not a plain string — not read/);
  assert.doesNotMatch(frameworkLine(detectFramework(project('l3', PW))), /getByTestId/);
});

// ── through the server ──
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/data-test.html', import.meta.url)));
});
let base;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, cwd) {
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
}

test('U3 (AE7) configured data-test: getByTestId counts the items, and inspect renders getByTestId', async (t) => {
  const call = await connect(t, project('e2e-on', { ...PW, 'playwright.config.ts': config("testIdAttribute: 'data-test'") }));
  assert.match(await call('cor_open', { url: base }), /getByTestId reads data-test/);
  const graded = await call('cor_grade', { selector: "page.getByTestId('inventory-item')" });
  assert.match(graded, /3 matches/, graded);
  assert.doesNotMatch(graded, /getByTestId reads/);
  const badge = await call('cor_grade', { selector: "page.getByTestId('shopping-cart-badge')" });
  assert.match(badge, /^Healthy/, badge);
  const inspected = await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' });
  assert.match(inspected, /page\.getByTestId\('shopping-cart-badge'\)/, inspected);
});

test('U3 no config: getByTestId finds nothing and the reply says which attribute the page uses', async (t) => {
  const call = await connect(t, project('e2e-off', PW));
  await call('cor_open', { url: base });
  const graded = await call('cor_grade', { selector: "page.getByTestId('inventory-item')" });
  assert.match(graded, /^Broken/, graded);
  assert.match(graded, /getByTestId reads data-testid; this page carries "inventory-item" on data-test\. Set testIdAttribute: 'data-test' in playwright\.config/);
  const inspected = await call('cor_inspect', { selector: '[data-test="shopping-cart-badge"]' });
  assert.match(inspected, /page\.locator\('\[data-test="shopping-cart-badge"\]'\)/, inspected);
});

test('U3 a session without config resets the attribute another session set (Playwright selectors are process-wide)', async (t) => {
  const on = await connect(t, project('e2e-a', { ...PW, 'playwright.config.ts': config("testIdAttribute: 'data-test'") }));
  await on('cor_open', { url: base });
  const off = await connect(t, project('e2e-b', PW));
  await off('cor_open', { url: base });
  assert.match(await off('cor_grade', { selector: "page.getByTestId('shopping-cart-badge')" }), /^Broken/);
});
