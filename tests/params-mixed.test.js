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
  assert.equal(p.counted, 3, 'the two names plus the Team Pro variant (U18b.5)');
  assert.match(p.code, /div\[data-product-id="live"\] div\.card|\.filter\(\{ visible: true \}\)/, 'hidden copies are left out — by a stable scope (U19.2) or visibility');
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
  assert.match(out, /div\[data-product-id="live"\] div\.card|filter\(\{ visible: true \}\)/);
});

test('a features heading below the controls does not name the card, even when every card has one', async () => {
  const p = await params('.grid .card:nth-child(2) button');
  assert.deepEqual(p.values, ['Team', 'Team Ultimate'], JSON.stringify(p.values));
});

// U18b.5 — toggled variants. Team Pro lives behind a toggle in the Team card:
// the Playwright agent had to discover it; the COR agent never tested it.
test('a card whose name is a toggle label lists its other labels as variants, and says to click first', async () => {
  const p = await params('.grid .card:nth-child(1) button');
  assert.deepEqual(p.variants, [{ of: 'Team', values: ['Team Pro'] }]);
  assert.equal(p.counted, 3, 'Team, Team Ultimate and the variant Team Pro each counted by Playwright');
  // The template finds the same card by the variant's name…
  assert.equal(await run(p.code, p.param, 'Team Pro').count(), 1);
  // …but its content is the variant's only after the click the note asks for.
  await page.getByText('Team Pro', { exact: true }).click();
  assert.equal(await run(p.code, p.param, 'Team Pro').evaluate((el) => el.closest('.card').querySelector('.card__price:not([hidden])').textContent), '$200 / month');
  await page.getByText('Team', { exact: true }).click();
  assert.equal(await run(p.code, p.param, 'Team').evaluate((el) => el.closest('.card').querySelector('.card__price:not([hidden])').textContent), '$150 / month');
});

test('cor_inspect says how to reach a variant', async () => {
  const out = await call('cor_inspect', { selector: '.grid .card:nth-child(2) button' });
  assert.match(out, /\(3\/3, variants included\)/);
  // U21: one toggle action taking the name, not a literal click.
  assert.match(out, /Variants: "Team Pro" sits behind the "Team" item's toggle\. Show a variant: page\.locator\('div\[data-product-id="live"\] div\.card'\)\.locator\('label'\)\.getByText\(title, \{ exact: true \}\)\.click\(\) — one action taking title\. Then the template finds its item\./);
});

test('a card without a toggle has no variants', async () => {
  const p = await params('.grid .card:nth-child(2) button');
  assert.ok(p.variants.every((v) => v.of !== 'Team Ultimate'));
});

test('a variant name that another card also shows is left out — the template itself stays', async () => {
  await page.evaluate(() => document.querySelector('.grid').insertAdjacentHTML('beforeend',
    '<div class="card" id="extra"><h3 class="card__title">Enterprise</h3><label>Team Pro</label><button>Contact Sales</button></div>'));
  try {
    const p = await params('.grid .card:nth-child(1) button');
    assert.ok(p.template, 'the template survives');
    assert.deepEqual(p.variants, [], '"Team Pro" now names two cards, so it is not offered as a variant');
  } finally {
    await page.evaluate(() => document.getElementById('extra').remove());
  }
});

test('BrowserStack\'s shape: the name is a span inside the toggle label — variants still found', async () => {
  await page.evaluate(() => {
    // As on BrowserStack: the label wraps the hidden input and a block-level span holding the name.
    for (const l of document.querySelectorAll('.grid .card:nth-child(1) label')) {
      const input = document.getElementById(l.htmlFor);
      l.removeAttribute('for');
      l.innerHTML = `<span class="card-toggle__label" style="display:block">${l.textContent}</span>`;
      l.prepend(input);
    }
  });
  try {
    const p = await params('.grid .card:nth-child(1) button');
    assert.deepEqual(p.variants, [{ of: 'Team', values: ['Team Pro'] }], JSON.stringify(p.variants));
  } finally {
    await call('cor_open', { url: `${base}/` });
    page = await session.getPage();
  }
});

// ── U19.2: a stable scope before visible: true ──────────────────────────────
// The owner's page-object run: the Playwright agent scoped cards by an
// attribute; COR's template used `filter({ visible: true })`, which means
// "whichever copy is showing". BrowserStack separates its copies by product:
// `data-product-id="live"`.
test('hidden copies separated by a stable ancestor attribute: the template scopes by it, not by visibility', async () => {
  const p = await params('.grid .card:nth-child(2) button');
  assert.ok(p.template, JSON.stringify(p));
  assert.match(p.code, /div\[data-product-id="live"\] div\.card/);
  assert.doesNotMatch(p.code, /visible: true/);
  assert.doesNotMatch(p.template.playwright.selectorTemplate, /:visible/);
  assert.doesNotMatch(p.code, /data-plan-type-visible/, 'a state-like attribute is never the scope');
  for (const v of ['Team', 'Team Ultimate']) assert.equal(await page.locator(registry(p, v)).count(), 1, v);
});

test('without such an attribute the template falls back to visible: true', async () => {
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-product-id]')) el.removeAttribute('data-product-id'); });
  try {
    const p = await params('.grid .card:nth-child(2) button');
    assert.match(p.code, /\.filter\(\{ visible: true \}\)/);
  } finally {
    await call('cor_open', { url: `${base}/` });
    page = await session.getPage();
  }
});

test('cor_grade suggests the stable scope for an agent\'s visible: true chain', async () => {
  const out = await call('cor_grade', { selector: "page.locator('div.card').filter({ visible: true }).filter({ has: page.getByRole('heading', { name: 'Team Ultimate', exact: true }) }).getByRole('button', { name: 'Choose' })" });
  assert.match(out, /! prefer the scope div\[data-product-id="live"\] over filter\(\{ visible: true \}\)/);
});

test('a scope that would also hold a hidden copy is not used — the template falls back to visible: true', async () => {
  await page.evaluate(() => document.querySelector('.grid').insertAdjacentHTML('beforeend',
    '<div class="card" id="ghost" style="display:none"><h3 class="card__title">Team Ultimate</h3><button>Choose</button></div>'));
  try {
    const p = await params('.grid .card:nth-child(2) button');
    assert.ok(p.template, JSON.stringify(p));
    assert.doesNotMatch(p.code, /data-product-id/);
    assert.match(p.code, /\.filter\(\{ visible: true \}\)/);
  } finally {
    await page.evaluate(() => document.getElementById('ghost').remove());
  }
});
