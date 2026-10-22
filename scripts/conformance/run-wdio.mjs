// P3a conformance: render each case's helper from the checked model, run it in real WebdriverIO, and compare the element
// it reaches with the one Playwright's checked code reaches, for every value (spec §10, D5). Not part of `npm test`.
//   cd packages/mcp && npm run build && cd scripts/conformance && npm install && node run-wdio.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { remote } from 'webdriverio';
import { createSession } from '../../src/session.js';
import { callPage } from '../../src/page-runtime.js';
import { verifyTemplate } from '../../src/tools/inspect.js';
import { renderHelper, everyItem, leafIn } from '../../src/idioms/index.js';
import { CASES } from './cases.mjs';

const OUT = new URL('../../src/idioms/webdriverio.conformance.json', import.meta.url);
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  try { res.end(readFileSync(new URL(`./fixtures${req.url.split('?')[0]}`, import.meta.url), 'utf8')); } catch { res.end('missing'); }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const session = createSession({ headless: true });
const pw = await session.getPage();
const browser = await remote({ logLevel: 'error', capabilities: {
  browserName: 'chrome',
  'goog:chromeOptions': { args: ['--headless=new', '--window-size=1400,1000'], ...(process.env.COR_CHROME_BINARY ? { binary: process.env.COR_CHROME_BINARY } : {}) },
  // When Chrome auto-updates ahead of a published chromedriver: pin both (a Chrome for Testing build and its driver).
  ...(process.env.COR_CHROMEDRIVER ? { 'wdio:chromedriverOptions': { binary: process.env.COR_CHROMEDRIVER } } : {}),
} });
const version = JSON.parse(readFileSync(new URL('./node_modules/webdriverio/package.json', import.meta.url), 'utf8')).version;
const Async = Object.getPrototypeOf(async () => {}).constructor;

const idioms = {};
const mark = (id, ok, note) => {
  const e = (idioms[id] ??= { ok: true, checks: 0, failures: [] });
  e.checks++;
  if (!ok) { e.ok = false; e.failures.push(note); }
};
const report = [];

