// P3a: the WebdriverIO renderer (spec §7.2, §8, §10) — idiomatic helper code rendered from the checked template model,
// its proof level from the recorded conformance run, and the readability bar (R2, R4, R1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { renderHelper, idiomsOf } from '../src/idioms/index.js';
import { helperName, plainValue } from '../src/idioms/shared.js';

const FIXTURES = new URL('../scripts/conformance/fixtures/', import.meta.url);
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  try { res.end(readFileSync(new URL(`.${req.url.split('?')[0]}`, FIXTURES), 'utf8')); } catch { res.end('missing'); }
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, { deps } = {}) {
  let cwd;
  if (deps) {
    cwd = mkdtempSync(join(tmpdir(), 'p3a-'));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ devDependencies: deps }));
  }
  const session = createSession({ headless: true, ...(cwd ? { cwd } : {}) });
  t.after(() => session.close());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
}

// A checked model, as params.js hands it over.
const model = (over = {}) => ({
  kind: 'item', param: 'title', item: { css: 'div.card', visible: false }, leaf: { role: 'button', name: 'Choose', css: 'button', aria: true },
  slot: { kind: 'label', sels: ['h3.card__title'], transformed: false }, ...over,
});
const params = (m, over = {}) => ({ model: m, values: ['Team', 'Team Ultimate'], ...over });
const RECORD = { runs: [{ major: 9, version: '9.32.0', idioms: Object.fromEntries(idiomsOf('webdriverio').map((id) => [id, { ok: true }])) }] };

// ── the idiom table ──
test('P3a idiom item.label: the name is matched exactly through tag.class=text, never a substring', () => {
  const out = renderHelper('webdriverio', params(model()), { record: RECORD, major: 9 });
  assert.equal(out.define, ['const card = (title) =>', "  $$('div.card')", '    .find(async (el) => (await el.$(`h3.card__title=${title}`).isExisting()));'].join('\n'));
  assert.deepEqual(out.idioms, ['item.label', 'leaf.aria']);
  assert.equal(out.uses[0], "card(title).$('aria/Choose')");
  assert.doesNotMatch(out.code, /\*=/, 'a substring match is never written');
});

