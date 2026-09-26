// From the plain-prompt BrowserStack run (2026-09-26), gaps 3 and 5:
// 3. The agent never inspected a comparison cell, so COR's row × column
//    template (U19.4) never reached it; it computed the column from the header
//    index. A row's scoped snapshot now lists its cells by column, with refs.
// 5. It typed the FAQ questions into the test, so a new question would go
//    untested; the instructions even said to use the listed values as test
//    data. Templates now give the every-item locator to loop over.
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
  const file = req.url === '/faq' ? 'faq.html' : 'compare.html';
  res.end(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let raw;
let client;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  raw = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
});

test('a row\'s scoped snapshot lists its cells by column, each with a ref', async () => {
  await raw('cor_open', { url: `${base}/` });
  await raw('cor_snapshot');
  const out = await raw('cor_snapshot', { within: 'Bug Capture' });
  assert.match(out, /^- cell "Feature List" \[ref=e\d+\]: "Bug Capture"$/m, out);
  assert.match(out, /^- cell "Team" \[ref=e\d+\]: \(empty\)$/m);
  assert.match(out, /^- cell "Team Ultimate" \[ref=e\d+\]: img "Feature included"$/m);
  assert.match(out, /^- cell "Enterprise" \[ref=e\d+\]: "Contact Sales"$/m);
});

test('inspecting a listed cell gives the row × column template', async () => {
  await raw('cor_open', { url: `${base}/` });
  await raw('cor_snapshot');
  const out = await raw('cor_snapshot', { within: 'Bug Capture' });
  const ref = /cell "Team Ultimate" \[ref=(e\d+)\]/.exec(out)[1];
  const inspected = await raw('cor_inspect', { ref });
  assert.match(inspected, /"Bug Capture"/, inspected);
  assert.match(inspected, /"Team Ultimate"/);
  assert.match(inspected, /xpath=/);
});

test('a plain table row lists its cells by header too', async () => {
  const page = await session.getPage();
  await page.setContent('<table class="users"><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ada</td><td>Admin</td></tr><tr><td>Grace</td><td><a href="#g">Viewer</a></td></tr></tbody></table>');
  await raw('cor_snapshot');
  const out = await raw('cor_snapshot', { within: 'Grace' });
  assert.match(out, /^- cell "Name" \[ref=e\d+\]: "Grace"$/m, out);
  assert.match(out, /^- cell "Role" \[ref=e\d+\]: link "Viewer"$/m);
});

test('a template names the every-item locator, to loop over when the test covers every item', async () => {
  await raw('cor_open', { url: `${base}/faq` });
  const out = await raw('cor_inspect', { selector: '.faq-item:nth-child(1) .faq-item__answer' });
  assert.match(out, /^ {2}Every item \(3 now\): page\.locator\('div\.faq-item'\) — loop over it \(for \(const item of await …\.all\(\)\)\) when the test covers every item, so one added later is tested too\.$/m, out);
});

test('the instructions: loop for "every" scenarios; listed values only for named items; tables via the row', async () => {
  const text = client.getInstructions();
  assert.doesNotMatch(text, /use the listed values as test data when a data-driven test fits/);
  assert.match(text, /When the test covers every item .* loop over the Every item locator instead of typing the values/);
  assert.match(text, /To read a table value, cor_snapshot within the row's name — it lists the row's cells by column with refs — then cor_inspect the cell/);
});
