// U19.4 — a comparison table like BrowserStack's: headers in a separate table,
// full-width group rows, names inside cells alongside prices and descriptions,
// and a hidden copy of the section. Both agents read one cell here by hand
// (and COR's agent wrote a DOM probe for it).
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
  res.end(readFileSync(new URL('./fixtures/compare.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let page;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  page = await session.getPage();
  await page.goto(`${base}/`);
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
const TARGET = 'div[data-product-id="live"] table:nth-of-type(2) tr:nth-child(2) td:nth-child(3)'; // Bug Capture × Team Ultimate

test('headers from the separate header table; names inside cells; group rows skipped', async () => {
  const p = await params(TARGET);
  assert.ok(p?.template, JSON.stringify(p));
  assert.deepEqual([p.row, p.column], ['Bug Capture', 'Team Ultimate']);
  assert.deepEqual(p.columns, ['Feature List', 'Team', 'Team Ultimate', 'Enterprise']);
  assert.deepEqual(p.rows, ['Bug Capture', 'Visual Overlay'], 'rows of the target\'s table; group rows are not rows');
});

test('the hidden copy of the section is kept out by a stable scope, and every cell on the row and column resolves', async () => {
  const p = await params(TARGET);
  assert.match(p.template.playwright.selectorTemplate, /data-product-id='live'|data-product-id="live"/);
  for (const [row, column, want] of [['Bug Capture', 'Team Ultimate', 'img'], ['Bug Capture', 'Enterprise', 'Contact Sales'], ['Visual Overlay', 'Team Ultimate', 'img']]) {
    const loc = page.locator(fill(p, row, column));
    assert.equal(await loc.count(), 1, `${row} / ${column}`);
    const got = await loc.evaluate((el) => (el.querySelector('img') ? 'img' : el.textContent.trim()));
    assert.equal(got, want, `${row} / ${column}`);
  }
  assert.equal(p.counted, p.columns.length + p.rows.length);
});

test('a plain table keeps working as before', async () => {
  await page.setContent('<table class="users"><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ada</td><td>Admin</td></tr><tr><td>Grace</td><td>Viewer</td></tr></tbody></table>');
  const p = await params('table.users tbody tr:nth-child(2) td:nth-child(2)');
  assert.ok(p.template);
  assert.deepEqual([p.row, p.column], ['Grace', 'Role']);
  await page.goto(`${base}/`);
});

test('a row of icons only, headed by a row header, is a row — not the header', async () => {
  const p = await params('div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)');
  assert.ok(p?.template, JSON.stringify(p));
  assert.deepEqual([p.row, p.column], ['Priority Support', 'Enterprise']);
  assert.deepEqual(p.columns, ['Feature List', 'Team', 'Team Ultimate', 'Enterprise']);
});

test('a row header is the key even when an earlier column also names rows uniquely', async () => {
  await page.setContent('<table class="feat"><thead><tr><th>#</th><th>Feature</th><th>Pro</th></tr></thead><tbody>'
    + '<tr><td>1</td><th scope="row">Sync</th><td>Yes</td></tr><tr><td>2</td><th scope="row">Share</th><td>No</td></tr></tbody></table>');
  const p = await params('table.feat tbody tr:nth-child(2) td:nth-child(3)');
  assert.ok(p.template);
  assert.deepEqual([p.row, p.column], ['Share', 'Pro']);
  assert.deepEqual(p.vars, ['feature', 'column']);
  await page.goto(`${base}/`);
});

test('row tables whose row names are plain <th> (no scope) still take the separate header', async () => {
  await page.setContent('<div class="grid"><table class="head"><tr><th>Feature</th><th>Free</th><th>Pro</th></tr></table>'
    + '<table class="rows"><tr><th>Sync</th><td>No</td><td>Yes</td></tr><tr><th>Share</th><td>Yes</td><td>Yes</td></tr></table></div>');
  const p = await params('table.rows tr:nth-child(1) td:nth-child(3)');
  assert.ok(p?.template, JSON.stringify(p));
  assert.deepEqual([p.row, p.column], ['Sync', 'Pro']);
  assert.deepEqual(p.rows, ['Sync', 'Share']);
  await page.goto(`${base}/`);
});
