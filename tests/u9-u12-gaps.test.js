// Testing gaps from the code review (2026-10-05): cor_heal's stored-locator replay per kind and its precondition
// branches; cor_check's finding cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { maxSimilarity, sameIdentity, strategyLocator } from '../src/tools/heal.js';

const root = mkdtempSync(join(tmpdir(), 'cor-gaps-'));
after(() => rmSync(root, { recursive: true, force: true }));
const PAGE = `<title>G</title><main><label for="e">Email</label><input id="e" placeholder="you@x.com" title="Email address">
  <img alt="Logo" src="data:,"><a href="/help">Help</a><button>Save</button>
  ${Array.from({ length: 18 }, (_, i) => `<div class="row"><button class="go">Go</button></div>`).join('')}</main>`;
const site = createHttpServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}/g`; });
after(() => { site.closeAllConnections?.(); site.close(); });

function project(name, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } }));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
}
async function connect(t, dir, { records = true } = {}) {
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const store = records ? createRecordStore({ root: () => session.root }) : null;
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: store });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return {
    session,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
    },
  };
}

test('U12 gap: every stored kind replays as stored — role (with and without a name, exact), text, label, placeholder, title, alt, CSS; templates, positions and aria/ do not', async (t) => {
  const { session, call } = await connect(t, project('kinds'));
  await call('cor_open', { url: base });
  const page = await session.getPage();
  const finds = async (s) => { const loc = strategyLocator(page, s); return loc ? loc.count() : null; };
  assert.equal(await finds({ kind: 'role', value: 'role=button, name=Save' }), 1);
  assert.equal(await finds({ kind: 'roleExact', value: 'role=link, name=Help (exact)' }), 1);
  assert.equal(await finds({ kind: 'role', value: 'role=main' }), 1);
  assert.equal(await finds({ kind: 'role', value: 'role=button, name=Save, now' }), 0, 'a name with ", " is read whole');
  assert.equal(await finds({ kind: 'text', value: 'Help' }), 1);
  assert.equal(await finds({ kind: 'textExact', value: '"Save"' }), 1);
  assert.equal(await finds({ kind: 'label', value: 'Email' }), 1);
  assert.equal(await finds({ kind: 'placeholder', value: 'you@x.com' }), 1);
  assert.equal(await finds({ kind: 'title', value: 'Email address' }), 1);
  assert.equal(await finds({ kind: 'alt', value: 'Logo' }), 1);
  assert.equal(await finds({ kind: 'css', value: 'a[href="/help"]' }), 1);
  for (const s of [{ kind: 'template', value: 'x:has(__name__)' }, { kind: 'css', value: 'div:nth-of-type(2) > button' }, { kind: 'xpath', value: '(//button)[2]' }, { kind: 'aria', value: 'aria/Save' }]) {
    assert.equal(strategyLocator(page, s), null, JSON.stringify(s));
  }
});

test('U12 gap: identity — same tag and text pass; changed text needs an identifying attribute; the bar is relative', () => {
  const rec = { tag: 'button', attrs: { name: 'save' }, text: 'Save' };
  assert.equal(sameIdentity(rec, { tag: 'button', attrs: { name: 'save' }, text: 'Store' }), true);
  assert.equal(sameIdentity(rec, { tag: 'button', attrs: { name: 'other' }, text: 'Store' }), false);
  assert.equal(sameIdentity(rec, { tag: 'a', attrs: { name: 'save' }, text: 'Save' }), false);
  assert.equal(maxSimilarity({ tag: 'button', attrs: {}, text: 'Go' }), 0.45);
  assert.equal(maxSimilarity({ tag: 'input', attrs: { name: 'q' }, text: null }), 0.8);
});

test('U12 gap: preconditions — no page, records off with no id, nothing lost on the page, a still-working locator', async (t) => {
  const off = await connect(t, project('off'), { records: false });
  assert.match((await off.call('cor_heal', { id: 'abcabc' }).catch((e) => ({ text: e.message }))).text, /No page is open|No record/);
  await off.call('cor_open', { url: base });
  assert.match((await off.call('cor_heal', { locator: "page.locator('#gone')" })).text, /^No cor: id, and records are off — COR has nothing to heal from/);
  const on = await connect(t, project('on'));
  await on.call('cor_open', { url: base });
  await on.call('cor_inspect', { selector: 'a' });
  assert.match((await on.call('cor_heal', { locator: "page.locator('#gone')" })).text, /^No cor: id on this locator, and every recorded element on this page is still found/);
  assert.match((await on.call('cor_heal', { locator: "page.getByRole('link', { name: 'Help' })" })).text, /^Healthy — it still finds exactly one element/);
});

test('U9 gap: more than 15 findings — the first 15 with fixes, then a count; fixes run only for those shown', async (t) => {
  const lines = Array.from({ length: 18 }, (_, i) => `page.locator('.row .go').nth(${i});`).join('\n');
  const dir = project('many', { 'a.spec.ts': `${lines}\n` });
  const { call } = await connect(t, dir);
  await call('cor_open', { url: base });
  const out = (await call('cor_check', { files: ['a.spec.ts'] })).text;
  assert.match(out, /^cor_check: 18 locators in 1 file \(the given files\) — 0 carry a COR id, 18 to fix\./);
  assert.equal((out.match(/^✗ /gm) ?? []).length, 15);
  assert.match(out, /… 3 more — fix these and run cor_check again\.$/);
});