test('P3a idiom item.either + visible filter + variant.click: a heading-or-label pair, shown items only, the toggle click', () => {
  const m = model({ item: { css: 'div.plan', visible: true }, slot: { kind: 'either', sels: ['h3.plan__title', 'label'], transformed: false }, toggle: 'label' });
  const out = renderHelper('webdriverio', params(m, { variantAct: 'x' }), { record: RECORD, major: 9 });
  assert.match(out.define, /^ {2}\$\$\('div\.plan'\)\.filter\(\(el\) => el\.isDisplayed\(\)\)$/m);
  assert.match(out.define, /h3\.plan__title=\$\{title\}`\)\.isExisting\(\)\) \|\|\n {6}\(await el\.\$\(`label=\$\{title\}`\)/);
  assert.deepEqual(out.idioms, ['item.either', 'leaf.aria', 'variant.click']);
  assert.equal(out.uses[1], 'plan(title).$(`label=${title}`).click()');
});

test('P3a idiom item.attribute: a test attribute names the item; hidden copies are filtered by display', () => {
  const m = model({ slot: { kind: 'attribute', attr: 'data-testid' }, param: 'testId', item: { css: 'div.card', visible: true } });
  const out = renderHelper('webdriverio', params(m, { values: ['a', 'b'] }), { record: RECORD, major: 9 });
  assert.equal(out.define, 'const card = (testId) => $$(`div.card[data-testid="${testId}"]`).find((el) => el.isDisplayed());');
  const scoped = renderHelper('webdriverio', params({ ...m, item: { css: 'div.card', visible: false } }, { values: ['a'] }), { record: RECORD, major: 9 });
  assert.equal(scoped.define, 'const card = (testId) => $(`div.card[data-testid="${testId}"]`);');
});

test('P3a idiom leaf.css: a target with no accessible name is reached by the checked CSS', () => {
  const m = model({ leaf: { role: null, name: 'How do I pay?', css: 'p.faq__q', aria: false } });
  const out = renderHelper('webdriverio', params(m), { record: RECORD, major: 9 });
  assert.equal(out.uses[0], "card(title).$('p.faq__q')");
  assert.deepEqual(out.idioms, ['item.label', 'leaf.css']);
});

test('P3a idiom leaf.aria.shown: twins inside the item — the displayed match, never the first', () => {
  const m = model({ leaf: { role: 'button', name: 'Choose', css: null, aria: true, twins: true } });
  const out = renderHelper('webdriverio', params(m), { record: RECORD, major: 9 });
  assert.equal(out.uses[0], "card(title).$$('aria/Choose').find((el) => el.isDisplayed())");
  assert.deepEqual(out.idioms, ['item.label', 'leaf.aria.shown']);
});

test('P3a R3: TypeScript when detected — a type on the helper parameter only', () => {
  const ts = renderHelper('webdriverio', params(model()), { record: RECORD, major: 9, typescript: true });
  assert.match(ts.define, /^const card = \(title: string\) =>/);
  const js = renderHelper('webdriverio', params(model()), { record: RECORD, major: 9 });
  assert.match(js.define, /^const card = \(title\) =>/);
});

// ── R1, R2, R4: what a renderer refuses ──
test('P3a R2: a value that would need escaping inside the selector gets no form, with the reason', () => {
  const out = renderHelper('webdriverio', params(model(), { values: ['Bob\'s "team"', 'Team'] }), { record: RECORD, major: 9 });
  assert.match(out.none, /quote or backtick/);
  assert.equal(plainValue('a`b'), false);
  assert.equal(plainValue('${x}'), false);
  assert.equal(plainValue('Team Pro 2'), true);
});

test('P3a R2: an attribute value with a quote gets no form either — it would end the selector early', () => {
  const m = model({ slot: { kind: 'attribute', attr: 'data-name' }, param: 'name' });
  assert.match(renderHelper('webdriverio', params(m, { values: ['a"b', 'c'] }), { record: RECORD, major: 9 }).none, /data-name value has a quote/);
});

test('P3a R1: a name styled with text-transform gets no WebdriverIO form (getText reports the displayed text)', () => {
  const m = model({ slot: { kind: 'label', sels: ['span.tag'], transformed: true } });
  assert.match(renderHelper('webdriverio', params(m), { record: RECORD, major: 9 }).none, /text-transform/);
});

test('P3a R4: a helper over 8 lines or 120 characters is not offered', () => {
  const wide = model({ item: { css: `div.${'x'.repeat(100)}`, visible: false } });
  assert.match(renderHelper('webdriverio', params(wide), { record: RECORD, major: 9 }).none, /readability bar/);
});

test('P3a R1: a framework with no idiom table, or a kind with no model, falls back with the stated line', () => {
  assert.match(renderHelper('selenium', params(model())).none, /no parameterised selenium form for this shape yet/);
  assert.match(renderHelper('webdriverio', { values: [] }).none, /no parameterised webdriverio form/);
});

test('P3a helperName: from the item selector, camel-cased', () => {
  assert.equal(helperName('div.simplification-card'), 'simplificationCard');
  assert.equal(helperName('li'), 'li');
  assert.equal(helperName('div[data-product-id="live"] div.card'), 'card');
});

// ── §8 / §10: the proof level comes from the recorded run ──
test('P3a §10: L2 only when every idiom used passed conformance on this major; otherwise L3', () => {
  const p = params(model());
  assert.equal(renderHelper('webdriverio', p, { record: RECORD, major: 9 }).level, 'L2');
  assert.equal(renderHelper('webdriverio', p, { record: RECORD, major: '9' }).level, 'L2', 'a detected major is a string');
  assert.equal(renderHelper('webdriverio', p, { record: RECORD, major: 8 }).level, 'L3', 'a different major was not run');
  assert.equal(renderHelper('webdriverio', p, { record: RECORD, major: null }).level, 'L3', 'no version detected');
  assert.equal(renderHelper('webdriverio', p, { record: null, major: 9 }).level, 'L3', 'no record at all');
  const failed = { runs: [{ major: 9, version: '9.32.0', idioms: { ...RECORD.runs[0].idioms, 'leaf.aria': { ok: false } } }] };
  assert.equal(renderHelper('webdriverio', p, { record: failed, major: 9 }).level, 'L3', 'one failing idiom drops the whole helper');
});

test('P3a §10: the committed conformance record covers every idiom in the table on WebdriverIO 9', () => {
  const record = JSON.parse(readFileSync(new URL('../src/idioms/webdriverio.conformance.json', import.meta.url), 'utf8'));
  const run = record.runs.find((r) => r.major === 9);
  assert.ok(run, 'a WebdriverIO 9 run is recorded');
  for (const id of idiomsOf('webdriverio')) assert.equal(run.idioms[id]?.ok, true, `${id} has a passing conformance entry`);
  assert.match(run.date, /^\d{4}-\d{2}-\d{2}$/);
});

// ── through cor_inspect ──
test('P3a: cor_inspect for WebdriverIO leads with the rendered helper, the item check and the conformance label', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-either.html` });
  const out = await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(out, /^ {2}const plan = \(title\) =>$/m);
  assert.match(out, /^ {4}\$\$\('div\.plan'\)\.filter\(\(el\) => el\.isDisplayed\(\)\)$/m);
  assert.match(out, /^ {2}plan\(title\)\.\$\$\('aria\/Choose'\)\.find\(\(el\) => el\.isDisplayed\(\)\)$/m, 'the Team card holds a Choose per toggle state');
  assert.match(out, /^ {2}Proof: rendered from a checked template \(every value checked in the page\); WebdriverIO 9\.32\.0 idioms conformance-tested\.$/m);
  assert.doesNotMatch(out, /XPath:/, 'the helper replaces the raw XPath line');
  assert.match(out, /Variants: "Team Pro" sits behind the "Team" item's toggle — the helper's last line clicks it/);
  assert.match(out, /^ {2}Every item \(2 now\): \$\$\('div\.plan'\)\.filter\(\(el\) => el\.isDisplayed\(\)\)/m);
});

test('P3a: a WebdriverIO 8 project is not told the idioms were tested on 9 — the helper is labelled emulated', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^8.40.0' } });
  await call('cor_open', { url: `${base}/p3a-either.html` });
  const out = await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(out, /^ {2}const plan = /m, 'the helper is still offered');
  assert.match(out, /^ {2}Proof: emulated — not run in WebdriverIO\./m);
  assert.doesNotMatch(out, /conformance-tested\./);
});

test('P3a: Playwright output is not changed by the WebdriverIO renderer', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/p3a-either.html` });
  const pw = await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button', framework: 'playwright' });
  assert.match(pw, /^ {2}Proof: counted by Playwright, every value\.$/m);
  assert.doesNotMatch(pw, /\$\$\(|isDisplayed/);
});

