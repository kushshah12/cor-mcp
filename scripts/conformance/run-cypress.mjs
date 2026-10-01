// P3b conformance: render each case's Cypress helper from the checked model, run it in real Cypress, and compare the element it
// reaches with the one Playwright's checked code reaches, for every value (spec §10, D5). Not part of `npm test`.
//   cd packages/mcp && npm run build && cd scripts/conformance && npm install && node run-cypress.mjs
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import cypress from 'cypress';
import { createSession } from '../../src/session.js';
import { callPage } from '../../src/page-runtime.js';
import { verifyTemplate } from '../../src/tools/inspect.js';
import { renderHelper } from '../../src/idioms/index.js';
import { CASES } from './cases.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const OUT = new URL('../../src/idioms/cypress.conformance.json', import.meta.url);
const WORK = `${HERE}.cy-work`;
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  try { res.end(readFileSync(new URL(`./fixtures${req.url.split('?')[0]}`, import.meta.url), 'utf8')); } catch { res.end('missing'); }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const version = JSON.parse(readFileSync(new URL('./node_modules/cypress/package.json', import.meta.url), 'utf8')).version;

const session = createSession({ headless: true });
const pw = await session.getPage();
const idioms = {};
const mark = (id, ok, note) => { const e = (idioms[id] ??= { ok: true, checks: 0, failures: [] }); e.checks++; if (!ok) { e.ok = false; e.failures.push(note); } };
const report = [];
const specs = []; // one Cypress test per check
const meta = new Map(); // test title → idioms it counts for

for (const tl of [false, true]) for (const c of CASES) {
  if (!c.cy && !c.none) continue;
  const mode = tl ? 'tl' : 'plain';
  await pw.goto(`${base}/${c.fixture}`);
  const result = await callPage(pw, 'inspect', { selector: c.target, framework: 'cypress', max: 6 });
  await verifyTemplate(pw, result.params);
  const params = result.params;
  const out = renderHelper('cypress', params, { major: 16, testingLibrary: tl });
  if (out.none) { if (!tl) { report.push(`     ${c.id}: no form — ${out.none}`); if (c.cy) c.cy.forEach((i) => mark(i, false, `${c.id}: ${out.none}`)); } continue; }
  if (!tl) {
    const missing = (c.cy ?? []).filter((i) => !out.idioms.includes(i));
    if (missing.length) { report.push(`FAIL ${c.id}: expected ${missing.join(', ')}; rendered ${out.idioms.join(', ')}`); missing.forEach((i) => mark(i, false, `${c.id}: not rendered`)); continue; }
  }
  if (tl && !out.idioms.some((i) => i === 'leaf.role' || i === 'group.tl')) continue; // nothing Testing Library-specific to run
  report.push(`     ${c.id}${tl ? ' (Testing Library)' : ''}:\n${out.code.split('\n').map((l) => `        ${l}`).join('\n')}`);
  const isGroup = out.kind === 'group';
  if (out.kind === 'cell') {
    const combos = [...params.columns.map((col) => [params.row, col]), ...params.rows.map((row) => [row, params.column])];
    for (const [row, col] of combos) {
      const loc = new Function('page', `return (${params.code})`)(pw)(row, col);
      const n = await loc.count();
      const want = n === 1 ? await loc.evaluate((el) => [...document.getElementsByTagName('*')].indexOf(el)) : null;
      specs.push({ id: `${mode}|${c.id}|${row} × ${col}|match`, fixture: c.fixture, define: out.define, names: params.model.vars, args: [row, col], expr: out.call, want, idioms: ['cell.css'] });
    }
    continue;
  }
  const leafUse = isGroup ? out.call : out.uses.find((u) => !/\.click\(\)/.test(u));
  const clickUse = out.uses.find((u) => /\.click\(\)/.test(u));
  const values = [...params.values, ...(params.variants ?? []).flatMap((v) => v.values)];
  for (const v of values) {
    const loc = new Function('page', params.model.param, `return ${params.code}`)(pw, v);
    const n = await loc.count();
    const want = n === 1 ? await loc.evaluate((el) => [...document.getElementsByTagName('*')].indexOf(el)) : null;
    specs.push({ id: `${mode}|${c.id}|${v}|match`, fixture: c.fixture, define: out.define, names: [params.model.param], args: [v], expr: leafUse ?? out.call, want, idioms: out.idioms.filter((i) => !i.startsWith('variant') && !i.endsWith('click')) });
    specs.push({ id: `${mode}|${c.id}|${v.slice(0, -1)}|partial`, fixture: c.fixture, define: out.define, names: [params.model.param], args: [v.slice(0, -1)], expr: leafUse ?? out.call, negative: true, idioms: [out.idioms[0]] });
  }
  if (clickUse && c.toggled) {
    for (const v of (params.variants ?? []).flatMap((x) => [x.of, ...x.values])) {
      specs.push({ id: `${mode}|${c.id}|${v}|click`, fixture: c.fixture, define: out.define, names: [params.model.param], args: [v], expr: clickUse, toggled: c.toggled, idioms: ['variant.click'] });
    }
  }
  if (isGroup && clickUse && c.select) {
    for (const v of params.values) specs.push({ id: `${mode}|${c.id}|${v}|select`, fixture: c.fixture, define: out.define, names: [params.model.param], args: [v], expr: clickUse, after: out.call, idioms: ['group.label-click'] });
  }
  if (!isGroup) {
    const wantEvery = await new Function('page', `return ${params.every}`)(pw).count();
    specs.push({ id: `${mode}|${c.id}||every`, fixture: c.fixture, define: '', names: [params.model.param], args: [''], expr: require_every(params.model), wantEvery, idioms: ['every'] });
  }
}

