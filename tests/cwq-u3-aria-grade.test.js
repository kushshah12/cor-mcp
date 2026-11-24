// cwq-u3: the grader counts WebdriverIO aria/<name> with the measured semantics in src/page/aria.js, instead of refusing it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { parseGradable } from '../src/grade-parse.js';

let base;
const site = createHttpServer((req, res) => {
  try {
    const html = readFileSync(new URL(`./fixtures/${req.url.slice(1)}`, import.meta.url));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
const sessions = [createSession({ headless: true }), createSession({ headless: true })];
const clients = [];

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  for (const session of sessions) {
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cwq-u3', version: '0' });
    await Promise.all([createServer({ session }).connect(s), client.connect(c)]);
    clients.push(client);
  }
});
after(async () => {
  for (const c of clients) await c.close();
  for (const s of sessions) await s.close();
  site.close();
});

const call = async (i, name, args) => {
  const r = await clients[i].callTool({ name, arguments: args });
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
};
const grade = (selector, i = 0) => call(i, 'cor_grade', { selector, framework: 'webdriverio' });

test('cwq-u3 (AE3): $(\'aria/Email\') counts one match — the labelled input', async () => {
  await call(0, 'cor_open', { url: `${base}/cwq-u3-aria.html` });
  const out = await grade("$('aria/Email')");
  assert.equal(out.isError, false, out.text);
  assert.doesNotMatch(out.text, /not graded yet/);
  assert.match(out.text, /· 1 match\b/, out.text);
});

test('cwq-u3: a name two controls answer to is ambiguous', async () => {
  await call(0, 'cor_open', { url: `${base}/cwq-u3-aria.html` });
  const out = await grade("$('aria/Save')");
  assert.match(out.text, /^Ambiguous — matches 2 elements/m, out.text);
});

test('cwq-u3: hidden controls count (as in WebdriverIO); plain text does not', async () => {
  await call(0, 'cor_open', { url: `${base}/cwq-u3-aria.html` });
  // counted through the parser + engine directly, so the hidden element's count is not filtered by any tool policy
  const live = await sessions[0].getPage();
  assert.equal(await parseGradable("$('aria/Archive')").build(live).count(), 1);
  assert.equal(await parseGradable("$('aria/Plain words')").build(live).count(), 0);
});

test('cwq-u3: aria/ inside a chain counts within the step', async () => {
  await call(0, 'cor_open', { url: `${base}/cwq-u3-aria.html` });
  const out = await grade("$('//tr[td[normalize-space()=\"alice\"]]').$('aria/Open menu')");
  assert.match(out.text, /· 1 match\b/, out.text);
  const both = await grade("$('aria/Open menu')");
  assert.match(both.text, /matches 2 elements/, both.text);
});

test('cwq-u3: a second session in the same process grades aria/ too (registration is once per process)', async () => {
  await call(1, 'cor_open', { url: `${base}/cwq-u3-aria.html` });
  const out = await grade("$('aria/Password')", 1);
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /· 1 match\b/, out.text);
});

test('cwq-u3: names that cannot be counted are refused with a reason, not mis-parsed', async () => {
  assert.throws(() => parseGradable("$('aria/a >> b')"), />>/);
  assert.throws(() => parseGradable("$('aria/')"), /needs a name/);
});
