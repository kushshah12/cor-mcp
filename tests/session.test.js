import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { expandGroups } from './helpers/outline.js';

// ── fixture site ────────────────────────────────────────────────────────────
const PAGES = {
  // Multi-step flow: the name field does not exist until "Next" is clicked,
  // and submitting it (Enter) navigates to /done.
  '/': `<title>Start</title>
    <button id="next" onclick="document.getElementById('step2').innerHTML = '<input id=name name=name>'">Next</button>
    <form id="step2" action="/done"></form>`,
  '/login': '<title>Login</title><p>Please sign in</p>',
  '/private': '<title>Account</title><button id="secret">Account settings</button>',
  '/twins': '<title>Twins</title><button class="b">A</button><button class="b">B</button>',
  '/count': `<title>Count</title><button id="inc" onclick="this.dataset.n = (+this.dataset.n || 0) + 1">+</button>`,
  // Strict CSP, no 'unsafe-eval' and no inline handlers: the click handler
  // comes from an external script.
  '/csp': '<title>CSP</title><button id="go">Go</button><script src="/csp.js"></script>',
};

let base;
const site = createHttpServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/csp.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end("document.getElementById('go').addEventListener('click', e => { e.target.textContent = 'clicked' })");
  }
  if (url.pathname === '/private' && !/(^|; )sid=ok/.test(req.headers.cookie ?? '')) {
    res.writeHead(302, { location: '/login' });
    return res.end();
  }
  if (url.pathname === '/done') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<title>Done</title><p id="result">Hello ${url.searchParams.get('name')}</p>`);
  }
  const html = PAGES[url.pathname];
  if (!html) {
    res.writeHead(404);
    return res.end();
  }
  const headers = { 'content-type': 'text/html' };
  if (url.pathname === '/csp') headers['content-security-policy'] = "script-src 'self'";
  res.writeHead(200, headers);
  res.end(html);
});

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

// ── helpers ─────────────────────────────────────────────────────────────────
async function connect(t, options = {}) {
  const session = createSession({ headless: true, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
  t.after(async () => {
    await client.close();
    await session.close();
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, text: expandGroups(result.content.map((c) => c.text).join('\n')) };
  };
  return { session, call };
}

const text = (session, selector) => session.getPage().then((p) => p.textContent(selector));

// ── tests ───────────────────────────────────────────────────────────────────
test('AE2: a storage state is adopted, so a page behind a login is reachable', async (t) => {
  const { session, call } = await connect(t);

  const anonymous = await call('cor_open', { url: `${base}/private` });
  assert.match(anonymous.text, /"Login"/, 'without the storage state the site redirects to login');

  const state = join(mkdtempSync(join(tmpdir(), 'cor-state-')), 'state.json');
  const cookie = { name: 'sid', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
  writeFileSync(state, JSON.stringify({ cookies: [cookie], origins: [] }));

  const signedIn = await call('cor_open', { url: `${base}/private`, storageState: state });
  assert.equal(signedIn.isError, undefined);
  assert.match(signedIn.text, /\/private — "Account"/);
  assert.equal((await call('cor_click', { target: '#secret' })).isError, undefined, 'its elements are reachable');
  assert.equal(await text(session, '#secret'), 'Account settings');
});

test('opening twice in one session reuses the same browser', async (t) => {
  const { session, call } = await connect(t);
  await call('cor_open', { url: `${base}/` });
  const first = session.browser;
  await call('cor_open', { url: `${base}/count` });
  assert.ok(first);
  assert.equal(session.browser, first);
  assert.equal(first.contexts().length, 1);
  assert.equal(first.contexts()[0].pages().length, 1, 'one page, not a page per call');
});

test('act calls reach an element that does not exist on first load', async (t) => {
  const { session, call } = await connect(t);
  await call('cor_open', { url: `${base}/` });

  const early = await call('cor_fill', { target: '#name', value: 'Ada' });
  assert.match(early.text, /No element matches "#name"/, 'the field does not exist before the flow advances');

  await call('cor_click', { target: '#next' });
  assert.equal((await call('cor_fill', { target: '#name', value: 'Ada' })).isError, undefined);
  const pressed = await call('cor_press', { key: 'Enter', target: '#name' });
  assert.match(pressed.text, /\/done\?name=Ada — "Done"/, 'a real Enter submits the form and the response reports the new page');
  assert.equal(await text(session, '#result'), 'Hello Ada');
});

test('closing releases the browser; the next open starts a new one', async (t) => {
  const { session, call } = await connect(t);
  await call('cor_open', { url: `${base}/` });
  const first = session.browser;

  assert.equal((await call('cor_close')).text, 'Browser closed.');
  assert.equal(first.isConnected(), false);
  assert.equal(session.isOpen, false);

  await call('cor_open', { url: `${base}/` });
  assert.notEqual(session.browser, first);
  assert.equal(session.browser.isConnected(), true);
});

test('an idle session is cleaned up and the server keeps working', async (t) => {
  const { session, call } = await connect(t, { idleMs: 800 });
  await call('cor_open', { url: `${base}/` });
  const first = session.browser;

  await sleep(2000);
  assert.equal(first.isConnected(), false, 'browser closed after the idle timeout');
  assert.equal(session.isOpen, false);

  const again = await call('cor_open', { url: `${base}/count` });
  assert.equal(again.isError, undefined);
  assert.match(again.text, /"Count"/);
});

test('with system Chrome present, opening a page downloads no browser', async (t) => {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const snapshot = () => (existsSync(cache) ? readdirSync(cache).sort() : []);
  const beforeOpen = snapshot();

  const { session, call } = await connect(t);
  const opened = await call('cor_open', { url: `${base}/` });
  assert.match(session.browserLabel, /^chrome \d+\./, 'the system Chrome channel was used');
  assert.match(opened.text, /Browser: chrome \d+/);
  assert.deepEqual(snapshot(), beforeOpen, 'nothing was added to the Playwright browser cache');
});

test('with no Chrome and no Edge, the first call returns an actionable error', async (t) => {
  const missing = [{ executablePath: '/nonexistent/chrome' }, { executablePath: '/nonexistent/msedge' }];
  const { call } = await connect(t, { launchChain: missing });
  const started = Date.now();
  const result = await call('cor_open', { url: `${base}/` });
  assert.equal(result.isError, true);
  assert.match(result.text, /npx playwright install chromium/);
  assert.doesNotMatch(result.text, /\n\s+at /, 'no stack trace');
  assert.ok(Date.now() - started < 10_000, 'does not hang');
});

test('a raw DOM click reaches what an actionable click reaches, including under a strict CSP', async (t) => {
  const { session, call } = await connect(t);
  await call('cor_open', { url: `${base}/count` });
  await call('cor_click', { target: '#inc' });
  const page = await session.getPage();
  assert.equal(await page.getAttribute('#inc', 'data-n'), '1', 'raw click landed');
  await page.click('#inc');
  assert.equal(await page.getAttribute('#inc', 'data-n'), '2', 'Playwright click lands on the same element');

  await call('cor_open', { url: `${base}/csp` });
  assert.equal((await call('cor_click', { target: '#go' })).isError, undefined);
  assert.equal(await text(session, '#go'), 'clicked');
});

test('act errors are actionable: no page open, no match, several matches', async (t) => {
  const { session, call } = await connect(t);
  const before = await call('cor_click', { target: '#x' });
  assert.equal(before.isError, true);
  assert.match(before.text, /call cor_open/);
  assert.equal(session.isOpen, false, 'an act call does not launch a browser onto about:blank');

  await call('cor_open', { url: `${base}/twins` });
  assert.match((await call('cor_click', { target: '#nope' })).text, /No element matches "#nope"/);
  assert.match((await call('cor_click', { target: 'button.b' })).text, /matches 2 elements/);
  assert.match((await call('cor_fill', { target: 'title', value: 'x' })).text, /does not take text/);
});

test('a browser that dies outside the session is relaunched on the next call', async (t) => {
  const { session, call } = await connect(t);
  await call('cor_open', { url: `${base}/` });
  const dead = session.browser;
  await dead.close(); // as if the user closed the window, or Chrome crashed
  assert.equal(session.isOpen, false);

  const again = await call('cor_open', { url: `${base}/count` });
  assert.equal(again.isError, undefined);
  assert.notEqual(session.browser, dead);
});

test('the server survives repeated open and close cycles', async (t) => {
  const { session, call } = await connect(t);
  for (let i = 0; i < 5; i++) {
    assert.match((await call('cor_open', { url: `${base}/count` })).text, /"Count"/);
    assert.equal((await call('cor_close')).text, 'Browser closed.');
  }
  assert.equal(session.isOpen, false);
  assert.match((await call('cor_open', { url: `${base}/` })).text, /"Start"/);
});

test('bin: when the client closes stdin, the server exits and takes Chrome with it', async (t) => {
  // Raw JSON-RPC over a spawned bin: no SDK client, whose close() escalates to
  // SIGTERM and would hide a server that ignores stdin closing.
  const bin = fileURLToPath(new URL('../bin/cor-mcp.js', import.meta.url));
  const child = spawn(process.execPath, [bin, '--headless'], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const waitFor = async (pattern) => {
    for (let i = 0; i < 100 && !pattern.test(out); i++) await sleep(100);
    assert.match(out, pattern);
  };

  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
  await waitFor(/"id":1/);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'cor_open', arguments: { url: `${base}/` } } });
  await waitFor(/Now at/);

  const browserPids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
  assert.ok(browserPids.length > 0, 'the server launched a browser');

  child.stdin.end(); // the only signal the server gets
  const [code] = await Promise.race([once(child, 'exit'), sleep(5000).then(() => ['still running'])]);
  assert.equal(code, 0, 'server exited on its own after stdin closed');

  await sleep(300);
  const alive = browserPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(alive, [], 'browser processes exited with the server');
});
