import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { renderInspect } from '../src/format.js';
import { expandGroups } from './helpers/outline.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let base;
const site = createHttpServer((req, res) => {
  const name = req.url.slice(1) || 'shapes.html';
  if (name === 'data') {
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(['Add to cart', 'Checkout']));
    }, 300);
  }
  let html;
  try {
    html = name === 'next' ? '<title>Next</title><button>Only</button>' : fixture(name);
  } catch {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

// One browser for the file; every test gets its own server over it.
const session = createSession({ headless: true });
after(() => session.close());

async function connect(t) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  session.resolveFramework('playwright'); // the shared session keeps a framework argument (P1a); each test starts from the default
  const server = createServer({ session });
  server.server.onclose = null; // the shared session outlives each test's connection
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: expandGroups(result.content.map((c) => c.text).join('\n')) };
  };
}

/**
 * Each element line of an outline snapshot with its full path, e.g.
 * `table › column "Team Ultimate" › button "Choose" [ref=e4] +1 hidden`.
 */
function outlinePaths(text) {
  const stack = [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^( *)- (.*)$/.exec(line);
    if (!m) continue;
    const depth = m[1].length / 2;
    stack.length = depth;
    stack.push(m[2]);
    if (/\[ref=e\d+\]/.test(m[2])) out.push(stack.join(' › '));
  }
  return out;
}

/** Open a fixture and snapshot it; `lines` are element paths, `refOf` finds one by pattern. */
async function openAndSnapshot(call, page) {
  await call('cor_open', { url: `${base}/${page}` });
  const snap = await call('cor_snapshot');
  const lines = outlinePaths(snap.text);
  const refOf = (pattern) => {
    const line = lines.find((l) => pattern.test(l));
    assert.ok(line, `no snapshot line matches ${pattern}\n${snap.text}`);
    return line.match(/\[ref=(e\d+)\]/)[1];
  };
  return { snap, lines, refOf };
}

const bestCode = (text) => text.split('\n')[1].trim();

// ── inspect ─────────────────────────────────────────────────────────────────
test('a well-marked element ranks its test id first, Excellent, where the framework prefers test ids', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '#email', framework: 'cypress' });
  assert.equal(bestCode(out.text), `cy.get('[data-cy="email-input"]')`);
  assert.match(out.text, /Point-in-time — true on this page now: 99 Excellent · 1 match/);
  // U5: Playwright follows its published order — role first — test attribute or not; the test attribute is the runner-up.
  const pw = await call('cor_inspect', { selector: '#email', framework: 'playwright' });
  assert.equal(bestCode(pw.text), `page.getByRole('textbox', { name: 'Email' })`);
  assert.match(pw.text, /^2\. page\.locator\('\[data-cy="email-input"\]'\)\n {3}99 Excellent · 1 match/m);
  // U11: with an entry only the runner-up shows; all: true lists the rest.
  assert.match((await call('cor_inspect', { selector: '#email', framework: 'playwright', all: true })).text, /page\.getByLabel\('Email'\)/, 'the label form is still offered');
});

test('AE1: an ambiguous element gets a uniquely-resolving top pick and says what was demoted', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'shapes.html');
  const out = await call('cor_inspect', { ref: refOf(/item "Blue Cap" › button "Remove"/) });
  assert.match(out.text, /Point-in-time — true on this page now: \d+ \w+ · 1 match\n/);
  assert.match(out.text, /Why this order: Demoted .*Matches 3 elements/);
});

