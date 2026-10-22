// P8a (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md, origin docs/brainstorms/2026-10-06-cor-record-reuse-requirements.md):
// page records and pending entries — an entry is pending until its id is in code; a record knows its state, the steps
// that reach it, the page a control leads to, and the code that uses it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p8a-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIRS = [new URL('./fixtures/', import.meta.url), new URL('../scripts/conformance/fixtures/', import.meta.url)];
const site = createHttpServer((req, res) => {
  for (const dir of DIRS) {
    let body;
    try { body = readFileSync(new URL(`${req.url.slice(1).split('?')[0]}.html`, dir)); } catch { continue; }
    return res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  }
  res.writeHead(404).end();
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t) {
  const dir = join(root, Math.random().toString(16).slice(2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: createRecordStore({ root: () => session.root }) });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
  return { dir, call };
}
const idOf = (text) => /cor:([0-9a-f]{6})/.exec(text)[1];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const ids = (dir, d) => { try { return readdirSync(join(dir, '.cor', d)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } };
const placeIn = (dir, file, list) => writeFileSync(join(dir, file), list.map((id) => `// COR cor:${id} · m${id}\nconst m${id} = (page) => page.locator('#m');`).join('\n'));

test('P8a an entry is pending (git-ignored) until cor_check finds its id in code; then it is a record that knows where it is used', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p8a-start` });
  const id = idOf(await call('cor_inspect', { selector: 'h1' }));
  assert.deepEqual([ids(dir, 'records'), ids(dir, 'pending')], [[], [id]]);
  assert.match(readFileSync(join(dir, '.cor/pending/.gitignore'), 'utf8'), /^\*$/m);
  placeIn(dir, 'start.spec.js', [id]);
  await call('cor_check', { files: ['start.spec.js'] });
  assert.deepEqual([ids(dir, 'records'), ids(dir, 'pending')], [[id], []]);
  const record = json(join(dir, `.cor/records/${id}.json`));
  assert.deepEqual([record.v, record.state, record.kind, record.usedIn], [2, 'initial', 'single', [{ file: 'start.spec.js', line: 2 }]]);
  writeFileSync(join(dir, 'start.spec.js'), `\n\n${readFileSync(join(dir, 'start.spec.js'), 'utf8')}`); // the code moved
  await call('cor_check', { files: ['start.spec.js'] });
  assert.deepEqual(json(join(dir, `.cor/records/${id}.json`)).usedIn, [{ file: 'start.spec.js', line: 4 }]);
});

test('P8a an element revealed by an act records that state; placing it keeps the toggle its state replays (R7, R11, AE3)', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-card-price` });
  await call('cor_click', { target: 'label[for=t2]' });
  const price = idOf(await call('cor_inspect', { selector: '.card:nth-child(1) .card__price:not([hidden])' }));
  const record = json(join(dir, `.cor/pending/${price}.json`));
  assert.match(record.state, /^s[0-9a-f]{6}$/);
  assert.equal(record.kind, 'item');
  assert.deepEqual(record.values, ['Team', 'Team Ultimate']);
  const page = json(join(dir, '.cor/pages/p3-card-price.json'));
  const [step] = page.states[record.state].steps;
  // the label names its card (P3 name leaf): the step carries the label's own value
  assert.deepEqual([step.action, step.value], ['click', 'Team Pro']);
  assert.equal(json(join(dir, `.cor/pending/${step.id}.json`)).member, 'cardName', 'the toggle is a record: the step names it, never a selector');
  placeIn(dir, 'pricing.spec.js', [price]); // the agent wrote its own toggle click
  await call('cor_check', { files: ['pricing.spec.js'] });
  assert.deepEqual(ids(dir, 'records'), [price, step.id].sort(), 'the toggle is kept: the price\'s state depends on it');
});

