// P1 core (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — one shared positional / structural check for
// the entry builder and cor_check; a declined element gets a decline id; a template's proof is only on its own code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { bannedIn, bannedSelector } from '../src/positional.js';
import { inspectParts } from '../src/format.js';

test('P1 shared check: fixed numbers are banned, worked-out ones are not', () => {
  for (const [code, fw] of [
    ["page.locator('.x').first()", 'playwright'], ["page.getByRole('button').nth(2)", 'playwright'], ["page.locator('li >> nth=1')", 'playwright'],
    ["cy.get('.row').eq(0)", 'cypress'], ["cy.get('li').last()", 'cypress'], ["$$('.row')[3]", 'webdriverio'],
    ["page.locator('div > div:nth-of-type(2) > span')", 'playwright'], ["cy.get('tr:nth-child(8) td')", 'cypress'],
    ["$('(//button)[2]')", 'webdriverio'], ["$('//tr[td[1]]/td[3]')", 'webdriverio'],
  ]) assert.match(bannedIn(code, fw) ?? '', /picks by position/, code);
  for (const code of ["cy.contains(key, is(r)).closest('tr').children().eq(i)", "page.locator('.row').nth(i)", "cy.get('li:nth-child(2n)')"]) {
    assert.equal(bannedIn(code, 'cypress'), null, code);
  }
});

test('P1 shared check: 3+ bare tags in a row are banned in every framework; display text is never read as a selector', () => {
  for (const fw of ['playwright', 'cypress', 'webdriverio']) {
    assert.match(bannedIn("x('#react-checkout-root div div div div div div h3')".replace('x', fw === 'cypress' ? 'cy.get' : fw === 'playwright' ? 'page.locator' : '$'), fw), /anonymous tag nesting/);
  }
  assert.equal(bannedIn("cy.get('#checkout-root h3')", 'cypress'), null);
  assert.equal(bannedIn("page.getByText('add to cart now', { exact: true })", 'playwright'), null, 'text, not a selector');
  assert.equal(bannedIn("cy.contains('h3', 'go to the cart now')", 'cypress'), null);
  assert.equal(bannedSelector('ul > li > a'), bannedSelector('ul li a'));
});

test('P1 shared check: Cypress bans cy.xpath and class chains with no anchor; other frameworks keep class chains', () => {
  assert.match(bannedIn("cy.xpath('//h3')", 'cypress'), /cypress-xpath plugin/);
  assert.match(bannedIn("cy.get('.card .price')", 'cypress'), /no attribute, id or text/);
  assert.equal(bannedIn("page.locator('.card .price')", 'playwright'), null);
  assert.equal(bannedIn("cy.get('.cart-badge')", 'cypress'), null, 'a single class');
  assert.equal(bannedIn("cy.get('[data-plan=\"team\"] .price')", 'cypress'), null, 'anchored by an attribute');
  assert.equal(bannedIn("cy.get('.card').contains('.title', name).closest('.card')", 'cypress'), null, 'anchored by text');
});

test('P1 a template whose own code fails the check is not the entry; the single locator is, with its own proof', () => {
  const good = { value: '#go', code: "page.locator('#go')", score: 80, tier: 'good', tierLabel: 'Good', resolution: { usable: true } };
  const result = { framework: 'playwright', locators: [good], params: { kind: 'item', template: { playwright: {} }, code: "page.locator('.card').first()" } };
  const parts = inspectParts(result, { framework: 'playwright' });
  assert.equal(parts.lead, result.params, 'the reply still shows the template');
  assert.equal(parts.entryLead, null);
  assert.equal(parts.declined, null);
  const unstable = { ...good, tier: 'unstable', tierLabel: 'Unstable' };
  assert.match(inspectParts({ ...result, locators: [unstable] }, { framework: 'playwright' }).declined, /no durable locator — the best is Unstable/);
});

