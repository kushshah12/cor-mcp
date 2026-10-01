import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { numberedIds } from '../src/id-stability.js';
import { expandGroups } from './helpers/outline.js';

// Like selectorshub: the Email field's id is a fresh number on every load.
// `step2` is a real numbered name; `panel7` exists only after a click.
let loads = 0;
const page = () => `<!doctype html><title>Form</title>
  <label for="shub${10 + loads}">Email</label><input id="shub${10 + loads}" placeholder="Enter email">
  <button id="step2">Next step</button>
  <button id="open" onclick="this.insertAdjacentHTML('afterend', '<div id=panel7 tabindex=0>Panel</div>')">Open</button>`;

let base;
const site = createHttpServer((req, res) => {
  if (req.url !== '/form') {
    res.writeHead(404);
    return res.end();
  }
  loads++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page());
});
const session = createSession({ headless: true });
let client;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(async () => {
  await session.close();
  site.close();
});

// A fresh server per test, so each starts with an empty id-verdict cache.
async function fresh(t) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  session.resolveFramework('playwright'); // the shared session keeps a framework argument (P1a)
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  await call('cor_open', { url: `${base}/form` });
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: expandGroups(result.content.map((c) => c.text).join('\n')) };
}
const currentEmailId = async () => (await session.getPage()).getAttribute('input', 'id');
const durable = (text) => text.split('\n').find((l) => l.startsWith('// COR:'));

test('inspect: a regenerated id is ranked last, warned, and named as the reason', async (t) => {
  await fresh(t);
  const id = await currentEmailId();
  const out = await call('cor_inspect', { selector: 'input', framework: 'cypress' });
  const lines = out.text.split('\n');
  assert.doesNotMatch(lines[1], new RegExp(id), 'the volatile id is not the answer');
  assert.match(out.text, new RegExp(`Why this order: Demoted #${id} \\(score \\d+\\) — its id changes on every page load \\(${id} was shub\\d+ on a fresh load\\)`));
  // Every locator resting on the id (#shubN, //*[@id="shubN"], …) is warned and sits after every other —
  // in the full list; the default shows a few, and the reason above says why the id lost.
  const full = await call('cor_inspect', { selector: 'input', framework: 'cypress', all: true });
  const blocks = full.text.split('Alternatives:')[1].trim().split(/\n(?=\d+\. )/);
  const onId = blocks.map((b) => b.includes(id));
  assert.ok(onId.some(Boolean));
  assert.deepEqual(onId, [...onId].sort((a, b) => Number(a) - Number(b)), 'id-based locators come last');
  for (const b of blocks.filter((x) => x.includes(id))) assert.match(b, /! Its id changes on every page load/);
  assert.match(durable(out.text), new RegExp(`chosen over cy\\.get\\('#${id}'\\) because its id changes on every page load$`));
});

test('inspect under Playwright: the durable line gives the id reason, not the convention', async (t) => {
  await fresh(t);
  const out = await call('cor_inspect', { selector: 'input' });
  assert.match(out.text.split('\n')[1], /getByRole\('textbox', \{ name: 'Email' \}\)/);
  assert.match(durable(out.text), /because its id changes on every page load$/);
});

test('a numbered id that survives a reload is left alone', async (t) => {
  await fresh(t);
  const out = await call('cor_inspect', { selector: '#step2', framework: 'cypress' });
  assert.equal(out.text.split('\n')[1].trim(), "cy.get('#step2')");
  const warned = out.text.split(/\n(?=\d+\. )/).filter((b) => /page load|Could not confirm/.test(b));
  // Only locators that lean on the *volatile* neighbour (e.g. `#shub15 + button`) are warned.
  assert.ok(warned.every((b) => /#shub\d+/.test(b) && !/step2/.test(b)), warned.join('\n---\n'));
});

test('an id that only exists after an interaction is flagged unconfirmed, not demoted', async (t) => {
  await fresh(t);
  await call('cor_click', { target: '#open' });
  const out = await call('cor_inspect', { selector: '#panel7', framework: 'cypress' });
  assert.equal(out.text.split('\n')[1].trim(), "cy.get('#panel7')");
  assert.match(out.text, /Could not confirm id panel7 survives a reload/);
  assert.doesNotMatch(out.text, /changes on every page load/);
});

test('grade: a selector on a regenerated id reads "Breaks on reload" and gets a durable alternative', async (t) => {
  await fresh(t);
  const id = await currentEmailId();
  const out = await call('cor_grade', { selector: `cy.get('#${id}')` });
  assert.match(out.text.split('\n')[0], new RegExp(`^Breaks on reload — resolves to exactly one element now, but its id changes on every page load \\(${id} was shub\\d+`));
  assert.doesNotMatch(out.text, /^Healthy/m);
  assert.match(out.text, /More durable alternative for the same element \(cypress\):\n\s+cy\.get\('\[placeholder="Enter email"\]'\)|More durable alternative for the same element \(cypress\):\n\s+cy\./);
  assert.doesNotMatch(out.text.split('More durable alternative')[1], /#shub/, 'the alternative is not another volatile id');
  assert.match(out.text, /! Not stable: a fresh load gave this element id shub\d+/);
  assert.equal(durable(out.text), '// COR: anchored on an element id; risk: its id changes on every page load');
  const stable = await call('cor_grade', { selector: "cy.get('#step2')" });
  assert.match(stable.text.split('\n')[0], /^Healthy/);
});

test("the probe leaves the agent's page and refs alone, and runs once per URL", async (t) => {
  await fresh(t);
  const loadsBefore = loads;
  await call('cor_fill', { target: 'input', value: 'kept@x.co' });
  const snap = await call('cor_snapshot');
  const ref = snap.text.match(/textbox "Email" \[ref=(e\d+)\]/)[1];
  const first = await call('cor_inspect', { ref });
  assert.equal(first.isError, false);
  const second = await call('cor_inspect', { ref });
  assert.equal(second.isError, false, 'the probe navigated another tab, not this one — the ref is still live');
  assert.equal(loads - loadsBefore, 1, 'one probe load for two inspects');
  assert.equal(await (await session.getPage()).inputValue('input'), 'kept@x.co');
  assert.equal((await session.getPage()).context().pages().length, 1, 'probe tab closed');
});

test('U14: the snapshot marks an id already found regenerated, and never triggers a reload itself', async (t) => {
  await fresh(t);
  const before = loads;
  const first = await call('cor_snapshot');
  assert.equal(loads, before, 'a snapshot loads nothing');
  const elementLines = (text) => text.split('\n').filter((l) => /\[ref=e\d+\]/.test(l)).join('\n'); // not the legend
  assert.doesNotMatch(elementLines(first.text), /\[unstable id\]/, 'no verdict yet, so no marker');

  await call('cor_inspect', { selector: 'input' }); // runs the reload check once
  const afterInspect = loads;
  const second = await call('cor_snapshot');
  assert.equal(loads, afterInspect, 'still no reload from the snapshot');
  assert.match(elementLines(second.text), /textbox "Email" \[ref=e\d+\] \[unstable id\]/);
  assert.doesNotMatch(second.text.split('\n').find((l) => l.includes('"Next step"')), /unstable/, 'no verdict for step2, so no marker');
});

test('numberedIds reads the id forms locators use', () => {
  assert.deepEqual(numberedIds("#shub63"), ['shub63']);
  assert.deepEqual(numberedIds('form#login2 > input[id="field-12"]'), ['login2', 'field-12']);
  assert.deepEqual(numberedIds("//input[@id='x9']"), ['x9']);
  assert.deepEqual(numberedIds('#email, .row-6, [data-id="7"]'), []);
});