test('P3a R1: a page the renderer declines still shows the checked XPath form, so nothing is lost', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-transformed.html` });
  const out = await call('cor_inspect', { selector: '.row:nth-child(1) button' });
  assert.doesNotMatch(out, /getText|\.find\(async/);
  assert.match(out, /XPath: |Not parameterised/);
});

test('P3a idiom leaf.aria.shown: aria/ finds hidden elements too, so an item holding twin buttons gets the displayed one', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-twin.html` });
  const out = await call('cor_inspect', { selector: '.card:nth-child(2) .primary' });
  assert.match(out, /^ {2}card\(title\)\.\$\$\('aria\/Choose'\)\.find\(\(el\) => el\.isDisplayed\(\)\)$/m);
  assert.doesNotMatch(out, /card\(title\)\.\$\('aria\//, 'never the first match, shown or not');
  assert.doesNotMatch(out, /card\(title\)\.\$\('button\.primary'\)/, 'a class that names one state\'s button is not the leaf');
});

test('P3a leaf: another element answering to the name inside an item rules aria/ out (a heading named like the button)', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-heading-clash.html` });
  const out = await call('cor_inspect', { selector: '.card:nth-child(2) button' });
  assert.match(out, /^ {2}card\(testId\)\.\$\('button'\)$/m);
  assert.doesNotMatch(out, /card\(testId\)\.\$\$?\('aria\//, 'aria/Open would find the heading too');
});

test('P3a leaf: the leaf is checked in every item — a class that only one item carries is not used', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-heading-clash.html` });
  const out = await call('cor_inspect', { selector: '.card:nth-child(2) button' });
  assert.doesNotMatch(out, /card\(testId\)\.\$\('[^']*only-here/);
});

