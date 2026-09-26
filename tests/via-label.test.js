// Hidden checkboxes/radios operated through a visible label (custom toggles).
// Found in an agent run on BrowserStack pricing (2026-09-25): the "For Teams /
// For Individuals" switch was absent from the snapshot, and the agent wrote
// six DOM probes (~36k chars) to find it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

let base;
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./fixtures/toggles.html', import.meta.url), 'utf8'));
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
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
  page = await session.getPage();
});

const fresh = () => call('cor_open', { url: `${base}/` });
const refOf = (snap, re) => re.exec(snap)?.[1];

test('hidden radios and a checkbox with visible labels are listed [via label]; a fully hidden one is not', async () => {
  await fresh();
  const snap = await call('cor_snapshot');
  assert.match(snap, /radio "For Teams" \[ref=e\d+\] \[via label\]/);
  assert.match(snap, /radio "For Individuals" \[ref=e\d+\] \[checked\] \[via label\]/);
  assert.match(snap, /checkbox "Bill annually" \[ref=e\d+\] \[via label\]/);
  assert.match(snap, /radio "Small" \[ref=e\d+\]$/m, 'a visible radio is listed as before');
  assert.doesNotMatch(snap, /For Enterprises/);
  assert.doesNotMatch(snap, /"For Teams".*hidden/, 'the input is not counted as a hidden copy of itself');
  assert.match(snap, /\[via label\]: a hidden input shown by its label/);
});

test('the legend line appears only when a [via label] element is shown', async () => {
  await call('cor_open', { url: 'data:text/html,<button>One</button>' });
  assert.doesNotMatch(await call('cor_snapshot'), /via label/);
});

test('inspect says to click the label and assert on the input — and both work in Playwright', async () => {
  await fresh();
  const snap = await call('cor_snapshot');
  const out = await call('cor_inspect', { ref: refOf(snap, /radio "For Teams" \[ref=(e\d+)\]/) });
  // U21: the group template says it (change it / check it); the single-item
  // note is left out rather than repeat a page-wide click beside a scoped one.
  assert.match(out, /change it: page\.(?:locator\('[^']+'\)\.)?getByText\(plan, \{ exact: true \}\)\.click\(\)/, out);
  assert.match(out, /check it: {2}page\.getByLabel\(plan, \{ exact: true \}\)/);
  assert.doesNotMatch(out, /Hidden input, operated through its visible label/);
  await page.getByText('For Teams', { exact: true }).click();
  assert.equal(await page.getByLabel('For Teams', { exact: true }).isChecked(), true);
  assert.equal(await page.textContent('#plan'), 'teams');
});

test('acting on the ref changes the toggle, and the diff reports it', async () => {
  await fresh();
  const snap = await call('cor_snapshot');
  const out = await call('cor_click', { ref: refOf(snap, /radio "For Teams" \[ref=(e\d+)\]/) });
  assert.match(out, /~ radio "For Teams": now checked/);
  assert.match(out, /~ radio "For Individuals": no longer checked/);
  assert.equal(await page.textContent('#plan'), 'teams');
});
