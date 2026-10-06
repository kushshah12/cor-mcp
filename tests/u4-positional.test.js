// U4 (D2, D6) — grading never passes a positional pick over duplicates, and never rewrites an option key.
// On saucedemo `getByRole('button', { name: 'Add to cart' }).first()` graded "Healthy · 79 Good" over 6
// identical buttons, and `param: "name"` turned `{ name: 'Add to cart' }` into `{ 'Sauce Labs Backpack': … }`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { parseGradable, substituteParam } from '../src/grade-parse.js';

// ── D6: substitution touches values only ──
test('U4 substituteParam: an option key named like the parameter is left alone (D6)', () => {
  const src = "page.getByText(name, { exact: true }).getByRole('button', { name: 'Add to cart' })";
  assert.equal(substituteParam(src, 'name', 'Backpack'), "page.getByText('Backpack', { exact: true }).getByRole('button', { name: 'Add to cart' })");
  assert.equal(substituteParam('page.getByRole(\'button\', { name })', 'name', 'Save'), "page.getByRole('button', { name: 'Save' })", 'shorthand still expands');
  assert.equal(substituteParam("page.getByText('name: x')", 'name', 'y'), "page.getByText('name: x')", 'inside a string: untouched');
  assert.equal(substituteParam('page.getByText(name).filter({ hasText: name })', 'name', 'z'), "page.getByText('z').filter({ hasText: 'z' })");
});

// ── D2: positional steps are found in every form ──
test('U4 parseGradable names each positional step and the chain before it', () => {
  for (const [src, code] of [
    ["page.getByRole('button', { name: 'Add' }).first()", 'first()'],
    ["page.locator('.item').nth(0).locator('button')", 'nth(0)'],
    ["page.locator('.item').last()", 'last()'],
    ['.item button >> nth=1', 'nth=1'],
    ["cy.get('.item button').eq(2)", 'eq(2)'],
    ["cy.get('.item').find('button').first()", 'first()'],
    ["$$('.item button')[0]", '[0]'],
  ]) {
    const parsed = parseGradable(src);
    assert.equal(parsed.positional?.length, 1, src);
    assert.equal(parsed.positional[0].code, code, src);
    assert.equal(typeof parsed.positional[0].prefix, 'function', src);
  }
  assert.equal(parseGradable("page.getByRole('button', { name: 'Add' })").positional, undefined);
});

// ── through the server ──
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/data-test.html', import.meta.url)));
});
const session = createSession({ headless: true });
let call;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `http://127.0.0.1:${site.address().port}` });
});
after(() => { site.closeAllConnections?.(); site.close(); return session.close(); });

test('U4 (AE5) .first() over 3 lookalikes is Positional, with the unique alternative', async () => {
  const out = await call('cor_grade', { selector: "page.getByRole('button', { name: 'Add to cart' }).first()" });
  assert.match(out, /^Positional — \.first\(\) picks one of 3 matches by position/, out);
  assert.doesNotMatch(out, /Healthy/);
  assert.match(out, /Unique alternative for the same element \(playwright\):\n {2}page\.locator\('\[data-test="add-to-cart-backpack"\]'\)/, out);
});

test('U4 every positional form fails the same way: nth, last, >> nth=, Cypress eq/first, WebdriverIO [n]', async () => {
  for (const [selector, step] of [
    ["page.locator('[data-test=\"inventory-item\"]').nth(1).locator('button')", 'nth(1)'],
    ["page.getByRole('button', { name: 'Add to cart' }).last()", 'last()'],
    ['[data-test="inventory-item"] button >> nth=0', 'nth=0'],
    ["cy.get('[data-test=\"inventory-item\"] button').eq(0)", 'eq(0)'],
    ["cy.get('[data-test=\"inventory-item\"]').find('button').first()", 'first()'],
    ["$$('[data-test=\"inventory-item\"] button')[2]", '[2]'],
  ]) {
    const out = await call('cor_grade', { selector });
    assert.match(out, new RegExp(`^Positional — \\.?${step.replace(/[()[\]]/g, '\\$&')} picks one of 3 matches by position`), `${selector}\n${out}`);
  }
});

test('U4 a positional step over a chain that is already unique is not a failure', async () => {
  const out = await call('cor_grade', { selector: "page.locator('[data-test=\"shopping-cart-badge\"]').first()" });
  assert.doesNotMatch(out, /^Positional/, out);
  assert.match(out, /picks by position/, 'the note stays');
});

test('U4 (AE6) param "name" grades like param "title": the option key is untouched (D6)', async () => {
  const sel = (p) => `page.locator('[data-test="inventory-item"]').filter({ has: page.getByText(${p}, { exact: true }) }).getByRole('button', { name: 'Add to cart' })`;
  const byName = await call('cor_grade', { selector: sel('name'), param: 'name' });
  const byTitle = await call('cor_grade', { selector: sel('title'), param: 'title' });
  assert.match(byName, /Works for 3 of 3 items\./);
  assert.match(byName, /Durability, graded on name = "Backpack":\nHealthy/, byName);
  assert.doesNotMatch(byName, /'Backpack': 'Add to cart'/);
  assert.equal(byName.replaceAll('name', 'title'), byTitle.replaceAll('name', 'title'));
});
