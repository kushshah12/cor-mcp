// U5 (engine feat/engine-u5-guideline-first-ranking; replaces the E3 hybrid of engine 37f445a): Playwright follows its
// published order — role first — whether or not the element has a test id, after uniqueness and quality. Origin decision Q4.
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
  return async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((x) => x.text).join('\n');
}

test('U5: an element with a unique role leads with getByRole under Playwright even when it has a test id; no switch note', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const out = await call('cor_inspect', { selector: '[data-testid="save"]', framework: 'playwright' });
  assert.match(out.split('\n')[1], /getByRole\('button', \{ name: 'Save' \}\)/, out);
  assert.match(out, /^Framework convention applied: playwright \(published guidance\)\.$/m);
  assert.doesNotMatch(out, /a team's marker for automation/);
  assert.match(out, /getByTestId\('save'\)/, 'the test id is still offered as an alternative');
});

test('U5: an element without a test id keeps Playwright\'s own order', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  for (const selector of ['button:nth-of-type(2)', 'a']) {
    const out = await call('cor_inspect', { selector, framework: 'playwright' });
    assert.match(out.split('\n')[1], /getByRole\(/, selector);
  }
});

test('U5: Cypress keeps data-* first', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  assert.match((await call('cor_inspect', { selector: '[data-testid="save"]', framework: 'cypress' })).split('\n')[1], /cy\.get\('\[data-testid="save"\]'\)/);
});
