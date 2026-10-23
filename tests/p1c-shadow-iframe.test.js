// P1c V2 (shadow DOM) and the iframe check. A candidate that does not resolve to the inspected element never
// leads (P3) — on a shadow-DOM page the host's id scored 93 for WebdriverIO and Cypress and named the wrong
// element; the engine's own `host >>> el` locator was counted 0 (engine E5). Frames COR cannot read are said, not skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { factsFor } from '../src/facts.js';
import { framesNote, renderInspect } from '../src/format.js';

const CARDS = `<div class="card"><h3>Team</h3><button>Choose</button></div><div class="card"><h3>Pro</h3><button>Choose</button></div>`;
const attach = (hostId, html) => `<div id="${hostId}"></div><script>document.getElementById('${hostId}').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(html)};</script>`;
const PAGES = {
  '/cards': `<title>Cards</title><h1>Plans</h1>${attach('host', CARDS)}`,
  '/only': `<title>Only</title>${attach('host', '<p class="note">Note</p><button id="only">Only</button>')}`,
  '/nested': `<title>Nested</title><div id="outer"></div><script>
    const o = document.getElementById('outer').attachShadow({ mode: 'open' }); o.innerHTML = '<div id="inner"></div>';
    o.getElementById('inner').attachShadow({ mode: 'open' }).innerHTML = '<button id="deep">Deep</button>';</script>`,
  '/light': '<title>Light</title><button id="plain">Plain</button>',
  '/frames': '<title>Frames</title><h1>Checkout</h1><button id="back">Back</button><iframe title="payment" src="/inner" style="width:200px;height:60px"></iframe>',
  '/sandboxed': '<title>Sandboxed</title><iframe sandbox src="/inner" title="ads" style="width:100px;height:50px"></iframe>',
  '/manyframes': `<title>Many</title>${[1, 2, 3, 4].map((n) => `<iframe title="f${n}" src="/inner" style="width:50px;height:50px"></iframe>`).join('')}`,
  '/hiddenframe': '<title>Hidden</title><button id="a">A</button><iframe src="/inner" style="display:none"></iframe><iframe src="/inner" style="width:0;height:0;border:0"></iframe>',
  '/inner': '<title>in</title><button id="pay">Pay now</button>',
};
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGES[req.url.split('?')[0]] ?? 'missing');
});
const session = createSession({ headless: true });
let base;
let call;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
});
after(() => { site.closeAllConnections?.(); site.close(); return session.close(); });

// P2a: refs number on across page loads in one session — the snapshot's first ref, not a literal e1.
const firstRef = (text) => /\[ref=(e\d+)\]/.exec(text)[1];
const open = (path) => call('cor_open', { url: `${base}${path}` });
const FRAMEWORKS = ['playwright', 'webdriverio', 'cypress'];

// ── V2: the host never names a control inside its shadow root ──
test('P1c V2: on a shadow-DOM page no framework leads with the host — none of its candidates finds exactly the button', async () => {
  await open('/cards');
  const first = firstRef((await call('cor_snapshot')).text);
  for (const fw of FRAMEWORKS) {
    const { text } = await call('cor_inspect', { ref: first, framework: fw });
    assert.match(text, /^No locator found here resolves to exactly this element\. The closest \(not usable as written\): /m, fw);
    assert.doesNotMatch(text, /^Best locator/m, fw);
    assert.doesNotMatch(text, /Excellent · 1 match/, `${fw}: the host is not scored Excellent for a button`);
    assert.doesNotMatch(text, /^Durable — /m, `${fw}: no durable annotation for a locator we declined`);
    assert.doesNotMatch(text, /^Why this order:/m, fw);
    assert.match(text, /Add a test attribute/, fw);
  }
});

