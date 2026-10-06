// P2a fix (2026-10-06 benchmark, sessions f7a61eba / d50c4b2a): a hidden input's entry carries the label to click, in
// every framework; WebdriverIO's aria/ never leads for one; partial text is banned; cor_check reads COR's own helpers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { bannedIn } from '../src/positional.js';
import { scanLocators } from '../src/check-scan.js';
import { renderIndex } from '../src/format-snapshot.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p2afix-'));
after(() => rmSync(root, { recursive: true, force: true }));
const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`./fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

const DEPS = { playwright: { '@playwright/test': '1' }, cypress: { cypress: '13' }, webdriverio: { webdriverio: '9' } };
async function connect(t, framework) {
  const dir = join(root, `${framework}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: DEPS[framework] }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: createRecordStore({ root: () => session.root }) });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return { dir, call: async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') }; } };
}
const refOf = (text, re) => re.exec(text)?.[1];

const LABEL = {
  playwright: { group: /planLabel = \(plan\) => this\.page\.locator\('div\.toggle'\)\.getByText\(plan, \{ exact: true \}\);/, single: /billAnnuallyInputLabel = \(\) => this\.page\.getByText\('Bill annually', \{ exact: true \}\);/ },
  cypress: { group: /planLabel = \(plan\) => cy\.contains\('label', /, single: /billAnnuallyInputLabel = \(\) => cy\.contains\('label', \/\^\\s\*Bill annually\\s\*\$\/\);/ },
  webdriverio: { group: /planLabel = \(plan\) => \$\(`label=\$\{plan\}`\);/, single: /billAnnuallyInputLabel = \(\) => \$\('label=Bill annually'\);/ },
};

for (const fw of ['playwright', 'cypress', 'webdriverio']) {
  test(`P2a fix (${fw}): a hidden input's entry carries the label to click, under the same id, marked · label`, async (t) => {
    const { call } = await connect(t, fw);
    const opened = (await call('cor_open', { url: `${base}/toggles` })).text;
    assert.match(opened, /radio "For Teams" \[ref=e\d+\] \[via label\]/);
    const [teams, individuals, annual] = [/radio "For Teams" \[ref=(e\d+)\]/, /radio "For Individuals" \[ref=(e\d+)\]/, /checkbox "Bill annually" \[ref=(e\d+)\]/].map((re) => refOf(opened, re));
    const out = (await call('cor_inspect', { targets: [teams, individuals, annual] })).text;
    assert.match(out, LABEL[fw].group, out);
    assert.match(out, LABEL[fw].single, out);
    const ids = [...out.matchAll(/cor:([0-9a-f]{6}) · label — the input is hidden: click this, assert (\w+)'s checked state/g)];
    assert.equal(ids.length, 2, out);
    for (const [, id, member] of ids) assert.match(out, new RegExp(`cor:${id} · [^\\n]*\\n {2}(?:const \\w+ = [^\\n]*\\n(?: {4}[^\\n]*\\n)* {2}// COR cor:${id}[^\\n]*\\n {2})?${member} =`), `the label member shares ${member}'s id`);
    if (fw === 'webdriverio') assert.doesNotMatch(out, /billAnnuallyInput = \(\) => \$\('aria\//, 'aria/ never leads for a hidden input');
  });
}

test('P2a fix: cor_check passes the label member (it finds the label, not the recorded input)', async (t) => {
  const { dir, call } = await connect(t, 'playwright');
  const opened = (await call('cor_open', { url: `${base}/toggles` })).text;
  const out = (await call('cor_inspect', { targets: [refOf(opened, /checkbox "Bill annually" \[ref=(e\d+)\]/)] })).text;
  const members = out.split('\n').filter((l) => /^ {2}(\/\/ COR|\w+ = )/.test(l)).join('\n');
  writeFileSync(join(dir, 'toggles.page.js'), `export class TogglesPage {\n  constructor(page) { this.page = page; }\n${members}\n}\n`);
  const check = await call('cor_check', { files: ['toggles.page.js'] });
  assert.match(check.text, /^cor_check: 2 locators in 1 file \(the given files\) — 2 carry a COR id, 0 to fix\./, check.text);
});

test('P2a fix: partial text is banned — a hasText string, getByText / getByLabel without exact (Playwright), *= (WebdriverIO)', () => {
  for (const code of ["page.locator('label').filter({ hasText: 'For Individuals' })", "page.getByLabel('Team Pro')", "page.getByText(name)", "page.getByText('a', { exact: false })"]) {
    assert.match(bannedIn(code, 'playwright') ?? '', /partial text/, code);
  }
  for (const code of ["page.getByLabel(t, { exact: true })", "page.locator('li').filter({ hasText: /^Item 1$/ })", "page.getByRole('button', { name: 'Choose' })"]) {
    assert.equal(bannedIn(code, 'playwright'), null, code);
  }
  assert.match(bannedIn("$('*=You have selected')", 'webdriverio'), /partial text/);
  assert.equal(bannedIn("$('label=Team')", 'webdriverio'), null);
});

test('P2a fix: cor_check reads COR\'s own WebdriverIO either-name helper as one statement with its id (it breaks after ||)', () => {
  const src = [
    '// COR cor:572054 · 3/3 items checked · helper, once per file (module scope)',
    'const simplificationCard = (title: string) =>',
    "  $$('div.simplification-card')",
    '    .find(async (el) => (await el.$(`h3.simplification-card__title=${title}`).isExisting()) ||',
    '      (await el.$(`span.card-toggle__label=${title}`).isExisting()));',
  ].join('\n');
  const sites = scanLocators(src, 'webdriverio');
  assert.equal(sites.length, 1, JSON.stringify(sites));
  assert.equal(sites[0].id, '572054');
});

test('P2a fix: the region index keeps [via label] on a hidden input, so the agent knows to click its label', () => {
  const leaf = (ref, role, name, extra = {}) => ({ kind: 'leaf', ref, role, name, states: [], hint: null, ...extra });
  const index = renderIndex({ url: 'u', title: 't', count: 2, tree: [{ kind: 'container', type: 'section', label: 'Plans', children: [
    leaf('e1', 'radio', 'For Individuals', { viaLabel: true }), leaf('e2', 'button', 'Choose')] }] });
  assert.match(index, /radio "For Individuals" \[ref=e1\] \[via label\], button "Choose" \[ref=e2\]/);
});
