// U22: no loose text locators, and guidance that follows from what an act changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, INSTRUCTIONS } from '../src/server.js';
import { createSession } from '../src/session.js';

const PAGES = {
  // The DOM is ready at once; the load event never comes (a third-party asset that hangs).
  '/hangs': '<title>Slow assets</title><h1>Ready</h1><img src="/never.png" alt="">',
  '/slowform': '<title>Slow</title><form action="/checkout5" method="post"><input type="submit" value="Choose"></form>',
  '/switch': '<title>Switch</title><label><input type="checkbox" id="annual" style="position:absolute;opacity:0;width:0;height:0"> Bill annually</label>',
  '/': `<title>Plans</title><main>
    <div style="display:none"><h3>Live - Team Pro</h3></div>
    <h3>Live - Team Pro</h3><p>Choose Live - Team Pro to continue</p>
    <form action="/checkout" method="post"><input type="submit" value="Choose"></form>
    <a id="top" href="#note">Jump to note</a><a id="js" href="javascript:void(0)">Nothing link</a>
    <button id="plain">Toggle</button><button id="nothing">Nothing</button><div id="note"></div>
    <script>document.getElementById('plain').addEventListener('click', () => { document.getElementById('note').textContent = 'Toggled on'; });</script>
  </main>`,
};

let base;
const site = createHttpServer((req, res) => {
  if (req.url === '/never.png') return; // hangs on purpose
  if (req.url === '/checkout5') {
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Checkout</title><h1>Order summary</h1><h3>Live - Team Pro</h3>');
    }, 5000); // a slow day: the navigation starts well after the old 4 s wait
  }
  if (req.url === '/checkout') {
    // A slow navigation: the response arrives well after a fixed half-second wait.
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Checkout</title><h1>Order summary</h1><section><h3>Live - Team Pro</h3></section><button>Pay</button>');
    }, 1200);
  }
  const html = PAGES[req.url];
  if (!html) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => { site.closeAllConnections?.(); site.close(); });

const session = createSession({ headless: true });
after(() => session.close());

async function connect(t) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
}

// ── A2: cor_grade reads WebdriverIO text selectors and Cypress cy.contains, and calls loose ones loose ──
test('a partial-text WebdriverIO selector is Loose, with the exact form for the element it lands on', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: "$('*=continue')", framework: 'webdriverio' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Loose — \$\('\*=continue'\) matches by partial text/m);
  assert.match(r.text, /p=Choose Live - Team Pro to continue/);
  // Not the healthy shape: no "the locator works" line, no "nothing scores higher" line.
  assert.doesNotMatch(r.text, /Healthy|Not a repair case: the locator works|No generated candidate scores higher/);
  assert.match(r.text, /^Graded: /m);
});

test('a bare string is read as a WebdriverIO selector when the framework says so', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: 'p*=continue', framework: 'webdriverio' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Loose — p\*=continue matches by partial text/m);
});

test('an exact-text WebdriverIO selector is not called loose', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: "$('p=Choose Live - Team Pro to continue')", framework: 'webdriverio' });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /Loose/);
});

test('a partial match that finds several says how many, and a hidden copy counts', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: "$('h3*=Team Pro')" });
  assert.match(r.text, /Ambiguous — matches 2 elements/);
  assert.match(r.text, /Loose — .*matches by partial text/);
  assert.match(r.text, /2 elements here, 1 visible/);
});

test('a partial match that finds nothing is Broken and still loose', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: "$('*=nowhere at all')", framework: 'webdriverio' });
  assert.match(r.text, /Broken/);
  assert.match(r.text, /Loose — .*none here/);
});

test('cy.contains with a string is a substring; an anchored regex is exact', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const loose = await call('cor_grade', { selector: "cy.contains('continue')" });
  assert.match(loose.text, /Loose — cy\.contains\('continue'\) matches by a substring/);
  assert.match(loose.text, /cy\.contains\('p', \/\^Choose Live - Team Pro to continue\$\/\)/);
  const scoped = await call('cor_grade', { selector: "cy.contains('p', 'continue')" });
  assert.match(scoped.text, /Loose — cy\.contains\('p', 'continue'\) matches by a substring/);
  const exact = await call('cor_grade', { selector: "cy.contains('p', /^Choose Live - Team Pro to continue$/)" });
  assert.doesNotMatch(exact.text, /Loose/);
});

test('WebdriverIO CSS in $() is graded like any CSS', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const r = await call('cor_grade', { selector: "$('#plain')", framework: 'webdriverio' });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /Loose/);
  const chained = await call('cor_grade', { selector: "$('main').$('#plain')" });
  assert.equal(chained.isError, true);
  assert.match(chained.text, /chained WebdriverIO calls/);
});

// ── A1: a click that navigates waits for the new page and lists its headings with refs ──
test('a click on a submit button waits for a slow page and lists its headings with refs', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const snap = await call('cor_snapshot');
  const choose = snap.text.match(/button "Choose" \[ref=(e\d+)\]/)?.[1];
  assert.ok(choose, snap.text);
  const r = await call('cor_click', { ref: choose });
  assert.match(r.text, /Now at .*\/checkout — "Checkout"/, r.text);
  assert.match(r.text, /Headings on the new page/);
  const h3 = r.text.match(/h3 "Live - Team Pro" \[ref=(e\d+)\]/)?.[1];
  assert.ok(h3, r.text);
  assert.match(r.text, /h1 "Order summary" \[ref=e\d+\]/);
  // The ref works straight away: no snapshot in between.
  const inspected = await call('cor_inspect', { ref: h3, framework: 'webdriverio' });
  assert.equal(inspected.isError, false, inspected.text);
  assert.match(inspected.text, /Live - Team Pro/);
  assert.doesNotMatch(inspected.text, /\*=/);
});

