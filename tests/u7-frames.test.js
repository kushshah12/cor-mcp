// U7: iframes. A control inside a same-origin or cross-origin frame gets a ref in the outline, an inspect entry that
// reaches it through page.frameLocator(…), and an act that resolves in its own frame. Other frameworks are refused for
// frame controls. A page without frames is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

const PAGES = {
  '/page': `<title>Checkout</title><h1>Checkout</h1><button id="back">Back</button>
    <iframe title="payment" src="/pay" style="width:300px;height:120px"></iframe>
    <iframe title="ads" src="{{OTHER}}/ad" style="width:300px;height:120px"></iframe>`,
  '/nested': `<title>Nested</title><button id="top">Top</button>
    <iframe title="outer" src="/nest" style="width:400px;height:200px"></iframe>`,
  '/nest': `<title>Nest</title><button id="mid">Middle</button>
    <iframe title="inner" src="/pay" style="width:300px;height:100px"></iframe>`,
  '/pay': `<title>Pay</title><button id="pay" onclick="this.textContent = 'Paid'">Pay now</button>`,
  '/light': '<title>Light</title><button id="plain">Plain</button>',
  '/radios': '<title>Survey</title><h1>Survey</h1><iframe src="/survey" style="width:300px;height:160px"></iframe>',
  '/survey': '<title>Form</title><fieldset><legend>Did you install it?</legend>'
    + '<label><input type="radio" name="q" value="Yes">Yes</label>'
    + '<label><input type="radio" name="q" value="No">No</label>'
    + '<label><input type="radio" name="q" value="Installed Now">Installed Now</label></fieldset>',
};
const OTHER_PAGES = { '/ad': '<title>Ad</title><button id="buy">Buy now</button>' };

function serve(pages, host) {
  return createHttpServer((req, res) => {
    const body = pages[req.url.split('?')[0]];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body.replace('{{OTHER}}', other));
  });
}

let other;
const main = serve(PAGES);
const otherSite = serve(OTHER_PAGES);
const session = createSession({ headless: true });
let base;
let call;

before(async () => {
  await new Promise((resolve) => otherSite.listen(0, 'localhost', resolve));
  other = `http://localhost:${otherSite.address().port}`;
  await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${main.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !('detail' in args) && !args.targets ? { ...args, detail: true } : args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
});

after(() => {
  main.closeAllConnections?.();
  main.close();
  otherSite.closeAllConnections?.();
  otherSite.close();
  return session.close();
});

const open = (path) => call('cor_open', { url: `${base}${path}` });
/** The ref on the outline line that names `label`, e.g. `button "Pay now" [ref=e7]`. */
const refFor = (text, label) => {
  const line = text.split('\n').find((l) => l.includes(`"${label}"`) && /\[ref=e\d+\]/.test(l));
  assert.ok(line, `no outline line for "${label}" in:\n${text}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

test('frames: a same-origin and a cross-origin frame are listed as sections, with the top document', async () => {
  const { text } = await open('/page');
  assert.match(text, /^Frame "payment" \(same origin\) — 1 interactive element$/m);
  assert.match(text, /^Frame "ads" \(another site\) — 1 interactive element$/m);
  assert.match(text, /button "Back"/, 'the top document is still listed');
  assert.match(text, /button "Pay now"/);
  assert.match(text, /button "Buy now"/);
  assert.doesNotMatch(text, /Not listed/, 'every visible frame was read');
});

test('frames: frame refs number after the top document and never collide with it', async () => {
  const { text } = await open('/page');
  const top = refFor(text, 'Back');
  const pay = refFor(text, 'Pay now');
  const buy = refFor(text, 'Buy now');
  assert.notEqual(pay, top);
  assert.notEqual(buy, pay);
  assert.ok(Number(pay.slice(1)) > Number(top.slice(1)), 'frame refs are numbered after the top document');
});

test('frames: inspect of a same-origin frame control gives an entry that reaches it through a frameLocator', async () => {
  const { text } = await open('/page');
  const { text: entry, isError } = await call('cor_inspect', { ref: refFor(text, 'Pay now'), framework: 'playwright' });
  assert.equal(isError, false, entry);
  assert.match(entry, /page\.frameLocator\('iframe\[title="payment"\]'\)\.getByRole\('button', \{ name: 'Pay now' \}\)/);
});

test('frames: a cross-origin frame control gets the same frameLocator chain', async () => {
  const { text } = await open('/page');
  const { text: entry, isError } = await call('cor_inspect', { ref: refFor(text, 'Buy now'), framework: 'playwright' });
  assert.equal(isError, false, entry);
  assert.match(entry, /page\.frameLocator\('iframe\[title="ads"\]'\)\.getByRole\('button', \{ name: 'Buy now' \}\)/);
});

test('frames: a nested frame control gets the full chain, outer then inner', async () => {
  const { text } = await open('/nested');
  assert.match(text, /^Frame "outer" \(same origin\)/m);
  const { text: entry, isError } = await call('cor_inspect', { ref: refFor(text, 'Pay now'), framework: 'playwright' });
  assert.equal(isError, false, entry);
  assert.match(entry, /page\.frameLocator\('iframe\[title="outer"\]'\)\.frameLocator\('iframe\[title="inner"\]'\)\.getByRole\('button', \{ name: 'Pay now' \}\)/);
});

test('frames: other frameworks are refused for a frame control, with the reason', async () => {
  const { text } = await open('/page');
  for (const framework of ['webdriverio', 'cypress']) {
    const r = await call('cor_inspect', { ref: refFor(text, 'Pay now'), framework });
    assert.equal(r.isError, true, framework);
    assert.match(r.text, /is in an iframe\. COR builds frame entries for Playwright only/, framework);
  }
});

test('frames: an act on a frame ref resolves in its frame and changes that frame', async () => {
  const { text } = await open('/page');
  const r = await call('cor_click', { ref: refFor(text, 'Pay now') });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Clicked e\d+/);
  const after = await call('cor_snapshot');
  assert.match(after.text, /button "Paid"/, 'the frame control now reads Paid');
});

test('frames: a page without frames is unchanged — no frame sections, no Not listed line', async () => {
  const { text } = await open('/light');
  assert.doesNotMatch(text, /Frame "/);
  assert.doesNotMatch(text, /Not listed/);
  assert.match(text, /button "Plain"/);
});

test('frames: a parameterised helper for a control inside a frame keeps the frame (fix 1)', async () => {
  const { text } = await open('/radios');
  const yes = refFor(text, 'Yes');
  const { text: entry, isError } = await call('cor_inspect', { ref: yes, framework: 'playwright' });
  assert.equal(isError, false, entry);
  // The detailed reply shows the helper's code as `page.frameLocator(…)…`; the frame must be in it.
  assert.match(entry, /page\.frameLocator\('iframe\[src\*="127\.0\.0\.1:\d+"\]'\)\.getByRole\('radio', \{ name: q, exact: true \}\)/, 'the helper reads from the frame');
  assert.doesNotMatch(entry, /(?:^|\n|= \(\w+\) => )\s*(?:this\.)?page\.getByRole\('radio'/, 'no helper reads from the top page');
});
