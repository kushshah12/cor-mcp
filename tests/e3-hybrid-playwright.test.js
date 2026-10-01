// E3 hybrid (engine 37f445a): Playwright keeps its published order — role first — unless the element has a test id; then the
// test id leads and the reply says why. WebdriverIO and Cypress are not affected by the explanation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

const PAGE = '<title>Hybrid</title><div><button data-testid="save">Save</button><button>Cancel</button><a href="/pricing">Pricing</a></div>';
const site = createHttpServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
let base;
before(async () => { await new Promise((r) => site.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${site.address().port}`; });
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t) {
  const session = createSession({ headless: true });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
}

test('E3 hybrid: an element with a test id leads with it under Playwright, and the reply says why', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const out = await call('cor_inspect', { selector: '[data-testid="save"]', framework: 'playwright' });
  assert.match(out.split('\n')[1], /getByTestId\('save'\)/);
  assert.match(out, /^Framework convention applied: playwright \(published guidance\)\.$/m);
  assert.match(out, /playwright's guidance puts role, label and text first; this element has a test id, a team's marker for automation/);
  assert.match(out, /Without a test id the order is playwright's own\./);
});

test('E3 hybrid: an element without one keeps Playwright\'s own order, with no switch note', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  for (const selector of ['button:nth-of-type(2)', 'a']) {
    const out = await call('cor_inspect', { selector, framework: 'playwright' });
    assert.match(out.split('\n')[1], /getByRole\(/, selector);
    assert.doesNotMatch(out, /a team's marker for automation/, selector);
  }
});

test('E3 hybrid: WebdriverIO and Cypress never get the Playwright switch note', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  for (const framework of ['webdriverio', 'cypress']) {
    assert.doesNotMatch(await call('cor_inspect', { selector: '[data-testid="save"]', framework }), /guidance puts role, label and text first/, framework);
  }
});
