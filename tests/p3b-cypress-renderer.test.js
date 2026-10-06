// P3b: the Cypress renderer (spec §7.2, §8, §10) — idiomatic helper code rendered from the checked template model: the anchored
// regex name (never a substring), the shown-twin leaf, Testing Library when installed, no cy.xpath, and the proof level from
// the recorded conformance run.
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
    cwd = mkdtempSync(join(tmpdir(), 'p3b-'));
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
  return async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
}

const model = (over = {}) => ({
  kind: 'item', param: 'title', item: { css: 'div.card', visible: false }, leaf: { role: 'button', name: 'Choose', css: 'button', aria: true, cy: { css: 'input[value="Choose"]', shown: false } },
  slot: { kind: 'label', sels: ['h3.card__title'], transformed: false }, ...over,
});
const params = (m, over = {}) => ({ model: m, values: ['Team', 'Team Ultimate'], ...over });
const RECORD = { runs: [{ major: 16, version: '16.1.1', idioms: Object.fromEntries(idiomsOf('cypress').map((id) => [id, { ok: true }])) }] };
const cy = (p, o = {}) => renderHelper('cypress', p, { record: RECORD, major: 16, ...o });

test('P3b idiom item.label: the name is an anchored regex through escapeRegExp — never a substring contains', () => {
  const out = cy(params(model()));
  assert.equal(out.define, [
    'const card = (title) =>',
    "  cy.get('div.card')",
    "    .contains('h3.card__title', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(title)}\\\\s*$`))",
    "    .closest('div.card');",
  ].join('\n'));
  assert.doesNotMatch(out.code, /contains\('[^']*', title\)/);
  assert.doesNotMatch(out.code, /xpath/);
  assert.deepEqual(out.idioms, ['item.label', 'leaf.css']);
  assert.equal(out.uses[0], "card(title).find('input[value=\"Choose\"]')");
});

test('P3b idiom item.either + visible filter + variant.click: one selector list, shown items, the toggle click', () => {
  const m = model({ item: { css: 'div.plan', visible: true }, slot: { kind: 'either', sels: ['h3.t', 'label'], transformed: false }, toggle: 'label' });
  const out = cy(params(m, { variantAct: 'x' }));
  assert.match(out.define, /^ {2}cy\.get\('div\.plan'\)\.filter\(':visible'\)$/m);
  assert.match(out.define, /\.contains\('h3\.t, label', new RegExp/);
  assert.equal(out.uses.at(-1), [
    'plan(title)',
    "  .contains('label', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(title)}\\\\s*$`))",
    '  .click()',
    "  .closest('label').then(($label) => cy.wrap($label[0].control)).should('be.checked')",
  ].join('\n'));
  assert.deepEqual(out.idioms, ['item.either', 'leaf.css', 'variant.click']);
});

test('P3b idiom item.attribute: a test attribute names the item; hidden copies are filtered by :visible', () => {
  const m = model({ slot: { kind: 'attribute', attr: 'data-testid' }, param: 'testId', item: { css: 'div.card', visible: true } });
  assert.equal(cy(params(m, { values: ['a', 'b'] })).define, "const card = (testId) => cy.get(`div.card[data-testid=\"${testId}\"]`).filter(':visible');");
});

test('P3b idiom leaf.css.shown: twins inside the item — the CSS that matches them all, then the shown one', () => {
  const m = model({ leaf: { role: 'button', name: 'Choose', css: null, aria: true, twins: true, cy: { css: 'button', shown: true } } });
  const out = cy(params(m));
  assert.equal(out.uses[0], "card(title).find('button').filter(':visible')");
  assert.deepEqual(out.idioms, ['item.label', 'leaf.css.shown']);
});

test('P3b idiom leaf.role: Testing Library\'s findByRole when the project has it and the target has a role and name', () => {
  const out = cy(params(model()), { testingLibrary: true });
  assert.equal(out.uses[0], "card(title).findByRole('button', { name: 'Choose' })");
  assert.deepEqual(out.idioms, ['item.label', 'leaf.role']);
  assert.equal(cy(params(model())).idioms[1], 'leaf.css', 'without Testing Library the CSS leaf');
});

test('P3b R2/R3/R4/R1', () => {
  assert.match(cy(params(model({ slot: { kind: 'attribute', attr: 'data-x' } }), { values: ['a"b'] })).none, /quote or backtick/);
  assert.match(cy(params(model()), { typescript: true }).define, /^const card = \(title: string\) =>/);
  assert.match(cy(params(model({ item: { css: `div.${'x'.repeat(100)}`, visible: false } }))).none, /readability bar/);
  assert.match(cy({ model: { kind: 'group', cy: null }, values: [] }).none, /no label or text names exactly one element/);
  assert.match(cy({ model: { kind: 'other' }, values: [] }).none, /no parameterised Cypress form for a other yet/);
});

test('P3b §10: L2 only when every idiom used passed on this Cypress major; otherwise L3', () => {
  const p = params(model());
  assert.equal(cy(p).level, 'L2');
  assert.equal(cy(p, { major: '16' }).level, 'L2');
  assert.equal(cy(p, { major: 15 }).level, 'L3', 'Cypress 15 was not run');
  assert.equal(cy(p, { major: null }).level, 'L3');
  assert.equal(cy(p, { record: null }).level, 'L3');
});

test('P3b §10: the committed record covers every Cypress idiom on 16', () => {
  const record = JSON.parse(readFileSync(new URL('../src/idioms/cypress.conformance.json', import.meta.url), 'utf8'));
  const run = record.runs.find((r) => r.major === 16);
  assert.ok(run);
  for (const id of idiomsOf('cypress')) if (id !== 'leaf.role') assert.equal(run.idioms[id]?.ok, true, id);
});

test('P3b: cor_inspect for Cypress leads with the helper, its proof line, no XPath line', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3a-either.html` });
  const out = await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(out, /^ {2}const plan = \(title\) =>$/m);
  assert.ok(out.includes(".contains('h3.plan__title, label', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(title)}\\\\s*$`))"), 'the anchored regex');
  assert.match(out, /^ {2}plan\(title\)\.find\('button'\)\.filter\(':visible'\)$/m);
  assert.match(out, /Proof: rendered from a checked template \(every value checked in the page\); Cypress 16\.1\.1 idioms conformance-tested\./);
  assert.match(out, /Variants: "Team Pro" sits behind the "Team" item's toggle — the helper's last line clicks it/);
  assert.match(out, /^ {2}Every item \(2 now\): cy\.get\('div\.plan'\)\.filter\(':visible'\)/m);
  // the engine's own alternatives may still list a cy.xpath candidate (its generic template, not in P3b's scope): the helper block never does
  assert.doesNotMatch(out.split('\n\n')[0], /XPath:|cy\.xpath/);
});