test('every returned locator carries a match count', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/traps.html` });
  const page = await session.getPage();
  for (const selector of ['#cart li:nth-child(2) button', '[data-testid="apply-promo"]', 'input[name="promo"]', '.icon-btn']) {
    const result = await callPage(page, 'inspect', { selector, framework: 'playwright', max: 6 });
    assert.ok(result.locators.length > 0);
    for (const l of result.locators) assert.equal(typeof l.matchCount, 'number', `${l.code} has no match count`);
  }
});

test('the framework argument changes the emitted code; the default is Playwright', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const shapes = {
    playwright: /^page\./, cypress: /^cy\./, selenium: /By\./, webdriverio: /^(await )?\$\(/,
    nightwatch: /^browser\./, testcafe: /^Selector\(/, puppeteer: /^(await )?page\./,
  };
  assert.match(bestCode((await call('cor_inspect', { selector: '#email' })).text), shapes.playwright);
  for (const [framework, shape] of Object.entries(shapes)) {
    const out = await call('cor_inspect', { selector: '#email', framework });
    assert.match(bestCode(out.text), shape, framework);
  }
});

// ── snapshot ────────────────────────────────────────────────────────────────
test('the snapshot lists only visible interactive elements and is much smaller than ariaSnapshot()', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'shapes.html');
  assert.ok(lines.some((l) => /textbox "Email"/.test(l)));
  assert.ok(lines.some((l) => /link "Next page"/.test(l)));
  assert.ok(!lines.some((l) => /Hidden/.test(l)), 'display:none omitted');
  assert.ok(!lines.some((l) => /Anchor without href/.test(l)), 'non-interactive omitted');
  assert.ok(!lines.some((l) => /(^| › )button \[ref=/.test(l)), 'the nameless zero-size button is omitted');
  assert.ok(lines.some((l) => /(^| › )button "Checkout"/.test(l)), 'the icon button with an aria-label is kept');

  const prose = await openAndSnapshot(call, 'prose.html');
  const aria = await (await session.getPage()).locator('body').ariaSnapshot();
  assert.ok(prose.snap.text.length < aria.length / 10, `snapshot ${prose.snap.text.length} chars vs ariaSnapshot ${aria.length}`);
});

test('cor_open waits for a client-rendered page, so the snapshot is not empty', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'spa.html');
  assert.deepEqual(lines.map((l) => l.replace(/ \[ref=e\d+\]/, '')), ['button "Add to cart"', 'button "Checkout"']);
});

test('the outline nests each element under what identifies it (traps page)', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'traps.html');
  const strip = (l) => l.replace(/ \[ref=e\d+\]/, '');
  // Three identical Remove buttons, told apart by their list items.
  assert.deepEqual(lines.filter((l) => /"Remove"/.test(l)).map(strip), [
    'item "Red Hat" › button "Remove"', 'item "Blue Shirt" › button "Remove"', 'item "Green Scarf" › button "Remove"',
  ]);
  // Two Apply buttons, only one with a test attribute.
  const applies = lines.filter((l) => /"Apply"/.test(l));
  assert.equal(applies.length, 2);
  assert.equal(applies.filter((l) => l.includes('✓id')).length, 1);
  // A link in the page header sits under it; a unique button carries no container or hint.
  assert.ok(lines.includes(lines.find((l) => /^header › link "Terms of service"/.test(l))));
  assert.match(lines.find((l) => /"Continue"/.test(l)), /^button "Continue" \[ref=e\d+\]$/);
});

test('the outline: sections by heading, tables by column and row, lookalikes by text, then position', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'pricing.html');
  const paths = (name) => lines.filter((l) => l.includes(`"${name}" [ref=`)).map((l) => l.replace(/ \[ref=e\d+\]/, ''));
  // The BrowserStack case, from structure alone: a card section and a table column.
  assert.deepEqual(paths('Choose'), [
    'section "Team Ultimate" › button "Choose" +1 hidden',
    'table › column "Team Ultimate" › button "Choose" +1 hidden',
  ]);
  // A <select> is shown with its chosen option, next to the button it prices.
  assert.ok(lines.some((l) => /^table › column "Team Ultimate" › combobox = "5 users \| \$75 per user"/.test(l)));
  // Rows under one heading: the heading is a section, each row an item.
  assert.deepEqual(paths('Delete'), ['section "Users" › item "Alice" › button "Delete"', 'section "Users" › item "Bob" › button "Delete"']);
  // Headings beat nearer text (the price).
  assert.deepEqual(paths('Buy'), ['section "Users" › section "Basic" › button "Buy"', 'section "Users" › section "Pro" › button "Buy"']);
  // Nothing but position: ordinals, never another element's text.
  assert.deepEqual(paths('Help'), ['section "Users" › button "Help" (1 of 2)', 'section "Users" › button "Help" (2 of 2)']);
});

// ── lookalike guard ─────────────────────────────────────────────────────────
test('inspecting one of two lookalikes leads with the other and its ref (the BrowserStack case)', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'pricing.html');
  const card = refOf(/^section "Team Ultimate" › button "Choose"/);
  const table = refOf(/^table › column "Team Ultimate" › button "Choose"/);

  const out = await call('cor_inspect', { ref: table });
  assert.deepEqual(out.text.split('\n').slice(0, 5), [
    '⚠ Check this is the element you meant: 1 other visible element looks the same — button "Choose".',
    `  You inspected: ${table} in "Team Ultimate" (table)`,
    `  Also:          ${card} in "Team Ultimate"`,
    '  If you meant another one, cor_inspect its ref instead.',
    '',
  ]);
  assert.match(out.text, /\nBest locator \(playwright\):/, 'the verdict still follows');

  const back = await call('cor_inspect', { ref: card });
  assert.match(back.text, new RegExp(`You inspected: ${card} in "Team Ultimate"\n  Also:          ${table} in "Team Ultimate" \\(table\\)`));
});

test('a unique element gets no warning, nor does a target the snapshot never listed', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'pricing.html');
  const out = await call('cor_inspect', { ref: refOf(/combobox/) });
  assert.match(out.text, /^Best locator/);
  const box = await call('cor_inspect', { selector: '#plain-box' });
  assert.equal(box.isError, false);
  assert.match(box.text, /^(Best locator|Recommendation)/, 'nameless focusable divs are not lookalikes of a plain div');
});

test('without a current snapshot, lookalikes are described but their refs are not offered', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/pricing.html` });
  const bySelector = await call('cor_inspect', { selector: 'table input[type="submit"]' });
  assert.match(bySelector.text, /^⚠ Check this is the element you meant/);
  assert.match(bySelector.text, /You inspected: in "Team Ultimate" \(table\)\n  Also:          in "Team Ultimate"\n/);
  assert.match(bySelector.text, /call cor_snapshot for current refs/);

  // Refs that survive an act (U16) are still offered…
  const { refOf } = await openAndSnapshot(call, 'pricing.html');
  const card = refOf(/^section "Team Ultimate" › button "Choose"/);
  await call('cor_fill', { target: 'select', value: '5 users | $75 per user' });
  const kept = await call('cor_inspect', { selector: 'table input[type="submit"]' });
  assert.match(kept.text.split('Best locator')[0], new RegExp(`Also: +${card} in "Team Ultimate"`));
  // …refs a navigation expired are not.
  await call('cor_open', { url: `${base}/pricing.html` });
  const expired = await call('cor_inspect', { selector: 'table input[type="submit"]' });
  assert.doesNotMatch(expired.text.split('Best locator')[0], new RegExp(`\\b${card}\\b`));
  assert.match(expired.text, /call cor_snapshot for current refs/);
});

