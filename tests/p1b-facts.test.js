// P1b: the `Facts:` block of cor_inspect (spec §7.1) — one line per check COR ran, the same in every
// framework, at most 5 lines of at most 140 characters, no API names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { factsFor, factsLines } from '../src/facts.js';
import { renderInspect } from '../src/format.js';

const INLINE = {
  // an FAQ answer that opens by growing a collapsed wrapper (BrowserStack)
  '/accordion': `<style>.wrap { height: 0; overflow: hidden } .item.open .wrap { height: 60px }</style>
    <div class="item"><p class="q">How secure is my payment?</p><div class="wrap"><div class="answer" id="a1">All payments use HTTPS.</div></div></div>`,
  // a name that carries a percentage
  '/promo': '<title>Promo</title><button>Save 25% today</button><p>Other</p>',
};
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  const inline = INLINE[req.url.split('?')[0]];
  if (inline) return res.end(inline);
  try { res.end(readFileSync(new URL(`./fixtures${req.url.split('?')[0]}`, import.meta.url), 'utf8')); } catch { res.end('missing'); }
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
  call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
});
after(() => { site.closeAllConnections?.(); site.close(); return session.close(); });

const FRAMEWORKS = ['playwright', 'webdriverio', 'cypress'];
/** The Facts block of an inspect reply, as its lines without the bullet. */
async function facts(path, selector, framework = 'playwright') {
  await call('cor_open', { url: `${base}${path}` });
  const out = await call('cor_inspect', { selector, framework });
  const lines = out.split('\n');
  const at = lines.indexOf('Facts:');
  const block = [];
  if (at >= 0) for (let i = at + 1; lines[i]?.startsWith('  • '); i++) block.push(lines[i].slice(4));
  return { out, block };
}
const CARD = '.grid .card:nth-child(2) button';

test('P1b hidden-copies: the count and the stable scope, in every framework', async () => {
  for (const fw of FRAMEWORKS) {
    const { block } = await facts('/plans.html', CARD, fw);
    assert.ok(block.includes('hidden copies: 1 copy of these items in the page, not shown — scope by div[data-product-id="live"]'), `${fw}\n${block.join('\n')}`);
  }
});

test('P1b hidden-copies: without a stable scope it says to match the displayed ones only', async () => {
  await call('cor_open', { url: `${base}/plans.html` });
  const page = await session.getPage();
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-product-id]')) el.removeAttribute('data-product-id'); });
  const out = await call('cor_inspect', { selector: CARD, framework: 'playwright' });
  assert.match(out, /• hidden copies: 1 copy of these items in the page, not shown — match the displayed ones only/);
});

test('P1b variant-behind-toggle: a variant is shown by another item\'s toggle', async () => {
  for (const fw of FRAMEWORKS) {
    const { block } = await facts('/plans.html', CARD, fw);
    assert.ok(block.includes('"Team Pro" is shown by the "Team" item\'s toggle — click the toggle first'), `${fw}\n${block.join('\n')}`);
  }
});

test('P1b label-operated-input: hidden inputs are operated by their labels', async () => {
  for (const fw of FRAMEWORKS) {
    const { block } = await facts('/toggles.html', '#annual', fw);
    assert.deepEqual(block, ['hidden inputs, operated by their labels — click the label, assert the state; forcing a click on the input skips what a user does'], fw);
  }
});

test('P1b collapsed-content: text clipped by a collapsed wrapper', async () => {
  const { block } = await facts('/accordion', '#a1', 'cypress');
  assert.ok(block.includes('this text is clipped by a collapsed wrapper until opened — "displayed" is true while collapsed; assert its text or height'), block.join('\n'));
  assert.equal((await facts('/plans.html', CARD)).block.some((l) => /collapsed/.test(l)), false, 'not said of an ordinary element');
});

test('P1b separate-header-table: a cell whose column headers are in another table', async () => {
  for (const fw of FRAMEWORKS) {
    const { block } = await facts('/compare.html', 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)', fw);
    assert.deepEqual(block, ['column headers are in a separate table above the rows'], fw);
  }
  const plain = await facts('/compare.html', 'thead th:nth-child(3)');
  assert.equal(plain.block.some((l) => /separate table/.test(l)), false);
});

test('P1b changing-value: the best locator holds a price or percentage', async () => {
  const { block } = await facts('/promo', 'button', 'playwright');
  assert.ok(block.includes('the locator\'s text holds a value that changes (a price or percentage) — use the stable part of the name'), block.join('\n'));
});

test('P1b lookalikes: the other visible elements that look the same', async () => {
  const { block } = await facts('/plans.html', CARD);
  assert.ok(block.includes('1 other visible button "Choose" looks the same'), block.join('\n'));
});

test('P1b ambiguity-consequence: what the framework does with several matches, from the engine\'s failure mode', async () => {
  for (const fw of FRAMEWORKS) {
    const { block } = await facts('/plans.html', CARD, fw);
    const line = block.find((l) => /^a locator matching \d+ elements/.test(l));
    assert.ok(line, `${fw}\n${block.join('\n')}`);
    // the count differs by framework (the engine counts what each one would match); the consequence must follow the engine's failure mode
    if (fw === 'playwright') assert.match(line, /the test fails at once$/);
    if (fw === 'webdriverio') assert.match(line, /the run acts on the first match and does not fail$/);
    if (fw === 'cypress') assert.match(line, /(the run acts on the first match and does not fail|an action fails, an assertion runs on all of them)$/);
  }
});