// ── through the server, on the P1 class pages (tests/fixtures/p1-*.html) ──
const root = mkdtempSync(join(tmpdir(), 'cor-p1-'));
after(() => rmSync(root, { recursive: true, force: true }));
const site = createHttpServer((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  let body;
  try { body = readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

function project(name, deps, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: deps }));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
}
async function connect(t, dir) {
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const records = createRecordStore({ root: () => session.root });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return { records, call: async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') }; } };
}
const CY = { cypress: '13' };
const entryOf = (text) => text.slice(text.indexOf('Entry —')).split('\n\n')[0];

test('P1 a heading behind anonymous div nesting: the text or id anchor leads, never the div chain (Cypress)', async (t) => {
  const { call } = await connect(t, project('nested', CY));
  await call('cor_open', { url: `${base}/p1-nested-heading` });
  const out = (await call('cor_inspect', { selector: '#checkout-root h3' })).text;
  const entry = entryOf(out);
  assert.doesNotMatch(out, /^ {2}cy\.get\('#checkout-root div div/m, 'the chain does not lead');
  assert.match(entry, /liveTeamProHeading = \(\) => cy\./);
  assert.equal(bannedIn(entry, 'cypress'), null, entry);
  assert.match(out, /Why this order: Ranked .* walks anonymous tag nesting/);
});

test('P1 a split-header table: the cell entry is the header-name helper (Cypress) or the cell function (Playwright) — no positional fallback', async (t) => {
  for (const [name, deps, use] of [['split-cy', CY, /cellAt = \(feature, column\) => cell\(feature, column\);/], ['split-pw', { '@playwright/test': '1' }, /cellAt = \(feature, column\) => \{/]]) {
    const { call } = await connect(t, project(name, deps));
    await call('cor_open', { url: `${base}/p1-split-header` });
    const entry = entryOf((await call('cor_inspect', { selector: 'table.body tr:nth-child(2) td:nth-child(3)' })).text);
    assert.match(entry, use, entry);
    assert.match(entry, /cor:[0-9a-f]{6} · 7\/7 items checked/, 'the proof is the template\'s, on the template\'s own code');
    assert.doesNotMatch(entry, /nth-of-type|td\[3\]|cy\.xpath|\(\) => \(feature/, entry);
  }
});

test('P1 no durable locator: a decline id is issued and recorded; cor_check reports the cited decline, not a failure', async (t) => {
  const dir = project('decline', CY);
  const { call, records } = await connect(t, dir);
  await call('cor_open', { url: `${base}/p1-no-durable` });
  const out = (await call('cor_inspect', { selector: '.list > div:nth-child(2) .dot' })).text;
  const [, id, why] = /\/\/ COR cor:([0-9a-f]{6}) · declined — (.+)$/m.exec(out) ?? [];
  assert.ok(id, out);
  assert.match(out, /^Entry — declined: /m);
  const record = records.read(id);
  assert.equal(record.declined, why);
  assert.ok(record.strategies.every((s) => !bannedSelector(s.value)), 'the record keeps no positional strategy');
  writeFileSync(join(dir, 'a.cy.js'), `// COR cor:${id} · declined — ${why}\ncy.get('div > div:nth-of-type(2) > span:nth-of-type(1)').should('exist');\ncy.get('#app div div div span');\n`);
  const check = await call('cor_check', { files: ['a.cy.js'] });
  assert.match(check.text, /^cor_check: 2 locators in 1 file \(the given files\) — 0 carry a COR id, 1 declined \(cited\), 1 to fix\./);
  assert.match(check.text, new RegExp(`a\\.cy\\.js:2 cor:${id} — ${why}`));
  assert.match(check.text, /✗ a\.cy\.js:3 — .* walks anonymous tag nesting .*\(COR never issues this shape\)/);
});

test('P1 every entry recorded in the golden suite passes the shared check', () => {
  const dir = new URL('./golden/expected/', import.meta.url);
  let entries = 0;
  for (const name of readdirSync(dir)) {
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // the member line under each entry's own comment (a helper's module-scope definition is COR's conformance-tested idiom)
      if (!/^ {2}(\/\/|#) COR cor:\{id\} · (?!.*helper)(?!declined)/.test(line)) return;
      const member = lines[i + 1];
      const fw = /\bcy\./.test(member) ? 'cypress' : /\$\(|browser\./.test(member) ? 'webdriverio' : 'playwright';
      entries++;
      assert.equal(bannedIn(member, fw), null, `${name}: ${member}`);
    });
  }
  assert.ok(entries >= 20, `only ${entries} entries found`);
});