test('many lookalikes: five are listed and the rest counted', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'pricing.html');
  const out = await call('cor_inspect', { ref: refOf(/item "Item 4" › button "Add"/) });
  const head = out.text.split('\n\n')[0].split('\n');
  assert.equal(head[0], '⚠ Check this is the element you meant: 6 other visible elements look the same — button "Add".');
  assert.match(head[1], /You inspected: e\d+ in "Item 4"/);
  assert.equal(head.filter((l) => l.startsWith('  Also:')).length, 5);
  assert.ok(head.includes('  …and 1 more.'));
});

// ── refs ────────────────────────────────────────────────────────────────────
test('a ref is stale after navigation; an act that leaves its element alone keeps it (U16)', async (t) => {
  const call = await connect(t);
  let { refOf } = await openAndSnapshot(call, 'shapes.html');
  const email = refOf(/textbox "Email"/);
  assert.equal((await call('cor_inspect', { ref: email })).isError, false);

  await call('cor_open', { url: `${base}/next` }); // navigation
  const afterNav = await call('cor_inspect', { ref: email });
  assert.equal(afterNav.isError, true);
  assert.match(afterNav.text, /stale: the page navigated.*cor_snapshot again/);
  assert.doesNotMatch(afterNav.text, /Best locator/);

  ({ refOf } = await openAndSnapshot(call, 'shapes.html'));
  const fresh = refOf(/textbox "Email"/);
  const filled = await call('cor_fill', { ref: fresh, value: 'a@b.co' }); // act by ref works…
  assert.match(filled.text, /Refs: \d+ still valid\./);
  assert.equal((await call('cor_inspect', { ref: fresh })).isError, false, '…and the ref survives it');
  assert.equal(await (await session.getPage()).inputValue('#email'), 'a@b.co');
});

test('refs are never renumbered: a ref from an earlier snapshot is old, never another element', async (t) => {
  const call = await connect(t);
  const first = await openAndSnapshot(call, 'shapes.html');
  const old = first.refOf(/textbox "Email"/);
  const second = await openAndSnapshot(call, 'shapes.html'); // same URL, new page load: numbering restarts with the document
  assert.equal(second.refOf(/textbox "Email"/), old, 'a fresh document starts at e1 again');

  const again = await call('cor_snapshot'); // same document: new numbers
  const renumbered = again.text.match(/textbox "Email" \[ref=(e\d+)\]/)[1];
  assert.notEqual(renumbered, old);
  const stale = await call('cor_inspect', { ref: old });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /is from an earlier cor_snapshot of this page/);
  assert.equal((await call('cor_inspect', { ref: renumbered })).isError, false);
});

