// U12 — cor_heal proposes a broken locator's replacement from its committed record and never applies it. The mutation
// cases calibrate the thresholds in src/tools/heal.js: across them, 0 wrong-element heals (R36) — when COR is unsure it
// declines.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const root = mkdtempSync(join(tmpdir(), 'cor-u12-'));
after(() => rmSync(root, { recursive: true, force: true }));

// One shop page, mutated by ?m=: the release that broke a locator.
const PRODUCTS = ['Mug', 'Pen', 'Cap'];
function shop(m) {
  const products = m === 'moved' ? [...PRODUCTS].reverse() : m === 'removed' ? PRODUCTS.filter((p) => p !== 'Mug') : PRODUCTS;
  const cards = products.map((p) => {
    const test = m === 'renamed' ? `add-cart-${p.toLowerCase()}` : `add-to-cart-${p.toLowerCase()}`;
    return `<div class="card" data-test="product-card"><h3>${p}</h3><button class="buy" data-test="${test}" name="add-${p.toLowerCase()}">Add to cart</button></div>`;
  }).join('\n');
  const save = m === 'text' ? '<button class="save" aria-label="Save draft" data-test="save-draft">Store</button>' : '<button class="save" aria-label="Save draft" data-test="save-draft">Save</button>';
  return `<!doctype html><title>Shop</title><main>${cards}\n${save}<button class="go" type="submit" name="go">Go</button><button class="cancel">Cancel</button></main>`;
}
const site = createHttpServer((req, res) => {
  const m = new URL(req.url, 'http://x').searchParams.get('m');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(shop(m));
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}/shop`; });
after(() => { site.closeAllConnections?.(); site.close(); });

function project(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } }));
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
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  return { call, session, records };
}
const idOf = (s) => /cor:([0-9a-f]{6})/.exec(s)?.[1];
/** Record an entry on the unmutated page; return its id and the line an agent would have placed. */
async function issue(call, selector) {
  await call('cor_open', { url: base });
  const out = (await call('cor_inspect', { selector })).text;
  const entry = out.split('\n').slice(out.split('\n').findIndex((l) => l.startsWith('Entry — ')));
  return { id: idOf(out), line: `${entry[1].trim()}\n${entry[2].trim()}` };
}
/** Which element does the proposed entry's locator find on the open page? Its name attribute, or its text. */
async function proposedTarget(session, out, value = null) {
  const m = /= \((\w*)(?:: string)?\) => (this\.page\.[^\n]+);$/m.exec(out);
  assert.ok(m, `no proposal code in\n${out}`);
  const [, param, body] = m;
  const page = await session.getPage();
  const loc = new Function('page', param || '_', `return ${body.replaceAll('this.page', 'page')};`)(page, value);
  assert.equal(await loc.count(), 1, body);
  return loc.evaluate((el) => el.getAttribute('name') ?? el.textContent.trim());
}

test('U12 (AE9) renamed test attribute: a stored locator finds the same button; proposed with the same id, not applied', async (t) => {
  const dir = project('renamed');
  const { call, session } = await connect(t, dir);
  const { id, line } = await issue(call, '[data-test="add-to-cart-pen"]');
  const before = readdirSync(dir).sort();
  await call('cor_open', { url: `${base}?m=renamed` });
  const out = (await call('cor_heal', { locator: line })).text;
  assert.match(out, new RegExp(`^Heal for cor:${id} `), out);
  assert.match(out, /Evidence: stored .* still finds exactly one element, and it matches the recorded fingerprint/);
  assert.match(out, /Proposed — not applied/);
  assert.match(out, new RegExp(`// COR cor:${id} ·`), 'the same id');
  assert.equal(await proposedTarget(session, out, 'Pen'), 'add-pen', 'the same element — never a sibling card');
  assert.deepEqual(readdirSync(dir).sort(), before, 'nothing written');
});

test('U12 moved element: the locator still finds it — Healthy, no heal', async (t) => {
  const { call } = await connect(t, project('moved'));
  const { id } = await issue(call, '[data-test="add-to-cart-cap"]');
  await call('cor_open', { url: `${base}?m=moved` });
  const healthy = (await call('cor_heal', { locator: `// COR cor:${id}\npage.locator('[data-test="add-to-cart-cap"]')` })).text;
  assert.match(healthy, /^Healthy — it still finds exactly one element/, healthy);
});