test('P3a leaf: twin buttons and a clashing name leave no honest leaf — the helper finds the item and says nothing about its button', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-twin-clash.html` });
  const out = await call('cor_inspect', { selector: '.card:nth-child(2) button.on' });
  assert.match(out, /^ {2}const card = \(testId\) =>/m, 'the item helper is still offered');
  assert.doesNotMatch(out, /card\(testId\)\.\$/, 'no leaf line: a class would name one toggle state\'s button');
});

// ── P3a.2: control groups ──
const group = (over = {}) => ({ kind: 'group', param: 'billingCycle', role: 'radio', hidden: false, label: null, aria: true, ...over });

test('P3a idiom group.aria: an option by its whole name — the same string for a radio, a tab, a hidden input', () => {
  const out = renderHelper('webdriverio', { model: group(), values: ['Annually', 'Monthly'] }, { record: RECORD, major: 9 });
  assert.equal(out.define, 'const billingCycleOption = (billingCycle) => $(`aria/${billingCycle}`);');
  assert.deepEqual(out.idioms, ['group.aria']);
  assert.equal(out.call, 'billingCycleOption(billingCycle)');
  assert.deepEqual(out.uses, []);
});

test('P3a idiom group.label-click: a hidden input is changed by clicking its label, scoped when the labels share a container', () => {
  const scoped = renderHelper('webdriverio', { model: group({ hidden: true, label: { scope: 'div.toggle' } }), values: ['For Teams', 'For Individuals'] }, { record: RECORD, major: 9 });
  assert.deepEqual(scoped.uses, ['$(\'div.toggle\').$(`label=${billingCycle}`).click()']);
  assert.deepEqual(scoped.idioms, ['group.aria', 'group.label-click']);
  const page = renderHelper('webdriverio', { model: group({ hidden: true, label: { scope: null } }), values: ['a', 'b'] }, { record: RECORD, major: 9 });
  assert.deepEqual(page.uses, ['$(`label=${billingCycle}`).click()']);
});

test('P3a group R1: no form when aria/ would not find exactly one element per name, or the label text is not exact', () => {
  assert.match(renderHelper('webdriverio', { model: group({ aria: false }), values: ['a', 'b'] }, { record: RECORD, major: 9 }).none, /aria\/ would not find exactly one/);
  assert.match(renderHelper('webdriverio', { model: group({ hidden: true, label: null }), values: ['a', 'b'] }, { record: RECORD, major: 9 }).none, /label text does not name exactly one label/);
  assert.match(renderHelper('webdriverio', { model: group(), values: ['a"b', 'c'] }, { record: RECORD, major: 9 }).none, /quote or backtick/);
});

test('P3a group: cor_inspect renders the hidden-toggle helper with its label click and the state note', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-groups.html` });
  const out = await call('cor_inspect', { selector: 'input[value="individuals"]' });
  assert.match(out, /^ {2}const planTypeSelectorOption = \(planTypeSelector\) => \$\(`aria\/\$\{planTypeSelector\}`\);$/m);
  assert.match(out, /^ {2}\$\('div\.toggle'\)\.\$\(`label=\$\{planTypeSelector\}`\)\.click\(\)$/m);
  assert.match(out, /^ {2}The inputs are hidden: the last line clicks their label, as a user does/m);
  assert.match(out, /Proof: rendered from a checked template/);
  assert.doesNotMatch(out, /Every item/, 'a group has no item list');
  assert.doesNotMatch(out, /XPath:|written for Playwright only/);
});

test('P3a group: a tablist gets the aria/ helper and no label line', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-groups.html` });
  const out = await call('cor_inspect', { selector: 'button[role=tab]:nth-of-type(2)' });
  assert.match(out, /^ {2}const productOption = \(product\) => \$\(`aria\/\$\{product\}`\);$/m);
  assert.doesNotMatch(out, /label=/);
});

test('P3a group: a radio whose name carries a changing promo keeps "not parameterised" — aria/ needs the whole name', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-groups.html` });
  const out = await call('cor_inspect', { selector: 'input[name="billing_cycle"][value="monthly"]' });
  assert.doesNotMatch(out, /Option = \(/);
  assert.match(out, /Not parameterised for webdriverio/);
});