test('a ref that never existed returns an actionable message', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'shapes.html');
  const out = await call('cor_inspect', { ref: 'e999' });
  assert.match(out.text, new RegExp(`Ref e999 does not exist — the last cor_snapshot issued e1–e${lines.length}\\.`));
  assert.doesNotMatch(out.text, /\n\s+at /);
});

test('a raw selector resolves the same element as its ref', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'traps.html');
  const byRef = await call('cor_inspect', { ref: refOf(/"Place order"/) });
  const bySelector = await call('cor_inspect', { selector: '[data-testid="place-order"]' });
  const noId = (s) => s.replace(/cor:[0-9a-f]{6}/g, 'cor:{id}'); // U8: ids are issued per call
  assert.equal(noId(bySelector.text), noId(byRef.text));
  assert.match((await call('cor_inspect', { selector: 'button.rm' })).text, /matches 3 elements/);
});

// ── recommendations and the durable line ────────────────────────────────────
test('an element with no viable locator returns recommendations, not an empty list', () => {
  // No real DOM produced an empty list in probing (even <html> and <head> get
  // one), so this pins the renderer on the engine's empty-result shape.
  const out = renderInspect({
    framework: 'playwright', locators: [], rankingNote: null, profile: null,
    recommendations: ['Add a data-testid attribute for long-term resilience'],
  });
  assert.match(out, /^No locator could be generated/);
  assert.match(out, /- Add a data-testid attribute/);
});

test('AE9: point-in-time and durable are separated, and the placeable line carries no number', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '#email' });
  // U5: role leads under Playwright (79 Good), chosen over the test attribute by Playwright's published order
  assert.match(out.text, /Point-in-time — true on this page now: 79 Good · 1 match/);
  assert.match(out.text, /Durable — stays true while the locator string is unchanged/);
  const line = out.text.split('\n').find((l) => l.startsWith('// COR:'));
  assert.match(line, /^\/\/ COR: anchored on ARIA role and accessible name; risk: coupled to a label \/ accessible name; chosen over /);
  const withoutCode = line.replace(/page\.[^ ]+\([^)]*\)/g, '');
  assert.doesNotMatch(withoutCode, /\d/, 'no score, no match count');
});

test('a top pick demoted from a higher-scoring ambiguous candidate names it and the reason', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '#plain-cart li:nth-child(2) button' });
  const line = out.text.split('\n').find((l) => l.startsWith('// COR:'));
  assert.match(line, /chosen over page\.locator\('button\.rm'\) because it matches more than one element$/);
});

test('AE7: below the quality floor the answer is an application change, the locator is declined', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '.css-1x7f2k:nth-child(3) > .css-9q8w7e' });
  const lines = out.text.split('\n');
  assert.match(lines[0], /^Recommendation: change the application/);
  assert.match(out.text, /this requires an application change\):\n\s+<div data-testid="[a-z-]+">/);
  const declined = lines.indexOf('Declined as the answer — the most durable locator available today:');
  assert.ok(declined > 0, 'fragile locator shown beneath the recommendation');
  assert.match(lines[declined + 2], /Unstable|Risky/);
  assert.doesNotMatch(out.text, /^Best locator/m);
});

test('AE10: a framework with no published order says no convention was applied', async (t) => {
  const call = await connect(t);
  await call('cor_open', { url: `${base}/shapes.html` });
  const out = await call('cor_inspect', { selector: '#email', framework: 'testcafe' });
  assert.match(out.text, /No framework convention applied — testcafe publishes no locator preference order/);
  assert.doesNotMatch(out.text, /Framework convention applied:/);
});

// ── verification ────────────────────────────────────────────────────────────
test('verification: on the trap page, the top pick resolves uniquely for every element', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'traps.html');
  assert.ok(lines.length >= 15, `expected the full trap page, got ${lines.length} elements`);
  const page = await session.getPage();
  const failures = [];
  for (const line of lines) {
    const ref = line.match(/\[ref=(e\d+)\]/)[1];
    const result = await callPage(page, 'inspect', { ref, framework: 'playwright', max: 6 });
    const [best] = result.locators;
    if (best?.matchCount !== 1) failures.push(`${line} → ${best?.code} matches ${best?.matchCount}`);
  }
  assert.deepEqual(failures, []);
});