test('U12 changed text: the button is found by a stored attribute and the proposal follows the new page', async (t) => {
  const { call, session } = await connect(t, project('text'));
  const { id } = await issue(call, '[data-test="save-draft"]');
  await call('cor_open', { url: `${base}?m=text` });
  const out = (await call('cor_heal', { id })).text;
  assert.match(out, /Proposed — not applied/, out);
  assert.equal(await proposedTarget(session, out), 'Store');
});

test('U12 removed element: declines — never proposes a sibling card that merely looks the same', async (t) => {
  const { call } = await connect(t, project('removed'));
  const { id } = await issue(call, '[data-test="add-to-cart-mug"]');
  await call('cor_open', { url: `${base}?m=removed` });
  const out = (await call('cor_heal', { id })).text;
  assert.match(out, /^Heal for cor:[0-9a-f]{6} .*\nDeclined — no stored locator finds it, and no element is close enough/, out);
  assert.doesNotMatch(out, /Proposed/);
});

test('U12 similarity heal: no stored locator works, one element matches the fingerprint with a clear lead', async (t) => {
  const dir = project('similar');
  const { call, session } = await connect(t, dir);
  await call('cor_open', { url: base });
  mkdirSync(join(dir, '.cor/records'), { recursive: true });
  const page = new URL(base);
  writeFileSync(join(dir, '.cor/records/abcabc.json'), JSON.stringify({ v: 1, id: 'abcabc', page: `${page.origin}${page.pathname}`, elementKey: 'x',
    fingerprint: { tag: 'button', attrs: { type: 'submit', name: 'go' }, text: 'Go', classes: ['go'] }, strategies: [{ kind: 'testId', value: '[data-test="go-old"]' }], created: '2026-10-05' }));
  const out = (await call('cor_heal', { id: 'abcabc' })).text;
  assert.match(out, /Evidence: no stored locator finds it; fingerprint similarity 1\.00 \(next element 0\.\d\d\)/, out);
  assert.equal(await proposedTarget(session, out), 'go');
});

test('U12 (AE10) a reformatted locator line heals by its id', async (t) => {
  const { call } = await connect(t, project('reformatted'));
  const { id } = await issue(call, '[data-test="add-to-cart-pen"]');
  await call('cor_open', { url: `${base}?m=renamed` });
  const out = (await call('cor_heal', { locator: `// COR cor:${id} · edited\nbuyPen = () =>\n  this.page.locator("[data-test='add-to-cart-pen']")` })).text;
  assert.match(out, new RegExp(`^Heal for cor:${id} `), out);
  assert.match(out, /Proposed — not applied/);
});

test('U12 (AE12) a committed record heals in a fresh session with only the checkout', async (t) => {
  const dir = project('checkout');
  const first = await connect(t, dir);
  const { id } = await issue(first.call, '[data-test="add-to-cart-pen"]');
  await first.session.close();
  const fresh = await connect(t, dir);
  await fresh.call('cor_open', { url: `${base}?m=renamed` });
  assert.match((await fresh.call('cor_heal', { id })).text, /Proposed — not applied/);
});

test('U12 (R45) no id: the page\'s elements that lost every locator are listed, without claiming which one was meant', async (t) => {
  const dir = project('noid');
  const { call } = await connect(t, dir);
  const mug = (await issue(call, '[data-test="add-to-cart-mug"]')).id;
  const draft = (await issue(call, '[data-test="save-draft"]')).id;
  // P8a: only placed elements are listed — cor_check places the ids it finds in code
  writeFileSync(join(dir, 'shop.spec.js'), [mug, draft].map((id) => `// COR cor:${id} · x\nconst x${id} = (page) => page.locator('#x');`).join('\n'));
  await call('cor_check', { files: ['shop.spec.js'] });
  await call('cor_open', { url: `${base}?m=removed` });
  const out = (await call('cor_heal', { locator: "page.locator('[data-test=\"add-to-cart-mug\"]')" })).text;
  assert.match(out, /^No cor: id on this locator, so COR cannot tell which element it meant\. 1 recorded element on this page lost every recorded locator — match by hand:/, out);
  assert.match(out, new RegExp(`cor:${mug} — was `));
  assert.match(out, /Declined —/, 'the removed Mug is not "healed" onto Pen or Cap');
});

test('U12 unknown id and wrong page are said plainly', async (t) => {
  const { call } = await connect(t, project('errors'));
  const { id } = await issue(call, '[data-test="save-draft"]');
  assert.match((await call('cor_heal', { id: 'ffffff' })).text, /No record for cor:ffffff in \.cor\/records\//);
  await call('cor_open', { url: base.replace('/shop', '/other') });
  assert.match((await call('cor_heal', { id })).text, /was recorded on .*\/shop; this page is .*\/other\. cor_open that page/);
});
