// U18b.3 — mixed naming: cards named by a heading on some, a label on others,
// with hidden copies of every card. From the BrowserStack comparison: both
// agents hand-wrote the plan-card helper (heading OR label, visible only).
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
import { interpolateTemplate } from '../../client/src/interpolate.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/plans.html', import.meta.url), 'utf8'));
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
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

const params = async (selector) => {
  const p = (await callPage(page, 'inspect', { selector, framework: 'playwright', max: 1 })).params;
  if (p) await verifyTemplate(page, p);
  return p;
};
const run = (code, name, value) => new Function('page', name, `return ${code};`)(page, value);
const registry = (p, v) => interpolateTemplate({ selectorTemplate: p.template.playwright.selectorTemplate, vars: [{ varName: p.param, syntax: p.template.playwright.syntax }] }, { [p.param]: v });

test('cards named by a heading or a label: one template covers both, visible cards only', async () => {
  const p = await params('.grid .card:nth-child(2) button');
  assert.ok(p.template, JSON.stringify(p));
  assert.deepEqual(p.values, ['Team', 'Team Ultimate']);
  assert.equal(p.counted, 2);
  assert.match(p.code, /\.filter\(\{ visible: true \}\)/, 'hidden copies are left out');
  for (const [v, price] of [['Team', '$150 / month'], ['Team Ultimate', '$375 / month']]) {
    const choose = run(p.code, p.param, v);
    assert.equal(await choose.count(), 1, v);
    assert.equal(await page.locator(registry(p, v)).count(), 1, v);
    assert.equal(await choose.evaluate((el) => el.closest('.card').querySelector('.card__price').textContent), price);
  }
});

test('the heading-less card gets the same template', async () => {
  const p = await params('.grid .card:nth-child(1) button');
  assert.deepEqual(p.values, ['Team', 'Team Ultimate']);
  assert.equal(p.value, 'Team');
});

test('without the visible filter the template would be ambiguous — the hidden copy is real', async () => {
  assert.equal(await page.locator('div.card').filter({ has: page.getByText('Team Ultimate', { exact: true }) }).getByRole('button', { name: 'Choose' }).count(), 1, 'getByRole skips hidden');
  assert.equal(await page.locator('div.card:has(h3.card__title:text-is("Team Ultimate")) >> text="Choose"').count(), 2, 'CSS + text count the hidden copy');
});

test('cor_inspect renders it', async () => {
  const out = await call('cor_inspect', { selector: '.grid .card:nth-child(2) button' });
  assert.match(out, /^Recommended — parameterised: 2 items share this shape/m);
  assert.match(out, /\.or\(/);
  assert.match(out, /filter\(\{ visible: true \}\)/);
});

test('a features heading below the controls does not name the card, even when every card has one', async () => {
  const p = await params('.grid .card:nth-child(2) button');
  assert.deepEqual(p.values, ['Team', 'Team Ultimate'], JSON.stringify(p.values));
});