test('P3b: Cypress 15 is labelled emulated; Testing Library switches the leaf to findByRole', async (t) => {
  const c15 = await connect(t, { deps: { cypress: '^15.0.0' } });
  await c15('cor_open', { url: `${base}/p3a-attribute.html` });
  const out15 = await c15('cor_inspect', { selector: '[data-testid="sku-beta"] button' });
  assert.match(out15, /^ {2}Proof: emulated — not run in Cypress\./m);
  const tl = await connect(t, { deps: { cypress: '^16.1.0', '@testing-library/cypress': '^10.0.0' } });
  await tl('cor_open', { url: `${base}/p3a-attribute.html` });
  assert.match(await tl('cor_inspect', { selector: '[data-testid="sku-beta"] button' }), /^ {2}card\(testId\)\.findByRole\('button', \{ name: 'Buy' \}\)$/m);
});

test('P3b: WebdriverIO and Playwright output is untouched by the Cypress renderer', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/p3a-attribute.html` });
  const pw = await call('cor_inspect', { selector: '[data-testid="sku-beta"] button', framework: 'playwright' });
  assert.match(pw, /Proof: counted by Playwright, every value\./);
  assert.doesNotMatch(pw, /cy\.get|escapeRegExp/);
});

test('P3b leaf: a class that names one toggle state\'s button is not the leaf — the CSS must match every twin, then :visible picks the shown one', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3b-state-twins.html` });
  const out = await call('cor_inspect', { selector: '.card:nth-child(2) .go-a' });
  assert.match(out, /^ {2}card\(testId\)\.find\('(button|button\.go)'\)\.filter\(':visible'\)$/m);
  assert.doesNotMatch(out.split('\n\n')[0], /go-[ab]/);
});

