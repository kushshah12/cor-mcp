// U21b — COR run 3 (59a8aac0, 2026-09-26): 312k units and 29 turns against
// the Playwright agent's 231k and 17. Three detours cost turns:
// 1. The FAQ answer opened by growing a height-0 wrapper; its text always had
//    a box of its own, so COR thought it was visible before the click and said
//    "No visible change" — while listing other text (a testimonial carousel).
// 2. within: "How secure is my payment?" (the question the agent had just
//    clicked) named no region, so it retried with a ref.
// 3. Most turns held one call: the agent inspected one element per turn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';

const session = createSession({ headless: true });
after(() => session.close());
let raw;
let client;
let page;
before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  raw = async (name, args = {}) => (await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args })).content.map((c) => c.text).join('\n');
  await raw('cor_open', { url: 'about:blank' }).catch(() => {});
  page = await session.getPage();
});

const refOf = (text, pattern) => {
  const line = text.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `${pattern} not in\n${text}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

// BrowserStack's FAQ: the answer's wrapper animates from height 0.
const ACCORDION = `
  <style>
    .wrap { height: 0; overflow: hidden; transition: height .2s }
    .item.open .wrap { height: 60px }
    .q { cursor: pointer }
  </style>
  <section><h2>FAQ</h2>
    <div class="item"><p class="q">How secure is my payment?</p>
      <div class="wrap"><div class="answer">All payments are processed over HTTPS.</div></div></div>
    <div class="item"><p class="q">Can I get invoices?</p>
      <div class="wrap"><div class="answer">Yes, from the billing page.</div></div></div>
  </section>`;
// Script-bound, as on BrowserStack (an onclick attribute reads differently).
const withToggles = (html) => page.setContent(html).then(() => page.evaluate(() => {
  for (const q of document.querySelectorAll('.q')) q.addEventListener('click', () => q.parentElement.classList.toggle('open'));
}));

test('1. an answer that opens by growing a collapsed wrapper is reported as new text', async () => {
  await withToggles(ACCORDION);
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /How secure is my payment\?/) });
  assert.match(out, /^\+ "All payments are processed over HTTPS\." \[ref=e\d+\]/m, out);
  assert.doesNotMatch(out, /No visible change/);
});

test('1. text summed up by region is a visible change', async () => {
  const sections = ['One', 'Two', 'Three'].map((n) => `<section><h2>${n}</h2><p>${n} a</p><p>${n} b</p><p>${n} c</p></section>`).join('');
  await page.setContent(`<button>Show</button><div class="more" hidden>${sections}</div>`);
  await page.evaluate(() => document.querySelector('button').addEventListener('click', () => { document.querySelector('.more').hidden = false; }));
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "Show"/) });
  assert.match(out, /new lines in section/, out);
  assert.doesNotMatch(out, /No visible change/);
});

test('2. within takes the name of a control: the region around it', async () => {
  await withToggles(ACCORDION);
  const snap = await raw('cor_snapshot');
  const byName = await raw('cor_snapshot', { within: 'How secure is my payment?' });
  assert.match(byName, /All payments are processed over HTTPS\./, byName);
  // The same region its ref gives.
  const byRef = await raw('cor_snapshot', { within: refOf(snap, /How secure is my payment\?/) });
  const body = (t) => t.split('\n').slice(3).map((l) => l.replace(/ \[ref=e\d+\]/, '').replace(/cor:[0-9a-f]{6}/, 'cor:{id}').replace(/^e[\d, e]+ (→|✗)/, '$1')).join('\n'); // P2a: entries carry fresh ids and refs
  assert.equal(body(byName), body(byRef));
});

test('2. a control name shared by two controls is not guessed at', async () => {
  await page.setContent('<div class="a"><button>Details</button><p>A</p></div><div class="a"><button>Details</button><p>B</p></div>');
  await raw('cor_snapshot');
  const out = await raw('cor_snapshot', { within: 'Details' });
  assert.match(out, /No region is named "Details"/, out);
});

test('3. the instructions say to put independent calls in one turn', () => {
  assert.match(client.getInstructions(), /Put independent calls in one turn/);
});

test('1. a zero-height parent that does not clip (float layout) hides nothing', async () => {
  await page.setContent('<button>Monthly</button><div style="height:0"><p class="price" style="float:left">375</p></div>');
  await page.evaluate(() => document.querySelector('button').addEventListener('click', () => { document.querySelector('.price').textContent = '445'; }));
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "Monthly"/) });
  assert.match(out, /~ "375" → "445"/, out);
});