test('P1b state-only-unique: unique only after an act removed the other match', async () => {
  await call('cor_open', { url: `${base}/cart-live.html` });
  await call('cor_click', { target: '#add' });
  const out = await call('cor_inspect', { selector: '.float-cart .bag__quantity' });
  assert.match(out, /• unique only in this state \(.+ was removed by the last act\)/);
});

test('P1b: nothing to say, no block; a plain element gets none of the page facts', async () => {
  const { out, block } = await facts('/plans.html', 'h1', 'playwright');
  assert.deepEqual(block, []);
  assert.doesNotMatch(out, /^Facts:/m);
});

// ── the rules: at most 5 lines, at most 140 characters, severity order, the facts sit after the recommendation ──
const RESULT = {
  params: { hidden: { count: 3, scope: 'div[data-plan-type="teams"]' }, variants: [{ of: 'Team', values: ['Team Pro'] }], act: 'x', separateHeader: true },
  collapsed: true, viaLabel: 'Annually', stateOnly: { what: 'the badge' },
  lookalikes: { role: 'button', name: 'Choose', items: [{}, {}, {}] },
  locators: [{ signals: [{ id: 'changing-value' }], matchCount: 1 }, { matchCount: 4, resolution: { failureMode: 'strict-mode-error' } }],
};

test('P1b F2: at most 5 facts, in severity order, hidden-copies first', () => {
  const list = factsFor(RESULT).map((f) => f.type);
  assert.deepEqual(list, ['hidden-copies', 'collapsed-content', 'variant-behind-toggle', 'label-operated-input', 'separate-header-table']);
});

test('P1b F2: no fact is longer than 140 characters', () => {
  const long = factsFor({ params: { hidden: { count: 2, scope: `div[data-x="${'a'.repeat(300)}"]` } } });
  assert.equal(long[0].text.length, 140);
  assert.ok(long[0].text.endsWith('…'));
  for (const f of factsFor(RESULT)) assert.ok(f.text.length <= 140, f.text);
});

test('P1b F1/F4: a fact needs its check; no API names in any fact text', () => {
  assert.deepEqual(factsFor({}), []);
  assert.deepEqual(factsLines({ locators: [] }), []);
  const all = [...factsFor(RESULT), ...factsFor({ ...RESULT, params: null, collapsed: false, viaLabel: null })].map((f) => f.text).join('\n');
  assert.doesNotMatch(all, /getBy|locator\(|cy\.|\$\(|page\./);
});

test('P1b F3: the block comes after the recommended locator and before the durable line', async () => {
  const { out } = await facts('/plans.html', CARD, 'cypress');
  const at = (re) => out.search(re);
  assert.ok(at(/^Recommended — parameterised/m) < at(/^Facts:/m));
  assert.ok(at(/^For this one item alone/m) < at(/^Facts:/m));
  assert.ok(at(/^Facts:/m) < at(/^Durable — /m));
});

test('P1 the MCP never reorders the engine\'s candidates: alternatives are printed in the order given, in every framework', () => {
  for (const framework of FRAMEWORKS) {
    const loc = (n, value) => ({ value, code: value, score: 90 - n, tier: 'good', tierLabel: 'Good', matchCount: 1, signals: [], strategy: 'css' });
    const result = { framework, profile: null, locators: [loc(0, 'a-first'), loc(1, 'b-second'), loc(2, 'c-third'), loc(3, 'd-fourth')], params: null };
    const out = renderInspect(result, { framework, all: true });
    const order = ['b-second', 'c-third', 'd-fourth'].map((v) => out.indexOf(v));
    assert.ok(out.indexOf('a-first') < order[0] && order[0] < order[1] && order[1] < order[2], framework);
    assert.match(out, /^2\. b-second/m);
    assert.match(out, /^4\. d-fourth/m);
  }
});

test('P1b P3: a locator that matches several elements never leads, in every framework', async () => {
  for (const fw of FRAMEWORKS) {
    const { out } = await facts('/plans.html', CARD, fw);
    const lead = out.split('Alternatives:')[0]; // the ranked-first locator; ambiguous ones are only listed below it
    assert.match(lead, /· 1 match/, fw);
    assert.doesNotMatch(lead, /· \d+ matches/, fw);
  }
});

test('P1b N2: the block adds at most 15% to the reply on the pricing-shaped fixture', async () => {
  const { out, block } = await facts('/plans.html', CARD, 'playwright');
  const blockLength = ['Facts:', ...block.map((l) => `  • ${l}`)].join('\n').length;
  assert.ok(blockLength / (out.length - blockLength) <= 0.15, `${blockLength} of ${out.length}`);
});

test('P1b: each fact comes from its own check — hidden inputs from the group template alone, changing-value from the top locator only', () => {
  assert.deepEqual(factsFor({ params: { act: 'x' } }).map((f) => f.type), ['label-operated-input']);
  assert.deepEqual(factsFor({ params: { actReason: 'no scope' } }).map((f) => f.type), ['label-operated-input']);
  assert.deepEqual(factsFor({ viaLabel: 'Annually' }).map((f) => f.type), ['label-operated-input']);
  assert.deepEqual(factsFor({ params: {} }), []);
  const promo = { signals: [{ id: 'changing-value' }], matchCount: 1 };
  assert.deepEqual(factsFor({ locators: [{ signals: [], matchCount: 1 }, promo] }), [], 'a runner-up with a price is not the recommendation');
  assert.deepEqual(factsFor({ locators: [promo] }).map((f) => f.type), ['changing-value']);
  assert.deepEqual(factsFor({ locators: [{ matchCount: 1, resolution: { failureMode: null } }] }), [], 'a unique locator has no ambiguity consequence');
});