test('P3b R4: a long selector list or click goes on lines of its own; the helper stays within 8 lines and 120 characters', () => {
  const m = model({
    item: { css: 'div[data-plan-type="teams"] div.simplification-card', visible: false },
    slot: { kind: 'either', sels: ['h3.simplification-card__title', 'span.card-toggle__label'], transformed: false }, toggle: 'span.card-toggle__label',
  });
  const out = cy(params(m, { variantAct: 'x' }));
  const lines = out.define.split('\n');
  assert.ok(lines.length <= 8, `${lines.length} lines`);
  assert.deepEqual(lines.slice(2, 6), ['    .contains(', "      'h3.simplification-card__title, span.card-toggle__label',", '      new RegExp(`^\\\\s*${Cypress._.escapeRegExp(title)}\\\\s*$`),', '    )']);
  for (const l of out.code.split('\n')) assert.ok(l.length <= 120, l);
  assert.match(out.uses.at(-1), /\n {2}\.contains\('span\.card-toggle__label', new RegExp.*\n {2}\.click\(\)\n {2}\.closest\('label'\).*should\('be\.checked'\)$/);
});

// ── P3b.2: control groups ──
const grp = (over = {}) => ({ kind: 'group', param: 'size', role: 'radio', hidden: false, label: null, aria: true, cy: { kind: 'label', scope: null }, ...over });
const gp = (m, values = ['Small', 'Large']) => ({ model: m, values });

test('P3b idiom group.label: the option is the input its label names — wrapping or for, hidden or not', () => {
  const out = cy(gp(grp()));
  assert.equal(out.define, ['const sizeOption = (size) =>', "  cy.contains('label', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(size)}\\\\s*$`))", '    .then(($label) => cy.wrap($label[0].control));'].join('\n'));
  assert.deepEqual(out.idioms, ['group.label']);
  assert.equal(out.call, 'sizeOption(size)');
});

test('P3b idiom group.role: a tab or role="radio" option is found by its own text', () => {
  const out = cy(gp(grp({ role: 'tab', cy: { kind: 'role', selector: '[role="tab"]' } })));
  assert.equal(out.define, ['const sizeOption = (size) =>', "  cy.contains('[role=\"tab\"]', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(size)}\\\\s*$`));"].join('\n'));
  assert.deepEqual(out.idioms, ['group.role']);
});

test('P3b idiom group.label-click: a hidden input is changed by clicking its label, scoped when the labels share a container', () => {
  const out = cy(gp(grp({ hidden: true, cy: { kind: 'label', scope: 'div.toggle' }, label: { scope: 'div.toggle' } })));
  assert.equal(out.uses[0], "cy.contains('div.toggle label', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(size)}\\\\s*$`)).click()");
  assert.deepEqual(out.idioms, ['group.label', 'group.label-click']);
  assert.match(cy(gp(grp({ hidden: true, label: null }))).none, /label text does not name exactly one label/);
});

test('P3b idiom group.tl: Testing Library\'s findByRole for visible options, findByLabelText for hidden inputs', () => {
  assert.equal(cy(gp(grp()), { testingLibrary: true }).define, "const sizeOption = (size) => cy.findByRole('radio', { name: size });");
  const hidden = cy(gp(grp({ hidden: true, label: { scope: null } })), { testingLibrary: true });
  assert.equal(hidden.define, 'const sizeOption = (size) => cy.findByLabelText(size);');
  assert.deepEqual(hidden.idioms, ['group.tl', 'group.label-click']);
});

test('P3b group R1/R2/R3', () => {
  assert.match(cy(gp(grp({ cy: null }))).none, /no label or text names exactly one element/);
  assert.match(cy(gp(grp(), ['a"b', 'c'])).none, /quote or backtick/);
  assert.match(cy(gp(grp()), { typescript: true }).define, /^const sizeOption = \(size: string\) =>/);
});

test('P3b group: cor_inspect for Cypress renders the hidden-toggle helper and the label click', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3a-groups.html` });
  const out = await call('cor_inspect', { selector: 'input[value="individuals"]' });
  assert.match(out, /^ {2}const planTypeSelectorOption = \(planTypeSelector\) =>$/m);
  assert.match(out, /^ {6}\.then\(\(\$label\) => cy\.wrap\(\$label\[0\]\.control\)\);$/m);
  assert.match(out, /^ {2}cy\.contains\('div\.toggle label', new RegExp\(/m);
  assert.match(out, /The inputs are hidden: the last line clicks their label/);
  assert.match(out, /Proof: rendered from a checked template/);
  assert.doesNotMatch(out.split('\n\n')[0], /XPath:|written for Playwright only/);
});

test('P3b group: a name a promo suffix changes gets no Cypress form (the label text is not the name)', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3a-groups.html` });
  const out = await call('cor_inspect', { selector: 'input[name="billing_cycle"][value="monthly"]' });
  assert.doesNotMatch(out, /Option = \(/);
});