test('P1c V2: an element in a shadow root gets a fact naming the host, in every framework', async () => {
  await open('/cards');
  const first = firstRef((await call('cor_snapshot')).text);
  for (const fw of FRAMEWORKS) {
    const { text } = await call('cor_inspect', { ref: first, framework: fw });
    assert.match(text, /^ {2}• inside a shadow root \(host #host\) — Playwright and WebdriverIO see in; Cypress needs its shadow setting on$/m, fw);
  }
  await open('/light');
  assert.doesNotMatch((await call('cor_inspect', { selector: '#plain' })).text, /shadow root/, 'a light-DOM element has no shadow fact');
});

test('P1c V2: nested shadow roots are counted', async () => {
  await open('/nested');
  const first = firstRef((await call('cor_snapshot')).text); // a plain selector cannot reach into two roots; a ref does
  assert.match((await call('cor_inspect', { ref: first })).text, /inside 2 nested shadow roots \(host #outer\)/);
});

test('P1c V2: a control in a shadow root that has its own unique locator still gets it, and a real count for the shadow chain', async () => {
  await open('/only');
  const first = firstRef((await call('cor_snapshot')).text);
  for (const fw of ['playwright', 'webdriverio']) {
    const { text } = await call('cor_inspect', { ref: first, framework: fw, all: true });
    assert.match(text, /^Best locator|^For this one item alone/m, fw);
    assert.doesNotMatch(text, /^No locator found here/m, fw);
    assert.match(text, /inside a shadow root \(host #host\)/, fw);
    // engine E5: the chain the engine generated is counted, not read as 0 matches
    const chain = text.split('\n').findIndex((l) => /#host >>>? /.test(l));
    if (chain >= 0) assert.doesNotMatch(text.split('\n')[chain + 1], /0 matches|0 match/, `${fw}: ${text.split('\n')[chain]}`);
  }
});

test('P1c V2: the shadow fact needs a shadow root — unit', () => {
  assert.deepEqual(factsFor({}).map((f) => f.type), []);
  assert.deepEqual(factsFor({ shadow: { depth: 1, host: '#h' } }).map((f) => f.type), ['shadow-dom']);
  assert.match(factsFor({ shadow: { depth: 3, host: 'my-card.big' } })[0].text, /^inside 3 nested shadow roots \(host my-card\.big\)/);
  const order = factsFor({ params: { hidden: { count: 1, scope: null } }, shadow: { depth: 1, host: '#h' }, collapsed: true }).map((f) => f.type);
  assert.deepEqual(order, ['hidden-copies', 'shadow-dom', 'collapsed-content'], 'shadow follows hidden copies');
  assert.ok(factsFor({ shadow: { depth: 1, host: `#${'x'.repeat(300)}` } })[0].text.length <= 140);
  // the realistic worst case is not clipped: two nested roots and a named host (selectorshub's #userName)
  assert.ok(!factsFor({ shadow: { depth: 2, host: '#userName' } })[0].text.endsWith('…'));
});

test('P3: when the best candidate is usable it leads as before (light DOM)', async () => {
  await open('/light');
  const { text } = await call('cor_inspect', { selector: '#plain', framework: 'cypress' });
  assert.match(text, /^Best locator \(cypress\):/m);
  assert.doesNotMatch(text, /No locator found here/);
});

// ── iframes ──
test('iframe check: the snapshot reads a same-origin frame as its own section (U7)', async () => {
  await open('/frames');
  const { text } = await call('cor_snapshot');
  assert.match(text, /^Frame "payment" \(same origin\) — 1 interactive element$/m);
  assert.match(text, /button "Back"/, 'the top document is still listed');
  assert.match(text, /button "Pay now"/, 'the frame control is listed');
  assert.doesNotMatch(text, /Not listed/);
});

test('iframe check: a sandboxed frame is another site; many frames are capped; hidden and zero-size ones are not reported', async () => {
  await open('/sandboxed');
  assert.match((await call('cor_snapshot')).text, /^Frame "ads" \(another site\) — 1 interactive element$/m);
  await open('/manyframes');
  const many = (await call('cor_snapshot')).text;
  for (const n of [1, 2, 3, 4]) assert.match(many, new RegExp(`^Frame "f${n}" \\(same origin\\)`, 'm'));
  assert.doesNotMatch(many, /Not listed/);
  await open('/hiddenframe');
  assert.doesNotMatch((await call('cor_snapshot')).text, /Not listed/);
  await open('/light');
  assert.doesNotMatch((await call('cor_snapshot')).text, /Not listed/);
});

test('iframe check: an element that is not found says a frame may hold it — for inspect and for the act tools', async () => {
  await open('/frames');
  for (const [tool, args] of [['cor_inspect', { selector: '#pay' }], ['cor_click', { target: '#pay' }]]) {
    const r = await call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /No element matches "#pay"/, tool);
    assert.match(r.text, /Some controls are in iframes: pass a ref from cor_snapshot/, tool);
  }
  await open('/light');
  const plain = await call('cor_inspect', { selector: '#nothing' });
  assert.doesNotMatch(plain.text, /iframe/, 'no frames, no hint');
});

test('iframe check: the note is a line of its own — unit', () => {
  assert.deepEqual(framesNote([]), []);
  assert.deepEqual(framesNote(undefined), []);
  assert.match(framesNote([{ name: null, sameOrigin: false }])[0], /^Not listed: 1 iframe — unnamed \(another site\)\./);
});

// ── Cypress: the shadow setting is the fix, not a test attribute ──
test('P1c V2: Cypress on a control in a shadow root is told the setting, with the locator that works once it is on', async () => {
  await open('/only');
  const first = firstRef((await call('cor_snapshot')).text);
  const { text } = await call('cor_inspect', { ref: first, framework: 'cypress' });
  assert.match(text, /^No locator found here resolves to exactly this element\./m);
  assert.match(text, /^Cypress does not look inside a shadow root unless told to\. With the setting on this finds exactly this element: cy\.get\('#only', \{ includeShadowDom: true \}\)$/m);
  assert.match(text, /^ {2}or set includeShadowDom: true once in the Cypress config and use cy\.get\('#only'\)\.$/m);
  assert.doesNotMatch(text, /Add a test attribute/, 'not an application problem');
});

test('P1c V2: the Cypress fix is only offered when the piercing query finds exactly this element', async () => {
  await open('/cards'); // two identical Choose buttons: no candidate is unique even with piercing
  const first = firstRef((await call('cor_snapshot')).text);
  const cards = (await call('cor_inspect', { ref: first, framework: 'cypress' })).text;
  assert.doesNotMatch(cards, /includeShadowDom/);
  assert.match(cards, /Add a test attribute/, 'falls back to the application change');
  await open('/light');
  assert.doesNotMatch((await call('cor_inspect', { selector: '#plain', framework: 'cypress' })).text, /includeShadowDom/, 'never in the light DOM');
  await open('/only');
  const only = firstRef((await call('cor_snapshot')).text);
  for (const fw of ['playwright', 'webdriverio']) assert.doesNotMatch((await call('cor_inspect', { ref: only, framework: fw })).text, /includeShadowDom/, `${fw} needs no setting`);
});

test('P1c: the ambiguity fact skips a bare tag selector — nobody would pick it — and keeps a real candidate', () => {
  const many = (value) => ({ locators: [{ value, matchCount: 39, resolution: { failureMode: 'strict-mode-error' } }] });
  assert.deepEqual(factsFor(many('input')), []);
  assert.deepEqual(factsFor(many('my-card')), []);
  assert.deepEqual(factsFor(many('.btn')).map((f) => f.type), ['ambiguity-consequence']);
  assert.deepEqual(factsFor(many('input.btn')).map((f) => f.type), ['ambiguity-consequence']);
});

test('P1c V2: the Cypress shadow advice needs Cypress, a shadow root and a fix — unit', () => {
  const loc = { value: '#x', code: "cy.get('#x')", strategy: 'css', score: 90, tier: 'good', tierLabel: 'Good', matchCount: 0, signals: [], resolution: { usable: false, status: 'broken', message: 'Matches no elements' } };
  const base = { framework: 'cypress', locators: [loc], profile: null, params: null };
  const advice = (result, framework) => renderInspect({ ...base, ...result }, { framework });
  assert.match(advice({ shadow: { depth: 1, host: '#h' }, shadowFix: { selector: '#x' } }, 'cypress'), /cy\.get\('#x', \{ includeShadowDom: true \}\)/);
  assert.doesNotMatch(advice({ shadowFix: { selector: '#x' } }, 'cypress'), /includeShadowDom/, 'no shadow root, no advice');
  assert.doesNotMatch(advice({ shadow: { depth: 1, host: '#h' }, shadowFix: { selector: '#x' } }, 'playwright'), /includeShadowDom/, 'not for another framework');
  assert.doesNotMatch(advice({ shadow: { depth: 1, host: '#h' }, shadowFix: null }, 'cypress'), /includeShadowDom/, 'no fix, no advice');
  assert.match(advice({ shadow: { depth: 1, host: '#h' }, shadowFix: { selector: "a[title='x']" } }, 'cypress'), /cy\.get\('a\[title=\\'x\\'\]', \{ includeShadowDom/, 'quotes escaped');
});