test('P3a group: a label text that another label repeats is not clicked by text — no helper rather than a click on the wrong label', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-groups-stray.html` });
  const out = await call('cor_inspect', { selector: 'input[value="b"]' });
  assert.doesNotMatch(out, /label=\$\{/);
  assert.doesNotMatch(out, /const modeOption/);
  assert.match(out, /Not parameterised for webdriverio/);
});

// ── P3a.3: row × column cells ──
test('P3a idiom cell.xpath: the rendered helper builds the very XPath the checked template holds, for every combination', async (t) => {
  const { callPage } = await import('../src/page-runtime.js');
  const { verifyTemplate } = await import('../src/tools/inspect.js');
  const session = createSession({ headless: true });
  t.after(() => session.close());
  const page = await session.getPage();
  await page.goto(`${base}/p3a-compare.html`);
  const result = await callPage(page, 'inspect', { selector: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)', framework: 'webdriverio', max: 6 });
  await verifyTemplate(page, result.params);
  const p = result.params;
  const out = renderHelper('webdriverio', p, { record: RECORD, major: 9 });
  assert.deepEqual(out.idioms, ['cell.xpath']);
  const cell = new Function('$', `${out.define}\nreturn cell;`)((selector) => selector);
  const [rv, cv] = p.vars;
  let n = 0;
  for (const [row, col] of [...p.columns.map((c) => [p.row, c]), ...p.rows.map((r) => [r, p.column])]) {
    const expected = p.template.xpath.selectorTemplate.replace(`__${rv}__`, `"${row}"`).replace(`__${cv}__`, `"${col}"`);
    // the readable helper writes `) + 1`; the registry string `)+1` — the same XPath
    assert.equal(cell(row, col).replace(/\s*\+\s*1\]$/, '+1]'), expected, `${row} × ${col}`);
    n++;
  }
  assert.ok(n >= 4, 'several combinations were compared');
});

test('P3a idiom cell.xpath: a name with a quote gets no form; TypeScript types both parameters', () => {
  const m = { kind: 'cell', vars: ['feature', 'plan'], tables: '//table', headerExpr: '`(${tables}//tr[th])[1]`', k: 1, rowPart: false, colPart: false, inner: '' };
  const p = { model: m, rows: ['a', 'b'], columns: ['x', 'y'] };
  assert.match(renderHelper('webdriverio', { ...p, rows: ['it\'s', 'b'] }, { record: RECORD, major: 9 }).none, /quote or backtick/);
  const ts = renderHelper('webdriverio', p, { record: RECORD, major: 9, typescript: true });
  assert.match(ts.define, /^const cell = \(feature: string, plan: string\) => \{$/m);
  assert.equal(renderHelper('webdriverio', p, { record: RECORD, major: 9 }).define.split('\n').length, 7);
});

test('P3a cell: cor_inspect for WebdriverIO renders the cell helper and no registry line', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-compare.html` });
  const out = await call('cor_inspect', { selector: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)' });
  assert.match(out, /^ {2}const cell = \(featureList, column\) => \{$/m);
  assert.match(out, /^ {4}return \$\(`\$\{row\}\/\*\[\$\{columnNo\}\]`\);$/m);
  assert.match(out, /Proof: rendered from a checked template/);
  assert.doesNotMatch(out, /Registry template|XPath: /);
});

test('P3a group: aria/ takes any role, so a name another control answers to gives no helper (Playwright\'s role-exact form is unaffected)', async (t) => {
  const call = await connect(t, { deps: { webdriverio: '^9.32.0' } });
  await call('cor_open', { url: `${base}/p3a-groups-clash.html` });
  const wd = await call('cor_inspect', { selector: 'input[value="b"]' });
  assert.doesNotMatch(wd, /const modeOption/);
  assert.match(wd, /Not parameterised for webdriverio/);
  const pw = await call('cor_inspect', { selector: 'input[value="b"]', framework: 'playwright' });
  assert.match(pw, /Recommended — parameterised: 2 options in this radio group/);
});

test('P3a R3: TypeScript types the group helper\'s parameter too', () => {
  const out = renderHelper('webdriverio', { model: group(), values: ['a', 'b'] }, { record: RECORD, major: 9, typescript: true });
  assert.equal(out.define, 'const billingCycleOption = (billingCycle: string) => $(`aria/${billingCycle}`);');
});
