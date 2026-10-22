// Review fixes (code review 20261005-160511-977b2930 + live saucedemo run, 2026-10-05) for U8, U9 and U12.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { scanLocators } from '../src/check-scan.js';
import { changedFiles } from '../src/tools/check.js';

const root = mkdtempSync(join(tmpdir(), 'cor-review-'));
after(() => rmSync(root, { recursive: true, force: true }));
const PKG = JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } });
function project(name, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), PKG);
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
}

// A cart button that turns into Remove in place (saucedemo's shape), and a pair of danger buttons.
const PAGE = `<title>Shop</title><main>
  <div class="card"><h3>Mug</h3><button class="buy" data-test="add-mug" onclick="this.textContent = this.textContent === 'Add to cart' ? 'Remove' : 'Add to cart'">Add to cart</button></div>
  <div class="card"><h3>Pen</h3><button class="buy" data-test="add-pen">Add to cart</button></div>
  <span data-test="badge">0</span>
  <section id="danger"><button class="btn-danger" id="draft-del">Delete draft</button><button class="btn-danger" id="acct-del">Delete account</button></section>
</main>`;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(new URL(req.url, 'http://x').searchParams.get('m') === 'nodraft' ? PAGE.replace(/<button class="btn-danger" id="draft-del">Delete draft<\/button>/, '') : PAGE);
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}/shop`; });
after(() => { site.closeAllConnections?.(); site.close(); });

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
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  return { call, records };
}
const idOf = (s) => /cor:([0-9a-f]{6})/.exec(s)?.[1];

test('U8 review: a button that turns into Remove in place gets its own id — Add to cart\'s record is not overwritten (live saucedemo)', async (t) => {
  const dir = project('toggle');
  const { call, records } = await connect(t, dir);
  await call('cor_open', { url: base });
  const add = idOf((await call('cor_inspect', { selector: '[data-test="add-mug"]' })).text);
  await call('cor_click', { target: '[data-test="add-mug"]' });
  const remove = idOf((await call('cor_inspect', { selector: '[data-test="add-mug"]' })).text);
  assert.notEqual(add, remove);
  assert.equal(records.read(add).fingerprint.text, 'Add to cart');
  assert.equal(records.read(remove).fingerprint.text, 'Remove');
});

test('U8 review: a record that cannot be written does not fail the inspect; the entry says heal has no record', async (t) => {
  const dir = project('readonly');
  mkdirSync(join(dir, '.cor', 'pending'), { recursive: true }); // P8a: a new entry is written to pending/
  chmodSync(join(dir, '.cor', 'pending'), 0o500);
  t.after(() => chmodSync(join(dir, '.cor', 'pending'), 0o700));
  const { call } = await connect(t, dir);
  await call('cor_open', { url: base });
  const out = await call('cor_inspect', { selector: '[data-test="badge"]' });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /\(record not saved: .* — cor_heal will have no record for this id\)/);
});

test('U8 review: a corrupt .cor/ids.json is never overwritten', () => {
  const dir = project('corrupt', { '.cor/ids.json': '{oops' });
  const store = createRecordStore({ root: () => dir });
  store.link('a.json#b', 'abcdef');
  assert.equal(readFileSync(join(dir, '.cor/ids.json'), 'utf8'), '{oops');
  assert.match(store.lastError, /unreadable/);
});

test('U8 review: a record of another format version is not read', () => {
  const dir = project('version', { '.cor/records/aaaaaa.json': JSON.stringify({ v: 99, id: 'aaaaaa', fingerprint: {}, strategies: [] }) });
  assert.equal(createRecordStore({ root: () => dir }).read('aaaaaa'), null);
});

test('U12 review: the recorded button removed, a same-class button with other text remains — heal declines (no wrong element)', async (t) => {
  const dir = project('danger');
  const { call } = await connect(t, dir);
  await call('cor_open', { url: base });
  const id = idOf((await call('cor_inspect', { selector: '#draft-del' })).text);
  await call('cor_open', { url: `${base}?m=nodraft` });
  const out = await call('cor_heal', { id });
  assert.equal(out.isError, true, 'a decline is not a success');
  assert.match(out.text, /Declined —/, out.text);
  assert.doesNotMatch(out.text, /Delete account|acct-del/);
});

test('U12 review: exact role and quoted text strategies run as stored', async (t) => {
  const dir = project('exact');
  const { call } = await connect(t, dir);
  await call('cor_open', { url: base });
  const path = new URL(base);
  for (const [id, s] of [['aaaaa1', { kind: 'roleExact', value: 'role=button, name=Delete account (exact)' }], ['aaaaa2', { kind: 'textExact', value: '"Delete account"' }]]) {
    mkdirSync(join(dir, '.cor/records'), { recursive: true });
    writeFileSync(join(dir, `.cor/records/${id}.json`), JSON.stringify({ v: 1, id, page: `${path.origin}${path.pathname}`, elementKey: 'x', member: 'm',
      fingerprint: { tag: 'button', attrs: {}, text: 'Delete account', classes: ['btn-danger'] }, strategies: [{ kind: 'testId', value: '[data-test="gone"]' }, s], created: '2026-10-05' }));
    const out = await call('cor_heal', { id });
    assert.match(out.text, new RegExp(`Evidence: stored ${s.kind} locator`), out.text);
  }
});

test('U9 review: a project in a subfolder of the git repo finds its new untracked spec', () => {
  const repo = join(root, 'mono');
  mkdirSync(join(repo, 'e2e', 'tests'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'x');
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  g('remote', 'add', 'origin', repo); g('fetch', '-q', 'origin');
  writeFileSync(join(repo, 'e2e', 'package.json'), PKG);
  writeFileSync(join(repo, 'e2e', 'tests', 'new.spec.ts'), "page.locator('#x');\n");
  const files = changedFiles(join(repo, 'e2e')).map((f) => f.slice(join(repo, 'e2e').length + 1)).sort();
  assert.deepEqual(files, ['package.json', 'tests/new.spec.ts']);
});

test('U9 review: an entry extended with a typed step finds another element — flagged by element, not by text', async (t) => {
  const dir = project('extended');
  const { call } = await connect(t, dir);
  await call('cor_open', { url: base });
  const id = idOf((await call('cor_inspect', { selector: '#acct-del' })).text);
  writeFileSync(join(dir, 'a.spec.ts'), `// COR cor:${id} · edited\npage.locator('#danger').locator('#draft-del');\n// COR cor:${id}\npage.locator("#acct-del");\n`);
  const out = (await call('cor_check', { files: ['a.spec.ts'] })).text;
  assert.match(out, /a\.spec\.ts:2 — cor:[0-9a-f]{6} was issued for another element on this page/, out);
  assert.doesNotMatch(out, /a\.spec\.ts:4/, 'the same element written another way is fine');
});

test('U9 review: the scanner sees page.$, browser.$, cy.xpath and cy.findBy*, and skips Testing Library screen queries', () => {
  const src = [
    "await page.$('.a');", "await browser.$('#b');", "cy.xpath('//c');", "cy.findByRole('button');",
    "render(<App />); screen.getByRole('button');",
  ].join('\n');
  assert.deepEqual(scanLocators(src).map((s) => s.line), [1, 2, 3, 4]);
});

test('U9 review: nothing changed on the branch is said plainly, not reported as a pass', async (t) => {
  const dir = project('nochange');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  g('remote', 'add', 'origin', dir); g('fetch', '-q', 'origin');
  const { call } = await connect(t, dir);
  assert.match((await call('cor_check')).text, /^cor_check: no test or locator files changed on this branch — nothing to check\. Pass all: true/);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== '.git').sort(), ['package.json']);
});
