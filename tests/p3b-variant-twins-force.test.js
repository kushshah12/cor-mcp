// P3b follow-ups from benchmark run 6d4dad1b (Cypress, 39 turns vs 15): the variant click waits for the toggle to be checked
// (the agent clicked Choose before the card swapped and reached checkout for "Live - Team"), a fact warns that twin buttons make
// a state-named class break (it wrote `input.live-team-pro`), and hidden inputs are never force-clicked (it forced the radio).
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
import { factsFor } from '../src/facts.js';

const FIXTURES = new URL('../scripts/conformance/fixtures/', import.meta.url);
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  try { res.end(readFileSync(new URL(`.${req.url.split('?')[0]}`, FIXTURES), 'utf8')); } catch { res.end('missing'); }
});
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, framework) {
  const cwd = mkdtempSync(join(tmpdir(), 'p3bf-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ devDependencies: { [framework]: '^16.1.0' } }));
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
}

const model = (over = {}) => ({
  kind: 'item', param: 'title', item: { css: 'div.plan', visible: false }, toggle: 'label',
  leaf: { role: 'button', name: 'Choose', css: null, aria: true, twins: true, cy: { css: 'button', shown: true } },
  slot: { kind: 'either', sels: ['h3', 'label'], transformed: false }, ...over,
});
const RECORD = { runs: [{ major: 16, version: '16.1.1', idioms: Object.fromEntries(idiomsOf('cypress').map((id) => [id, { ok: true }])) }] };

test('P3b follow-up: the Cypress variant click ends by waiting for its toggle to be checked', () => {
  const out = renderHelper('cypress', { model: model(), values: ['a', 'b'], variantAct: 'x' }, { record: RECORD, major: 16 });
  const click = out.uses.at(-1);
  assert.match(click, /\.click\(\)\n {2}\.closest\('label'\)\.then\(\(\$label\) => cy\.wrap\(\$label\[0\]\.control\)\)\.should\('be\.checked'\)$/);
  assert.ok(click.split('\n').every((l) => l.length <= 120));
  assert.deepEqual(out.idioms.slice(-1), ['variant.click']);
});

test('P3b follow-up: the Variants line says to wait (Cypress); the WebdriverIO line is unchanged', async (t) => {
  const cy = await connect(t, 'cypress');
  await cy('cor_open', { url: `${base}/p3a-either.html` });
  const outCy = await cy('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(outCy, /Variants: "Team Pro" sits behind the "Team" item's toggle — the helper's last line clicks it and waits until the toggle is checked — act on the item only after that, then the helper finds that item\./);
  assert.match(outCy, /\.should\('be\.checked'\)/);
  const wd = await connect(t, 'webdriverio');
  await wd('cor_open', { url: `${base}/p3a-either.html` });
  const outWd = await wd('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(outWd, /clicks it, then the helper finds that item\./);
  assert.doesNotMatch(outWd, /waits until the toggle is checked/);
});

test('P3b follow-up: twin buttons get a fact; items without twins do not', async (t) => {
  const call = await connect(t, 'cypress');
  await call('cor_open', { url: `${base}/p3a-either.html` });
  const twins = await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' });
  assert.match(twins, /^ {2}• each item holds twin buttons, one per toggle state — a class naming one breaks when the toggle moves; use the helper's leaf$/m);
  await call('cor_open', { url: `${base}/p3a-attribute.html` });
  assert.doesNotMatch(await call('cor_inspect', { selector: '[data-testid="sku-beta"] button' }), /twin buttons/);
  for (const f of factsFor({ params: { model: { leaf: { twins: true } } } })) assert.ok(f.text.length <= 140, f.text);
  assert.equal(factsFor({ params: { model: { leaf: { cy: { shown: true } } } } })[0].type, 'twin-controls', 'the Cypress shown flag counts too');
});

test('P3b follow-up: hidden inputs are never force-clicked — the fact and the group line say so', async (t) => {
  assert.match(factsFor({ viaLabel: 'x' })[0].text, /forcing a click on the input skips what a user does/);
  for (const framework of ['cypress', 'webdriverio']) {
    const call = await connect(t, framework);
    await call('cor_open', { url: `${base}/p3a-groups.html` });
    const out = await call('cor_inspect', { selector: 'input[value="individuals"]' });
    assert.match(out, /The inputs are hidden: the last line clicks their label, as a user does — assert the option's selected state, not that it exists\. Do not force-click the input\./, framework);
  }
});
