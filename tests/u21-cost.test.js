// U21 — the plain-prompt run's extra turns (cdce0474, 2026-09-26): COR used
// 33 turns to the Playwright agent's 17, and every turn re-reads the context.
// 1. FAQ answer: 8 calls. The scoped snapshot showed the answer as a text line
//    with no ref, so the agent guessed selectors to inspect it.
// 2. One guess used Playwright syntax (:text-is), which cor_inspect rejected
//    as invalid CSS.
// 3. The For Individuals click reply was 4.4k characters: every removed
//    control on its own line, the same ones twice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { handleFromPage } from '../src/page-runtime.js';

let base;
const site = createHttpServer((req, res) => {
  if (!/^\/[\w-]+$/.test(req.url)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL(`./fixtures/${req.url.slice(1)}.html`, import.meta.url), 'utf8'));
});
after(() => site.close());
const session = createSession({ headless: true });
after(() => session.close());

let raw;
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
  raw = async (name, args = {}) => (await call(name, args)).text;
});

const refOf = (text, pattern) => {
  const line = text.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `${pattern} not in\n${text}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

// ── 1. text lines carry refs ───────────────────────────────────────────────
test('1. a scoped snapshot gives each text line a ref, and inspecting the answer gives its template', async () => {
  await raw('cor_open', { url: `${base}/faq` });
  const snap = await raw('cor_snapshot');
  await raw('cor_click', { ref: refOf(snap, /How secure is my payment\?/) });
  const scoped = await raw('cor_snapshot', { within: refOf(snap, /How secure is my payment\?/) });
  const answer = refOf(scoped, /^- text "Payments are encrypted end to end\." \[ref=e\d+\]$/);
  const inspected = await raw('cor_inspect', { ref: answer });
  assert.match(inspected, /Recommended — parameterised/, inspected);
  assert.match(inspected, /faq-item__answer/);
});

test('1. a text line spanning inline elements refs the element that holds all of it', async () => {
  const page = await session.getPage();
  await page.setContent('<section><h2>Plan</h2><p class="price"><span>$</span> <b>375</b> / month</p><button>Choose</button></section>');
  await raw('cor_snapshot');
  const scoped = await raw('cor_snapshot', { within: 'Plan' });
  const ref = refOf(scoped, /^- text "\$ 375 \/ month" \[ref=e\d+\]$/);
  const held = await handleFromPage(page, 'element', { ref });
  assert.equal(await held.evaluate((el) => el.className), 'price');
});

// ── 2. Playwright selector syntax ──────────────────────────────────────────
test('2. cor_inspect accepts a Playwright selector (:text-is, >>) when it is not CSS', async () => {
  await raw('cor_open', { url: `${base}/faq` });
  const out = await call('cor_inspect', { selector: 'div.faq-item:has(p:text-is("How secure is my payment?")) >> div.faq-item__answer' });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /faq-item__answer/);
  const byText = await call('cor_inspect', { selector: 'text="Can I get invoices?"' });
  assert.equal(byText.isError, false, byText.text);
});

test('2. a Playwright selector matching several or none is refused with the count', async () => {
  await raw('cor_open', { url: `${base}/faq` });
  const many = await call('cor_inspect', { selector: 'div.faq-item >> div.faq-item__answer' });
  assert.equal(many.isError, true);
  assert.match(many.text, /matches 3 elements/);
  const none = await call('cor_inspect', { selector: 'text="No such question"' });
  assert.equal(none.isError, true);
  assert.match(none.text, /No element matches/);
  const junk = await call('cor_inspect', { selector: 'div[[[' });
  assert.equal(junk.isError, true);
  assert.match(junk.text, /is not a valid selector/);
});

test('2. cor_grade grades a Playwright selector string too', async () => {
  await raw('cor_open', { url: `${base}/faq` });
  const out = await call('cor_grade', { selector: 'div.faq-item:has(p:text-is("How secure is my payment?")) div.faq-item__answer' });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /1 match/);
});

// ── 3. a mass removal is one line ──────────────────────────────────────────
test('3. controls an act removed collapse into one line with counts', async () => {
  await raw('cor_open', { url: `${base}/act-text` });
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "For Individuals"/) });
  assert.match(out, /^- gone \(7\): button "Choose" ×3, link "Details" ×3, radio "Team"$/m, out);
  assert.doesNotMatch(out, /^- button "Choose"$/m);
});

test('3. a single removed control is listed as before', async () => {
  const page = await session.getPage();
  await page.setContent('<button id="x" onclick="document.getElementById(\'y\').remove()">Close</button><button id="y">Banner</button>');
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "Close"/) });
  assert.match(out, /^- button "Banner"$/m, out);
});

// ── 4. what the For Individuals reply still spent (live: 4,096 characters) ──
test('4. a newly shown section is one line with a within hint, not ten', async () => {
  await raw('cor_open', { url: `${base}/act-text` });
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "Show desktop plans"/) });
  assert.match(out, /^\+ 10 new lines in section "Desktop", e\.g\. "Desktop line 1" \[ref=e\d+\] — cor_snapshot within: "Desktop" for all$/m, out);
  assert.match(out, /^\+ "Desktop" \[ref=e\d+\]$/m); // the heading itself, one line
  assert.doesNotMatch(out, /Desktop line 5/);
});

test('4. stale refs are grouped by reason, and a long group is counted', async () => {
  await raw('cor_open', { url: `${base}/act-text` });
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "For Individuals"/) });
  assert.match(out, /stale: e\d+, e\d+, e\d+, … 7 refs \(was removed\)/, out);
  assert.equal((out.match(/was removed/g) ?? []).length, 1);
});

test('4. the group click is scoped by a base class, never a size modifier', async () => {
  await raw('cor_open', { url: `${base}/control-groups` });
  const page = await session.getPage();
  // BrowserStack's shape: the base class is common (another toggle), the size modifier is rare.
  await page.evaluate(() => {
    document.querySelector('div.toggle').className = 'toggle toggle--medium';
    document.body.insertAdjacentHTML('beforeend', '<div class="toggle"><span>Other</span></div>');
  });
  await raw('cor_snapshot');
  const out = await raw('cor_inspect', { selector: '#pt2' });
  assert.match(out, /change it: page\.locator\('div\.toggle'\)\.getByText\(planTypeSelector/, out);
  // …and the single-item note would repeat it page-wide, so it is left out.
  assert.doesNotMatch(out, /Hidden input, operated through its visible label/);
});

// BrowserStack's feature items: each holds an info button, so each is an item named by its line.
test('4. a new line is not said to be "in" an item named by that same line', async () => {
  const page = await session.getPage();
  await page.setContent('<button onclick="document.querySelector(\'ul\').hidden = false">More</button><ul hidden><li><span>Alpha feature</span> <button>info</button></li><li><span>Beta feature</span> <button>info</button></li></ul>');
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "More"/) });
  assert.match(out, /^\+ "Alpha feature" \[ref=e\d+\]$/m, out);
});

test('4. new text in more than four regions: the rest are counted, not dropped', async () => {
  const page = await session.getPage();
  const sections = ['One', 'Two', 'Three', 'Four', 'Five'].map((n) => `<section><h2>${n}</h2><p>${n} a</p><p>${n} b</p></section>`).join('');
  await page.setContent(`<button onclick="document.querySelector('.more').hidden = false">Show</button><div class="more" hidden>${sections}</div>`);
  const snap = await raw('cor_snapshot');
  const out = await raw('cor_click', { ref: refOf(snap, /button "Show"/) });
  assert.equal((out.match(/^\+ /gm) ?? []).length, 4, out);
  assert.match(out, /…and \d+ more text changes/);
});