test('a click that does not navigate does not wait for one', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const snap = await call('cor_snapshot');
  const toggle = snap.text.match(/button "Toggle" \[ref=(e\d+)\]/)?.[1];
  const started = Date.now();
  const r = await call('cor_click', { ref: toggle });
  assert.ok(Date.now() - started < 2500, `waited ${Date.now() - started} ms`);
  assert.match(r.text, /Toggled on/);
  assert.doesNotMatch(r.text, /Headings on the new page/);
});

test('after a navigation the old page\'s refs are stale, even though the new headings have refs', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const snap = await call('cor_snapshot');
  const choose = snap.text.match(/button "Choose" \[ref=(e\d+)\]/)[1];
  const toggle = snap.text.match(/button "Toggle" \[ref=(e\d+)\]/)[1];
  const nav = await call('cor_click', { ref: choose });
  const nums = [...nav.text.matchAll(/\[ref=e(\d+)\]/g)].map((m) => Number(m[1]));
  const oldNums = [choose, toggle].map((r) => Number(r.slice(1)));
  assert.ok(Math.min(...nums) > Math.max(...oldNums), `new refs ${nums} must not reuse old numbers ${oldNums}`);
  const stale = await call('cor_inspect', { ref: toggle });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /stale: the page navigated/);
});

// ── A3 / B: instructions, the once-per-session hint, the hidden-input note ──
test('the instructions ask for every locator from COR, no partial text, and outcome assertions', () => {
  assert.match(INSTRUCTIONS, /including elements you only assert on/);
  assert.match(INSTRUCTIONS, /Never match by partial text \(\*=, a substring cy\.contains/);
  assert.match(INSTRUCTIONS, /Assert what an action changed/);
  assert.match(INSTRUCTIONS, /keep the page open — no cor_close — until you have graded them/);
  assert.match(INSTRUCTIONS, /retrying assertion, not a fixed sleep/);
});

test('the assert-what-changed hint comes once, on the first act that changes something', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const snap = await call('cor_snapshot');
  const ref = (name) => snap.text.match(new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`))[1];
  const nothing = await call('cor_click', { ref: ref('Nothing') });
  assert.match(nothing.text, /No visible change/);
  assert.doesNotMatch(nothing.text, /Assert what this changed/);
  const first = await call('cor_click', { ref: ref('Toggle') });
  assert.match(first.text, /Toggled on/);
  assert.equal(first.text.match(/Assert what this changed/g)?.length, 1, first.text);
  assert.match(first.text, /hidden or removed: "not displayed" holds for both/);
  const again = await call('cor_snapshot');
  const choose = again.text.match(/button "Choose" \[ref=(e\d+)\]/)[1];
  const second = await call('cor_click', { ref: choose });
  assert.match(second.text, /Headings on the new page/);
  assert.doesNotMatch(second.text, /Assert what this changed/);
});

test('a hidden input is told to assert its state or label, not that it exists', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/switch` });
  const wdio = await call('cor_inspect', { selector: '#annual', framework: 'webdriverio' });
  assert.match(wdio.text, /the input is hidden, so asserting that it exists passes with nothing on screen/);
  const pw = await call('cor_inspect', { selector: '#annual', framework: 'playwright' });
  assert.match(pw.text, /not that the input exists: it is hidden/);
});

test('a link that stays on the page (#anchor, javascript:) is not waited on as a navigation', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: base });
  const snap = await call('cor_snapshot');
  for (const name of ['Jump to note', 'Nothing link']) {
    const ref = snap.text.match(new RegExp(`link "${name}" \\[ref=(e\\d+)\\]`))?.[1];
    assert.ok(ref, snap.text);
    const started = Date.now();
    await call('cor_click', { ref });
    assert.ok(Date.now() - started < 2500, `${name}: waited ${Date.now() - started} ms`);
    await call('cor_snapshot');
  }
});

// ── a slow day (run 69303bba: cor_open timed out on the load event; the checkout took over 4 s to start) ──
test('cor_open does not wait for a load event that never comes', async (t) => {
  const call = await connect(t);
  const started = Date.now();
  const r = await call('cor_open', { url: `${base}/hangs` });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"Slow assets"/);
  assert.ok(Date.now() - started < 20000, `${Date.now() - started} ms`);
});

test('a submit whose navigation starts after 5 s still gets the new page and its headings', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/slowform` });
  const snap = await call('cor_snapshot');
  const choose = snap.text.match(/button "Choose" \[ref=(e\d+)\]/)[1];
  const r = await call('cor_click', { ref: choose });
  assert.match(r.text, /Now at .*\/checkout5 — "Checkout"/, r.text);
  assert.match(r.text, /h3 "Live - Team Pro" \[ref=e\d+\]/);
});