// ── P3b.3: row × column cells ──
const cellModel = (over = {}) => ({ kind: 'cell', vars: ['name', 'column'], cy: { headerSel: 'table.users tr:has(th) th', keySel: 'table.users tr > :nth-child(1)', innerCss: '' }, ...over });

test('P3b idiom cell.css: the header cell\'s position, then the row by its key cell — no XPath', () => {
  const out = cy({ model: cellModel(), rows: ['Ada'], columns: ['Role'] });
  assert.equal(out.define, [
    'const cell = (name, column) => {',
    "  const header = 'table.users tr:has(th) th';",
    "  const key = 'table.users tr > :nth-child(1)';",
    '  const is = (text) => new RegExp(`^\\\\s*${Cypress._.escapeRegExp(text)}\\\\s*$`);',
    "  return cy.contains(header, is(column)).invoke('index')",
    "    .then((i) => cy.contains(key, is(name)).closest('tr').children().eq(i));",
    '};',
  ].join('\n'));
  assert.deepEqual(out.idioms, ['cell.css']);
  assert.doesNotMatch(out.code, /xpath|evaluate/i);
  assert.match(cy({ model: cellModel({ cy: { ...cellModel().cy, innerCss: 'img.tick' } }), rows: ['a'], columns: ['b'] }).define, /\.eq\(i\)\.find\('img\.tick'\)\);\n\};$/);
});

test('P3b cell R1/R2/R3: names that are only part of their cell, or carry a quote, get no form', () => {
  assert.match(cy({ model: cellModel({ cy: null }), rows: ['a'], columns: ['b'] }).none, /only part of its cell/);
  assert.match(cy({ model: cellModel(), rows: ['it\'s'], columns: ['b'] }).none, /quote or backtick/);
  assert.match(cy({ model: cellModel(), rows: ['a'], columns: ['b'] }, { typescript: true }).define, /^const cell = \(name: string, column: string\) => \{\n.*\n.*\n {2}const is = \(text: string\)/);
});

test('P3b cell: cor_inspect for Cypress renders the cell helper, and the page emulation held for every combination', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3b-tables.html` });
  const out = await call('cor_inspect', { selector: 'table.picks tr:nth-child(2) td:nth-child(3)' });
  assert.match(out, /^ {2}const cell = \(username, column\) => \{$/m);
  assert.match(out, /^ {4}const key = 'table\.picks tr > :nth-child\(2\)';$/m);
  assert.match(out, /Proof: rendered from a checked template/);
  assert.doesNotMatch(out.split('\n\n')[0], /XPath:|Registry template/);
});

test('P3b cell: a cell named by a heading inside it (BrowserStack comparison) keeps the XPath line — no CSS form', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3a-compare.html` });
  const out = await call('cor_inspect', { selector: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)' });
  assert.match(out, /Proof: checked with the browser's XPath engine/);
  assert.doesNotMatch(out.split('\n\n')[0], /cy\.contains/);
});

test('P3b group: a label text another label repeats (no shared container to scope by) gets no Cypress form', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3a-groups-stray.html` });
  const out = await call('cor_inspect', { selector: 'input[value="b"]' });
  assert.doesNotMatch(out, /const modeOption/);
});

test('P3b group: cy.contains takes the first match, shown or not — a hidden tab with the same text rules the role form out', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3b-groups-role-clash.html` });
  const out = await call('cor_inspect', { selector: 'div[aria-label="Product"] button:nth-of-type(2)' });
  assert.doesNotMatch(out, /const productOption/);
});

test('P3b cell: a hidden copy of the table is scoped out by the same stable attribute the XPath form uses', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3b-tables-copies.html` });
  const out = await call('cor_inspect', { selector: 'div[data-product="live"] tbody tr:nth-child(2) td:nth-child(2)' });
  assert.ok(out.includes("const header = 'div[data-product=\"live\"] table.users tr:has(th) th';"), 'header lookup scoped');
  assert.ok(out.includes("const key = 'div[data-product=\"live\"] table.users tr > :nth-child(1)';"), 'row lookup scoped');
});

test('P3b group: visible radios whose label text another label repeats get no label form (cy.contains takes the first label)', async (t) => {
  const call = await connect(t, { deps: { cypress: '^16.1.0' } });
  await call('cor_open', { url: `${base}/p3b-groups-visible-stray.html` });
  const out = await call('cor_inspect', { selector: 'input[value="m"]' });
  assert.doesNotMatch(out, /const sizeOption/);
});
