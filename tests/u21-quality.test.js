// U21 — locator quality from an SDET's view, after the plain-prompt run
// (cdce0474, 2026-09-26). COR's suite was the more stable one, but a reviewer
// would still flag four things in what COR handed the agent:
// 1. the row × column cell locator: a 300-character XPath no one can review,
//    with the header row pinned to its width (count(th)=5);
// 2. the Team Pro toggle: the agent wrote selectTeamPro() with the name typed
//    in, because the Variants line only offered a literal click;
// 3. the plan-type switch: page.getByText(type), unscoped — marketing copy
//    with the same words breaks it;
// 4. inner locators by class where a role exists (h3.card__title → heading).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { verifyTemplate } from '../src/tools/inspect.js';
import { renderInspect } from '../src/format.js';

let base;
const site = createHttpServer((req, res) => {
  if (!/^\/[\w-]+$/.test(req.url)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL(`./fixtures/${req.url.slice(1)}.html`, import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let page;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  page = await session.getPage();
});

const inspect = async (fixture, selector) => {
  await page.goto(`${base}/${fixture}`);
  const result = await callPage(page, 'inspect', { selector, framework: 'playwright', max: 3 });
  await verifyTemplate(page, result.params);
  return result;
};
// The code as the agent copies it, run with the parameter(s) filled in.
const run = (code, names, ...values) => new Function('page', ...names, `return ${code};`)(page, ...values);

// ── 1. a readable cell helper, not pinned to the header's width ────────────
const CELL = 'div[data-product-id="live"] table:nth-of-type(2) tr:nth-child(2) td:nth-child(3)'; // Bug Capture × Team Ultimate

test('1. the cell locator is a helper built from named parts, and each combination finds its cell', async () => {
  const { params: p } = await inspect('compare', CELL);
  assert.ok(p?.template, JSON.stringify(p));
  assert.match(p.code, /const tables = /);
  assert.match(p.code, /const header = /);
  assert.match(p.code, /const columnNo = /);
  assert.ok(p.code.split('\n').every((l) => l.length <= 160), `a line over 160 characters:\n${p.code}`);
  const cell = run(p.code, []);
  for (const [row, column] of [['Bug Capture', 'Team Ultimate'], ['Visual Overlay', 'Enterprise'], ['Bug Capture', 'Feature List']]) {
    assert.equal(await cell(row, column).count(), 1, `${row} / ${column}`);
  }
  assert.equal(await cell('Bug Capture', 'Team Ultimate').locator('img').count(), 1);
});

test('1. the header row is not pinned to its width: a plan column added later still finds the cell', async () => {
  const { params: p } = await inspect('compare', CELL);
  assert.doesNotMatch(p.template.xpath.selectorTemplate, /count\(th\)=\d/);
  await page.evaluate(() => {
    for (const t of document.querySelectorAll('div[data-product-id="live"] table')) {
      for (const r of t.rows) r.cells[1]?.insertAdjacentHTML('beforebegin', r.querySelector('th[scope="col"]') ? '<th scope="col"><h3 class="plan">Starter</h3></th>' : r.cells.length > 1 ? '<td>—</td>' : '');
    }
  });
  const cell = run(p.code, []);
  assert.equal(await cell('Bug Capture', 'Team Ultimate').locator('img').count(), 1);
  assert.equal(await cell('Bug Capture', 'Starter').textContent(), '—');
});

test('1. cor_inspect shows the helper under a name the agent can paste', async () => {
  const result = await inspect('compare', CELL);
  const out = renderInspect(result, { framework: 'playwright' });
  assert.match(out, /^ {2}const cell = \(featureList, column\) => \{$/m, out);
});

test('1. a title row above the header in the header table is skipped', async () => {
  await page.goto(`${base}/compare`);
  await page.evaluate(() => document.querySelector('div[data-product-id="live"] thead').insertAdjacentHTML('afterbegin', '<tr><th colspan="4">Compare plans</th></tr>'));
  const result = await callPage(page, 'inspect', { selector: CELL, framework: 'playwright', max: 3 });
  await verifyTemplate(page, result.params);
  assert.ok(result.params.template, JSON.stringify(result.params));
  assert.equal(await run(result.params.code, [])('Bug Capture', 'Enterprise').textContent(), 'Contact Sales');
});

// ── 2. a parameterised variant toggle ──────────────────────────────────────
test('2. a Variants line gives one toggle action taking the name, and it shows each variant', async () => {
  const { params: p } = await inspect('plans', '.grid .card:nth-child(2) button');
  assert.ok(p.variantAct, JSON.stringify(p));
  assert.match(p.variantAct, /getByText\(title, \{ exact: true \}\)$/);
  assert.equal(await run(p.variantAct, ['title'], 'Team Pro').count(), 1);
  await run(p.variantAct, ['title'], 'Team Pro').click();
  assert.equal(await page.locator('#t2').isChecked(), true);
  await run(p.variantAct, ['title'], 'Team').click();
  assert.equal(await page.locator('#t1').isChecked(), true);
  const out = renderInspect({ params: p, locators: [], framework: 'playwright' }, { framework: 'playwright' });
  assert.match(out, /Variants: "Team Pro" sits behind the "Team" item's toggle\. Show a variant: .*getByText\(title, \{ exact: true \}\)\.click\(\) — one action taking title\./, out);
});

// ── 3. a scoped click for a hidden control group ───────────────────────────
test('3. the act form for a hidden toggle group is scoped to the group, so copy elsewhere does not break it', async () => {
  const { params: p } = await inspect('control-groups', '#pt2');
  assert.match(p.act, /^page\.locator\('div\.toggle'\)\.getByText\(planTypeSelector, \{ exact: true \}\)$/, p.act);
  for (const v of ['For Teams', 'For Individuals']) assert.equal(await run(p.act, ['planTypeSelector'], v).count(), 1, v);
  await run(p.act, ['planTypeSelector'], 'For Individuals').click();
  assert.equal(await page.locator('#pt2').isChecked(), true);
});

test('3. a group with no container to scope by keeps the page-wide form', async () => {
  await page.goto(`${base}/control-groups`);
  await page.evaluate(() => {
    // Unwrap the toggle so no shared container names it.
    const box = document.querySelector('div.toggle');
    for (const i of box.querySelectorAll('input')) i.style.cssText = 'position:absolute;opacity:0;width:0;height:0';
    box.replaceWith(...box.childNodes);
    document.querySelector('p.promo').remove();
  });
  const result = await callPage(page, 'inspect', { selector: '#pt2', framework: 'playwright', max: 3 });
  await verifyTemplate(page, result.params);
  assert.match(result.params.act, /^page\.getByText\(planTypeSelector, \{ exact: true \}\)$/);
});

test('3. a click that does not single the option out is not offered, and the output says why', async () => {
  await page.goto(`${base}/control-groups`);
  // Another toggle, in the same kind of container, also says "For Teams": the
  // scoped click matches two, and a page-wide one can only match more.
  await page.evaluate(() => { document.querySelector('p.promo').remove(); document.body.insertAdjacentHTML('beforeend', '<div class="toggle"><span>For Teams</span></div>'); });
  const result = await callPage(page, 'inspect', { selector: '#pt2', framework: 'playwright', max: 3 });
  await verifyTemplate(page, result.params);
  assert.equal(result.params.act, undefined);
  assert.match(result.params.actReason, /the label text "For Teams" matched 2 elements/);
  const out = renderInspect({ ...result, framework: 'playwright' }, { framework: 'playwright' });
  assert.match(out, /change it: click the option's label, scoped by hand to the toggle — the label text "For Teams" matched 2 elements for the click, so no text click is offered/, out);
  // …and not the page-wide single-item note, whose getByText would be just as ambiguous.
  assert.doesNotMatch(out, /Hidden input, operated through its visible label/);
});

// ── 4. a role where one exists ─────────────────────────────────────────────
test('4. an item named by a heading is filtered by the heading role, not its class', async () => {
  const { params: p } = await inspect('plans', '.grid .card:nth-child(2) button');
  assert.match(p.code, /page\.getByRole\('heading', \{ name: title, exact: true \}\)/, p.code);
  assert.doesNotMatch(p.code, /h3\.card__title/);
  for (const v of ['Team', 'Team Ultimate']) assert.equal(await run(p.code, ['title'], v).count(), 1, v);
});

test('4. a heading hidden from the accessibility tree keeps the class form', async () => {
  await page.goto(`${base}/plans`);
  await page.evaluate(() => { for (const h of document.querySelectorAll('h3.card__title')) h.setAttribute('aria-hidden', 'true'); });
  const result = await callPage(page, 'inspect', { selector: '.grid .card:nth-child(2) button', framework: 'playwright', max: 3 });
  await verifyTemplate(page, result.params);
  assert.match(result.params.code, /page\.locator\('h3\.card__title'\)\.getByText\(title, \{ exact: true \}\)/, result.params.code);
});

test('the code the agent copies is counted by Playwright for every value; a form that misses is withdrawn', async () => {
  const { params: p } = await inspect('plans', '.grid .card:nth-child(2) button');
  assert.equal(p.codeCounted, p.values.length + (p.variants ?? []).flatMap((v) => v.values).length);
  const broken = { ...p, template: { ...p.template }, code: p.code.replace("'Choose'", "'Buy'") };
  await verifyTemplate(page, broken);
  assert.equal(broken.template, undefined);
  assert.match(broken.reason, /the code form matched 0/);
});