test('P8a an element seen in an earlier state keeps it when re-inspected after more acts (b14ddae4)', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-card-price` });
  const h3 = idOf(await call('cor_inspect', { selector: '.card:nth-child(2) h3' }));
  await call('cor_click', { target: 'label[for=t2]' });
  assert.equal(idOf(await call('cor_inspect', { selector: '.card:nth-child(2) h3' })), h3);
  assert.equal(json(join(dir, `.cor/pending/${h3}.json`)).state, 'initial');
});

test('P8a a step on a template element carries its value', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-card-price` });
  await call('cor_click', { target: 'input#t2' });
  const price = idOf(await call('cor_inspect', { selector: '.card:nth-child(1) .card__price:not([hidden])' }));
  const { state } = json(join(dir, `.cor/pending/${price}.json`));
  const [step] = json(join(dir, '.cor/pages/p3-card-price.json')).states[state].steps;
  assert.deepEqual([step.action, step.value, json(join(dir, `.cor/pending/${step.id}.json`)).kind], ['click', 'Team Pro', 'group']);
});

test('P8a a control that opens another page records leadsTo; that page records how it is reached (R2, R6); a fill is a step with its value', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p8a-start` });
  await call('cor_fill', { target: 'input[name=q]', value: 'mug' });
  await call('cor_click', { target: 'a[href="/p8a-next"]' });
  const heading = idOf(await call('cor_inspect', { selector: 'h1' }));
  assert.equal(json(join(dir, `.cor/pending/${heading}.json`)).state, 'initial', 'a new page starts as opened');
  const reach = json(join(dir, '.cor/pages/p8a-next.json')).reach;
  assert.equal(reach.from, 'p8a-start');
  assert.deepEqual(reach.steps.map((s) => [s.action, s.value]), [['fill', 'mug'], ['click', null]]);
  assert.equal(json(join(dir, `.cor/pending/${reach.steps[1].id}.json`)).leadsTo, 'p8a-next');
  placeIn(dir, 'next.spec.js', [heading]);
  await call('cor_check', { files: ['next.spec.js'] });
  assert.deepEqual(ids(dir, 'records'), [heading, ...reach.steps.map((s) => s.id)].sort(), 'the steps that reach the page are kept');
});

test('P8a a version-1 record is still read (state unknown); a full cor_check sends records no code uses to pending, and old pending entries expire (R12, R21, R22)', async (t) => {
  const { dir, call } = await connect(t);
  mkdirSync(join(dir, '.cor/records'), { recursive: true });
  mkdirSync(join(dir, '.cor/pending'), { recursive: true });
  const v1 = (id) => ({ v: 1, id, page: `${base}/p8a-start`, elementKey: id, member: `m${id}`, fingerprint: { tag: 'h1', attrs: {}, text: 'Start' }, strategies: [{ kind: 'css', value: 'h1' }], created: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) });
  for (const id of ['aaaaa1', 'aaaaa2']) writeFileSync(join(dir, `.cor/records/${id}.json`), JSON.stringify(v1(id)));
  writeFileSync(join(dir, '.cor/pending/bbbbb1.json'), JSON.stringify({ ...v1('bbbbb1'), v: 2, created: '2020-01-01' }));
  assert.equal(createRecordStore({ root: () => dir }).read('aaaaa1').state, null);
  placeIn(dir, 'start.spec.js', ['aaaaa1']);
  await call('cor_check', { all: true });
  assert.deepEqual([ids(dir, 'records'), ids(dir, 'pending')], [['aaaaa1'], ['aaaaa2']]);
});

test('P8a with records off, acts write nothing', async (t) => {
  const dir = join(root, 'off'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '1' } }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: createRecordStore({ root: () => session.root, enabled: false }) });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  await client.callTool({ name: 'cor_open', arguments: { url: `${base}/p8a-start` } });
  await client.callTool({ name: 'cor_click', arguments: { target: 'a[href="/p8a-next"]' } });
  await client.callTool({ name: 'cor_inspect', arguments: { selector: 'h1' } });
  assert.equal(existsSync(join(dir, '.cor')), false);
});

test('P8a (b14ddae4) a step added to a member is not runnable alone: cor_check says so instead of "open the page"', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/p8a-start` });
  writeFileSync(join(dir, 'start.spec.js'), "test('x', async ({ page }) => {\n  const q = await start.items().locator('p.question');\n});\n");
  const out = await call('cor_check', { files: ['start.spec.js'] });
  assert.match(out, /COR cannot run this locator on its own \(it builds on another member\)/, out);
  assert.doesNotMatch(out, /Open the page it targets/);
});
