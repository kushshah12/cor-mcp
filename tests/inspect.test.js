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
  const server = createServer({ session });
  server.server.onclose = null; // the shared session outlives each test's connection
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
  };
}

/** Open a fixture and snapshot it; returns the snapshot lines keyed by ref. */
async function openAndSnapshot(call, page) {
  await call('cor_open', { url: `${base}/${page}` });
  const snap = await call('cor_snapshot');
  const lines = snap.text.split('\n').filter((l) => l.startsWith('- '));
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
  // Under Playwright, U12's framework profile ranks role first by design; the test id stays Excellent below it.
  const pw = await call('cor_inspect', { selector: '#email' });
  assert.equal(bestCode(pw.text), `page.getByRole('textbox', { name: 'Email' })`);
  assert.match(pw.text, /page\.getByTestId\('email-input'\)\n\s+99 Excellent · 1 match/);
});

test('AE1: an ambiguous element gets a uniquely-resolving top pick and says what was demoted', async (t) => {
  const call = await connect(t);
  const { refOf } = await openAndSnapshot(call, 'shapes.html');
  const out = await call('cor_inspect', { ref: refOf(/"Remove".*in "Blue Cap"/) });
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
  assert.ok(!lines.some((l) => /^- button \[ref=/.test(l)), 'the nameless zero-size button is omitted');
  assert.ok(lines.some((l) => /^- button "Checkout"/.test(l)), 'the icon button with an aria-label is kept');

  const prose = await openAndSnapshot(call, 'prose.html');
  const aria = await (await session.getPage()).locator('body').ariaSnapshot();
  assert.ok(prose.snap.text.length < aria.length / 10, `snapshot ${prose.snap.text.length} chars vs ariaSnapshot ${aria.length}`);
});

test('cor_open waits for a client-rendered page, so the snapshot is not empty', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'spa.html');
  assert.deepEqual(lines.map((l) => l.replace(/ \[ref=e\d+\]/, '')), ['- button "Add to cart"', '- button "Checkout"']);
});

test('elements sharing a name are told apart — by context hint, and by the ✓id marker', async (t) => {
  const call = await connect(t);
  const { lines } = await openAndSnapshot(call, 'traps.html');
  const removes = lines.filter((l) => /"Remove"/.test(l));
  assert.deepEqual(removes.map((l) => l.match(/in "([^"]+)"/)?.[1]), ['Red Hat', 'Blue Shirt', 'Green Scarf']);
  const applies = lines.filter((l) => /"Apply"/.test(l));
  assert.equal(applies.length, 2);
  assert.equal(applies.filter((l) => l.includes('✓id')).length, 1, 'only the test-id Apply is marked');
  assert.ok(!lines.some((l) => /"Continue".* in "/.test(l)), 'no hint on a unique name');
});

// ── refs ────────────────────────────────────────────────────────────────────
test('a ref is stale after navigation and after an act call, and never resolves to another element', async (t) => {
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
  await call('cor_fill', { ref: fresh, value: 'a@b.co' }); // act by ref works, then ends the snapshot
  const afterAct = await call('cor_inspect', { ref: fresh });
  assert.equal(afterAct.isError, true);
  assert.match(afterAct.text, /stale: .*act call changed the page/);
  assert.equal(await (await session.getPage()).inputValue('#email'), 'a@b.co');
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
  assert.equal(bySelector.text, byRef.text);
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
  assert.match(out.text, /Point-in-time — true on this page now: 79 Good · 1 match/);
  assert.match(out.text, /Durable — stays true while the locator string is unchanged/);
  const line = out.text.split('\n').find((l) => l.startsWith('// COR:'));
  assert.equal(
    line,
    "// COR: anchored on ARIA role and accessible name; risk: coupled to a label / accessible name; " +
      "chosen over page.getByTestId('email-input') because playwright guidance prefers role over testId",
  );
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