for (const c of CASES) {
  await pw.goto(`${base}/${c.fixture}`);
  const result = await callPage(pw, 'inspect', { selector: c.target, framework: 'webdriverio', max: 6 });
  await verifyTemplate(pw, result.params);
  const params = result.params;
  const out = renderHelper('webdriverio', params, { major: 9 });
  if (c.none) {
    const ok = Boolean(out.none && c.none.test(out.none));
    report.push(`${ok ? 'PASS' : 'FAIL'} ${c.id}: declined — ${out.none ?? 'rendered'}`);
    if (!ok) mark('decline', false, c.id);
    continue;
  }
  if (out.none) { report.push(`FAIL ${c.id}: no form — ${out.none}`); c.idioms.forEach((i) => mark(i, false, `${c.id}: ${out.none}`)); continue; }
  const missing = c.idioms.filter((i) => !out.idioms.includes(i));
  if (missing.length) { report.push(`FAIL ${c.id}: expected idioms ${missing.join(', ')}; rendered ${out.idioms.join(', ')}`); missing.forEach((i) => mark(i, false, `${c.id}: not rendered`)); continue; }
  const unexpected = (c.not ?? []).filter((i) => out.idioms.includes(i));
  if (unexpected.length) { report.push(`FAIL ${c.id}: rendered ${unexpected.join(', ')}, which finds a hidden twin`); unexpected.forEach((i) => mark(i, false, `${c.id}: used where a hidden twin exists`)); continue; }
  report.push(`     ${c.id}:\n${out.code.split('\n').map((l) => `        ${l}`).join('\n')}`);

  await browser.url(`${base}/${c.fixture}`);
  const names = params.model.vars ?? [params.model.param];
  const run = (body, ...vals) => new Async('$', '$$', ...names, `${out.define}\n${body}`)(browser.$.bind(browser), browser.$$.bind(browser), ...vals);
  const isGroup = out.kind === 'group';
  const isCell = out.kind === 'cell';
  const leafUse = isGroup || isCell ? out.call : out.uses.find((u) => !/\.click\(\)$/.test(u));
  const clickUse = out.uses.find((u) => /\.click\(\)$/.test(u));
  if (isCell) {
    // every row of the target's column and every column of the target's row, as the check counts them
    const combos = [...params.columns.map((col) => [params.row, col]), ...params.rows.map((row) => [row, params.column])];
    const [rv, cv] = params.vars;
    for (const [row, col] of combos) {
      const loc = new Function('page', `return (${params.code})`)(pw)(row, col);
      const n = await loc.count();
      const want = n === 1 ? await loc.evaluate((el) => [...document.getElementsByTagName('*')].indexOf(el)) : null;
      let got = null; let threw = null;
      try {
        const el = await run(`return ${leafUse}`, row, col);
        if (await el.isExisting()) got = await browser.execute((e) => [...document.getElementsByTagName('*')].indexOf(e), el);
      } catch (e) { threw = e.message.split('\n')[0]; }
      mark('cell.xpath', want === got, `${c.id} ${rv}="${row}" ${cv}="${col}": Playwright ${want}, WebdriverIO ${got ?? threw ?? 'nothing'}`);
      if (want !== got) report.push(`FAIL ${c.id} "${row}" × "${col}": Playwright ${want}, WebdriverIO ${got ?? threw ?? 'nothing'}`);
    }
    report.push(`     ${combos.length} row/column combinations compared`);
    continue;
  }
  const values = [...params.values, ...(params.variants ?? []).flatMap((v) => v.values)];
  for (const v of values) {
    const loc = new Function('page', params.model.param, `return ${params.code}`)(pw, v);
    const n = await loc.count();
    const want = n === 1 ? await loc.evaluate((el) => [...document.getElementsByTagName('*')].indexOf(el)) : null;
    let got = null; let threw = null;
    try {
      const el = await run(`return ${leafUse}`, v);
      if (await el.isExisting()) got = await browser.execute((e) => [...document.getElementsByTagName('*')].indexOf(e), el);
    } catch (e) { threw = e.message.split('\n')[0]; }
    const ok = want === got;
    for (const id of out.idioms.filter((i) => !i.startsWith('variant'))) mark(id, ok, `${c.id} "${v}": Playwright ${want}, WebdriverIO ${got ?? threw ?? 'nothing'}`);
    if (!ok) report.push(`FAIL ${c.id} "${v}": Playwright ${want}, WebdriverIO ${got ?? threw ?? 'nothing'}`);
    // a partial name reaches nothing
    const part = v.slice(0, -1);
    let partial = null;
    try { const el = await run(`return ${leafUse}`, part); partial = (await el.isExisting()) ? 'found' : null; } catch { partial = null; }
    mark(out.idioms[0], partial === null, `${c.id} "${part}" (partial) found an element`);
    if (partial) report.push(`FAIL ${c.id}: partial "${part}" found an element`);
  }
  if (isGroup && clickUse && c.select) {
    // A user changes a hidden input by clicking its label; the option then reads as selected.
    for (const v of params.values) {
      await browser.url(`${base}/${c.fixture}`);
      let ok = false; let note = '';
      try {
        await run(`await ${clickUse}; return 1`, v);
        ok = await (await run(`return ${leafUse}`, v)).isSelected();
        note = ok ? '' : 'not selected after its label was clicked';
      } catch (e) { note = e.message.split('\n')[0]; }
      mark('group.label-click', ok, `${c.id} "${v}": ${note}`);
    }
  }
  if (clickUse && c.toggled) {
    // Only values a toggle label names are shown by a click; a heading-named card has no label to click.
    for (const v of (params.variants ?? []).flatMap((x) => [x.of, ...x.values])) {
      await browser.url(`${base}/${c.fixture}`);
      let note = '';
      let ok = false;
      try {
        await run(`await ${clickUse}; return 1`, v);
        const checked = await browser.execute((sel) => [...document.querySelectorAll(sel)].filter((i) => i.checked).map((i) => i.labels[0]?.textContent.trim()), c.toggled);
        ok = checked.includes(v);
        note = `checked after the click: ${checked.join(', ') || 'none'}`;
      } catch (e) { note = e.message.split('\n')[0]; }
      mark('variant.click', ok, `${c.id} "${v}": ${note}`);
    }
  }
  if (isGroup) continue;
  await browser.url(`${base}/${c.fixture}`); // the variant clicks above changed which twin is shown
  const every = await new Async('$', '$$', `return ${everyItem('webdriverio', params.model)}`)(browser.$.bind(browser), browser.$$.bind(browser));
  const wantEvery = await new Function('page', `return ${params.every}`)(pw).count();
  mark('every', every.length === wantEvery, `${c.id}: WebdriverIO ${every.length}, Playwright ${wantEvery}`);
  report.push(`     every → ${every.length} items (Playwright ${wantEvery})`);
  // P3: the leaf inside each item of the every-item loop (the entry's <member>Of(item)) reaches what Playwright's does there.
  const ofCode = params.leafCode && leafIn('webdriverio', params.model, 'item');
  if (ofCode) {
    for (let i = 0; i < every.length; i++) {
      const loc = new Function('page', 'i', `return ${params.every}.nth(i)${params.leafCode}`)(pw, i);
      const want = await loc.count() === 1 ? await loc.evaluate((el) => [...document.getElementsByTagName('*')].indexOf(el)) : null;
      let got = null;
      try {
        const el = await new Async('item', `return ${ofCode}`)(every[i]);
        if (el && await el.isExisting()) got = await browser.execute((e) => [...document.getElementsByTagName('*')].indexOf(e), el);
      } catch { /* not there */ }
      mark('every.leaf', want === got, `${c.id} item ${i}: Playwright ${want}, WebdriverIO ${got}`);
      if (want !== got) report.push(`FAIL ${c.id} item ${i} (leaf): Playwright ${want}, WebdriverIO ${got}`);
    }
  }
}

await browser.deleteSession();
await session.close();
site.close();

let existing = { framework: 'webdriverio', runs: [] };
try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
const run = { major: Number(version.split('.')[0]), version, date: new Date().toISOString().slice(0, 10), idioms };
existing.runs = [...existing.runs.filter((r) => r.major !== run.major), run];
writeFileSync(OUT, `${JSON.stringify(existing, null, 2)}\n`);
console.log(report.join('\n'));
console.log(JSON.stringify(Object.fromEntries(Object.entries(idioms).map(([k, v]) => [k, `${v.ok ? 'ok' : 'FAIL'} (${v.checks})`])), null, 1));
for (const [k, v] of Object.entries(idioms)) for (const f of v.failures) console.log(`  ${k}: ${f}`);
process.exit(Object.values(idioms).every((v) => v.ok) ? 0 : 1);