function require_every(model) { return `cy.get(${JSON.stringify(model.item.css)})${model.item.visible ? ".filter(':visible')" : ''}`; }

rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/e2e`, { recursive: true });
mkdirSync(`${WORK}/support`, { recursive: true });
writeFileSync(`${WORK}/support/e2e.js`, "import '@testing-library/cypress/add-commands';\n");
writeFileSync(`${WORK}/e2e/p3b.cy.js`, `
const CASES = ${JSON.stringify(specs.map((s) => ({ ...s, define: undefined })))};
const DEFINE = ${JSON.stringify(Object.fromEntries(specs.map((s) => [s.id, s.define])))};
const indexOf = (el) => Array.from(el.ownerDocument.getElementsByTagName('*')).indexOf(el);
describe('P3b conformance', () => {
  for (const c of CASES) {
    it(c.id, () => {
      let failed = null;
      cy.on('fail', (e) => { failed = e.message.split('\\n')[0]; return false; });
      const run = new Function('cy', 'Cypress', ...c.names, DEFINE[c.id] + '\\nreturn ' + c.expr);
      cy.visit('/' + c.fixture);
      if (c.wantEvery !== undefined) {
        run(cy, Cypress, ...c.args).then(($els) => cy.task('record', { id: c.id, got: $els.length, want: c.wantEvery }));
      } else if (c.after) {
        run(cy, Cypress, ...c.args).then(() => new Function('cy', 'Cypress', ...c.names, DEFINE[c.id] + '\\nreturn ' + c.after)(cy, Cypress, ...c.args).then(($i) => cy.task('record', { id: c.id, selected: $i[0].checked })));
      } else if (c.toggled) {
        run(cy, Cypress, ...c.args).then(() => cy.get(c.toggled).then(($i) => cy.task('record', { id: c.id, checked: [...$i].filter((i) => i.checked).map((i) => i.labels[0].textContent.trim()) })));
      } else {
        run(cy, Cypress, ...c.args).then(($el) => cy.task('record', { id: c.id, got: $el.length === 1 ? indexOf($el[0]) : ($el.length ? 'many:' + $el.length : null), want: c.want }));
      }
      cy.then(() => { if (failed) return cy.task('record', { id: c.id, threw: failed }); });
    });
  }
});
`);
const RECORDS = `${WORK}/records.ndjson`;
process.env.CY_RECORDS = RECORDS;
writeFileSync(RECORDS, '');
const records = new Map();
const result = await cypress.run({
  project: HERE,
  browser: 'electron',
  config: { e2e: { baseUrl: base, specPattern: `${WORK}/e2e/p3b.cy.js`, supportFile: `${WORK}/support/e2e.js`, defaultCommandTimeout: 1500, video: false, screenshotOnRunFailure: false, video: false }, video: false },
  quiet: true,
});
site.close(); await session.close();
for (const line of readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); records.set(r.id, { ...(records.get(r.id) ?? {}), ...r }); }
if (process.env.CY_DEBUG) for (const r of result.runs ?? []) for (const t of r.tests ?? []) console.log(t.state, t.title.join(' > '), (t.displayError ?? '').split('\n')[0]);
if (result.status === 'failed') { console.log('Cypress failed to run:', result.message); process.exit(2); }

for (const s of specs) {
  const r = records.get(s.id) ?? {};
  let ok; let note;
  if (s.wantEvery !== undefined) { ok = r.got === s.wantEvery; note = `Cypress ${r.got}, Playwright ${s.wantEvery}`; }
  else if (s.after) { ok = r.selected === true; note = `selected after its label was clicked: ${r.selected}`; }
  else if (s.toggled) { const v = s.args[0]; ok = Array.isArray(r.checked) && r.checked.includes(v); note = `checked after the click: ${(r.checked ?? []).join(', ') || 'none'}${r.threw ? ` (${r.threw})` : ''}`; }
  else if (s.negative) { ok = r.threw !== undefined || r.got === null || r.got === undefined; note = 'a partial name reached an element'; }
  else { ok = r.got === s.want && r.threw === undefined; note = `Playwright ${s.want}, Cypress ${r.got ?? r.threw ?? 'nothing'}`; }
  for (const id of s.idioms) mark(id, ok, `${s.id}: ${note}`);
  if (!ok) report.push(`FAIL ${s.id}: ${note}`);
}
rmSync(WORK, { recursive: true, force: true });

let existing = { framework: 'cypress', runs: [] };
try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
const run = { major: Number(version.split('.')[0]), version, date: new Date().toISOString().slice(0, 10), idioms };
existing.runs = [...existing.runs.filter((r) => r.major !== run.major), run];
writeFileSync(OUT, `${JSON.stringify(existing, null, 2)}\n`);
console.log(report.join('\n'));
console.log(JSON.stringify(Object.fromEntries(Object.entries(idioms).map(([k, v]) => [k, `${v.ok ? 'ok' : 'FAIL'} (${v.checks})`])), null, 1));
for (const [k, v] of Object.entries(idioms)) for (const f of v.failures) console.log(`  ${k}: ${f}`);
process.exit(Object.values(idioms).every((v) => v.ok) ? 0 : 1);
