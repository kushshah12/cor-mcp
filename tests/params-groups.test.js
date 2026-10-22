// U18b.1 — control groups: siblings of one role told apart by their names
// (a radio group, a tablist, a hidden toggle pair). From the BrowserStack
// comparison: both agents hand-wrote `annually()` / `monthly()` and the
// Teams/Individuals pair as copies; neither parameterised them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { verifyTemplate } from '../src/tools/inspect.js';
import { interpolateTemplate } from './helpers/interpolate.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/control-groups.html', import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let call;
let page;
// One hook: node:test does not wait for one root-level before() to finish before starting the next.
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
  await call('cor_open', { url: `${base}/` });
  page = await session.getPage();
});

const params = async (selector) => {
  const p = (await callPage(page, 'inspect', { selector, framework: 'playwright', max: 1 })).params;
  await verifyTemplate(page, p);
  return p;
};
const run = (code, name, value) => new Function('page', name, `return ${code};`)(page, value);
const registry = (p, v) => interpolateTemplate({ selectorTemplate: p.template.playwright.selectorTemplate, vars: [{ varName: p.param, syntax: p.template.playwright.syntax }] }, { [p.param]: v });

test('a radio group: one template, the parameter named after the group, stable names only', async () => {
  const p = await params('input[value="annual"]');
  assert.equal(p.kind, 'group');
  assert.equal(p.param, 'billingCycle');
  assert.deepEqual(p.values, ['Annually', 'Monthly'], 'the promo "(Save upto 25%)" is not part of a value');
  assert.equal(p.counted, 2, 'Playwright counted every value');
  for (const v of p.values) {
    assert.equal(await run(p.code, p.param, v).count(), 1, v);
    assert.equal(await page.locator(registry(p, v)).count(), 1, v);
  }
  assert.equal(await run(p.code, p.param, 'Monthly').evaluate((el) => el.value), 'monthly');
});

test('a hidden toggle pair: change through the label, assert through getByLabel — both work', async () => {
  const p = await params('#pt2');
  assert.equal(p.kind, 'group');
  assert.equal(p.param, 'planTypeSelector');
  assert.deepEqual(p.values, ['For Teams', 'For Individuals']);
  assert.ok(p.act, 'a separate act form for a hidden input');
  await run(p.act, p.param, 'For Individuals').click();
  await assertChecked(run(p.code, p.param, 'For Individuals'));
  assert.equal(await page.textContent('#state'), 'plan_type_selector=individuals');
  await run(p.act, p.param, 'For Teams').click();
  await assertChecked(run(p.code, p.param, 'For Teams'));
});
const assertChecked = async (loc) => assert.equal(await loc.isChecked(), true);

test('a tablist: tabs by name', async () => {
  const p = await params('[role="tab"]:nth-child(2)');
  assert.equal(p.kind, 'group');
  assert.equal(p.param, 'product');
  assert.deepEqual(p.values, ['Live', 'Automate', 'Percy']);
  for (const v of p.values) assert.equal(await run(p.code, p.param, v).count(), 1, v);
});

test('two options with the same name: no template, and the reason', async () => {
  const p = await params('input[name="ship"][value="b"]');
  assert.equal(p.template, undefined);
  assert.match(p.reason, /two options share the name "Standard"/);
  assert.match(await call('cor_inspect', { selector: 'input[name="ship"][value="b"]' }), /Not parameterised — 2 options in this radio group, but two options share the name "Standard"\./);
});

test('a lone radio is not a group', async () => {
  assert.equal(await params('input[name="solo"]'), null);
});

test('cor_inspect renders the group template, with the act form for a hidden toggle', async () => {
  const out = await call('cor_inspect', { selector: '#pt2' });
  assert.match(out, /^Recommended — parameterised: 2 options in this radio group/m);
  assert.match(out, /planTypeSelector = "For Individuals"/);
  // U21: scoped to the toggle's container (the fixture repeats "For Teams" in a promo line).
  assert.match(out, /change it: page\.locator\('div\.toggle'\)\.getByText\(planTypeSelector, \{ exact: true \}\)\.click\(\)/);
  assert.match(out, /page\.getByLabel\(planTypeSelector, \{ exact: true \}\)/);
});
