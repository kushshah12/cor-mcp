// P3 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — complete entries: the every-item locator is a
// member with its own id; a variant's toggle click is in the entry; an item that starts open is noted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p3-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIRS = [new URL('./fixtures/', import.meta.url), new URL('../scripts/conformance/fixtures/', import.meta.url)];
const site = createHttpServer((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  for (const dir of DIRS) {
    try { const body = readFileSync(new URL(`${name}.html`, dir)); return res.writeHead(200, { 'content-type': 'text/html' }).end(body); } catch { /* next */ }
  }
  res.writeHead(404).end();
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

const DEPS = { playwright: { '@playwright/test': '1' }, cypress: { cypress: '13' }, webdriverio: { webdriverio: '9' } };
async function connect(t, framework = 'playwright') {
  const dir = join(root, `${framework}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: DEPS[framework] }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session, records: createRecordStore({ root: () => session.root }) });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return { dir, session, call: async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') }; } };
}

test('P3 the every-item locator is a member with its own id; a loop written with it passes cor_check; items share one record', async (t) => {
  const { dir, call } = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  const first = (await call('cor_inspect', { selector: '.faq-item:nth-child(1) .faq-item__question' })).text;
  const second = (await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__answer' })).text;
  const every = /^ {2}\/\/ COR cor:([0-9a-f]{6}) · faqItems\n {2}faqItems = \(\) => this\.page\.locator\('div\.faq-item'\);$/m;
  assert.match(first, every, first);
  assert.equal(every.exec(first)[1], every.exec(second)[1], 'every item of the template shares the every-item record');
  const block = first.split('\n').filter((l) => /^ {2}(\/\/ COR|\w+ = )/.test(l)).join('\n');
  writeFileSync(join(dir, 'faq.page.js'), `export class FaqPage {\n  constructor(page) { this.page = page; }\n${block}\n}\n`);
  const check = (await call('cor_check', { files: ['faq.page.js'] })).text;
  // the question, the every-item locator, and the question inside each item (run b14ddae4) — all carry an id
  assert.match(check, /^cor_check: 3 locators in 1 file \(the given files\) — 3 carry a COR id, 0 to fix\./, check);
  const heal = await call('cor_heal', { id: every.exec(first)[1] });
  assert.match(heal.text, /is an every-item locator — it finds every item, not one element/);
  // P8a: cor_check placed the question and the every-item locator; the answer, shown but not placed, stays pending
  assert.equal(readdirSync(join(dir, '.cor/records')).length, 2, 'question and one every-item record');
  assert.deepEqual(readdirSync(join(dir, '.cor/pending')).filter((f) => f.endsWith('.json')).length, 1, 'the answer');
});

for (const [fw, show] of [
  ['playwright', /showVariant = \(title\) => this\.page\.locator\('div\.plan'\)\.filter\(\{ visible: true \}\)\.locator\('label'\)\.getByText\(title, \{ exact: true \}\);/],
  ['cypress', /showVariant = \(title\) => plan\(title\)\n {4}\.contains\('label', [^\n]*\n {4}\.click\(\)\n {4}\.closest\('label'\)[^\n]*\.should\('be\.checked'\);/],
  ['webdriverio', /showVariant = \(title\) => plan\(title\)\.\$\(`label=\$\{title\}`\)\.click\(\);/],
]) {
  test(`P3 a variant's toggle click is in the entry (${fw}) and the note names it`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3a-either` });
    const out = (await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' })).text;
    assert.match(out, show, out);
    assert.match(out, /\/\/ COR cor:[0-9a-f]{6} · showVariant · variant — click it first/);
    assert.match(out, /^note: "Team Pro" sits behind the "Team" item's toggle — showVariant\("Team Pro"\) first\.$/m);
  });
}

test('P3 an item that is open now is noted — by class, or by aria-expanded — and only when the items differ', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-accordion-open` });
  assert.match((await call('cor_inspect', { selector: '.qa:nth-child(2) .qa__q' })).text, /^note: "Do you offer refunds\?" is open now — clicking it closes it; check its state before clicking$/m);
  assert.match((await call('cor_inspect', { selector: '.acc__item:nth-child(1) .acc__btn' })).text, /^note: "Returns" is open now/m);
  assert.doesNotMatch((await call('cor_inspect', { selector: '.tip:nth-child(2) .tip__t' })).text, /(is|are) open now/, 'every item open: nothing to note');
  await call('cor_open', { url: `${base}/faq` }); // every item closed: nothing to note
  assert.doesNotMatch((await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__question' })).text, /(is|are) open now/);
});

for (const [fw, check] of [['playwright', 'toBeVisible\\(\\)'], ['cypress', "should\\('be\\.visible'\\)"], ['webdriverio', 'isDisplayed\\(\\)']]) {
  test(`P3 an element a closed item clips to 0 height (not hidden) is noted, with ${fw}'s own visibility check named`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-accordion-open` });
    await call('cor_click', { target: '.bs:nth-child(1) .bs__q' });
    const out = (await call('cor_inspect', { selector: '.bs:nth-child(1) .bs__a' })).text;
    assert.match(out, new RegExp(`^note: when its item is closed, bsA is clipped to 0 height, not hidden — ${check} still passes; assert the item's open state or bsA's height instead$`, 'm'), out);
  });
}

test('P3 a 0-height wrapper that does not clip (its text spills and is seen) gets no note', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-accordion-open` });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.sp:nth-child(2) .sp__a' })).text, /clipped to 0 height/);
});

test('P3 a closed item that hides its content (display: none) gets no 0-height note', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  await call('cor_click', { target: '.faq-item:nth-child(3) .faq-item__question' });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.faq-item:nth-child(3) .faq-item__answer' })).text, /clipped to 0 height/);
});

for (const [fw, leaf] of [
  ['playwright', /^ {2}cardPrice = \(title\) => this\.page\.locator\('div\.card'\)\.filter\(\{ has: .*\}\)\.locator\('p\.card__price'\)\.filter\(\{ visible: true \}\);$/m],
  ['cypress', /^ {2}cardPrice = \(title\) => card\(title\)\.find\('p\.card__price'\)\.filter\(':visible'\);$/m],
  ['webdriverio', /^ {2}cardPrice = \(title\) => card\(title\)\.\$\$\('p\.card__price'\)\.find\(\(el\) => el\.isDisplayed\(\)\);$/m],
]) {
  test(`P3 per-card entries (${fw}): a price inside one card gets the card template — hidden twin skipped, a card without a price left out`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-card-price` });
    const out = (await call('cor_inspect', { selector: '.card:nth-child(2) .card__price' })).text;
    assert.match(out, /^✓ cardPrice\(title\) → .* — 3\/3 items checked$/m, out); // Team, Team Ultimate, and the variant Team Pro — not Volume
    assert.match(out, leaf, out);
  });
}

test('P3 per-card entries: after the toggle, the template reaches the price the toggle shows', async (t) => {
  const { call, session } = await connect(t);
  await call('cor_open', { url: `${base}/p3-card-price` });
  const out = (await call('cor_inspect', { selector: '.card:nth-child(1) .card__price:not([hidden])' })).text;
  const code = /^ {2}cardPrice = \(title\) => (.*);$/m.exec(out)[1].replace(/this\.page/g, 'page');
  const page = await session.getPage();
  const price = (title) => new Function('page', 'title', `return ${code}`)(page, title).textContent();
  assert.equal(await price('Team'), '$150 / month');
  await page.click('label[for=t2]');
  assert.equal(await price('Team Pro'), '$200 / month');
  assert.equal(await price('Team Ultimate'), '$375 / month');
});

test('P3 per-card entries: no template when a card shows two of the element, or only one card holds it', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-card-no-template` });
  for (const sel of ['.a .tile:nth-child(2) .cost', '.b .box:nth-child(1) .fee']) {
    assert.doesNotMatch((await call('cor_inspect', { selector: sel })).text, /\(title\) →/, sel);
  }
  // the reason is the page's own, not a later count's
  assert.match((await call('cor_inspect', { selector: '.a .tile:nth-child(2) .cost', detail: true })).text, /the element is not the only one of its kind inside its item/);
});

// ── run b14ddae4 follow-ups ──
for (const [fw, of] of [
  ['playwright', /^ {2}faqItemQuestionOf = \(item\) => item\.locator\('p\.faq-item__question'\);$/m],
  ['cypress', /^ {2}faqItemQuestionOf = \(item\) => cy\.wrap\(item\)\.find\('p\.faq-item__question'\);$/m],
  ['webdriverio', /^ {2}faqItemQuestionOf = \(item\) => item\.\$\('p\.faq-item__question'\);$/m],
]) {
  test(`P3 the every-item loop comes with the element inside each item (${fw}), under the entry's id`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/faq` });
    const out = (await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__question' })).text;
    assert.match(out, of, out);
    const id = /cor:([0-9a-f]{6}) · faqItemQuestion\n/.exec(out)[1];
    assert.match(out, new RegExp(`// COR cor:${id} · faqItemQuestionOf$`, 'm'));
    assert.match(out, /^every item: faqItems\(\) — .*; faqItemQuestionOf\(item\) is this element inside each\.$/m);
  });
}

test('P3 no per-item form when it could reach another element: a control\'s CSS leaf (Cypress), or an item\'s name', async (t) => {
  const { call } = await connect(t, 'cypress');
  await call('cor_open', { url: `${base}/p3a-either` });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.grid .plan:nth-child(2) button' })).text, /Of = /);
  await call('cor_open', { url: `${base}/p3-card-price` });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.card:nth-child(2) h3' })).text, /Of = /);
});

for (const [fw, name] of [
  ['playwright', /^ {2}cardName = \(title\) => this\.page\.locator\('div\.card'\)\.filter\(.*\)\.locator\('h3\.card__title, label'\)\.getByText\(title, \{ exact: true \}\);$/m],
  ['cypress', /^ {2}cardName = \(title\) => card\(title\)\.contains\('h3\.card__title, label', new RegExp/m],
  ['webdriverio', /^ {2}cardName = \(title\) => card\(title\)\.\$\$\('h3\.card__title, label'\)\.find\(async \(el\) => \(await el\.getText\(\)\) === title\);$/m],
]) {
  test(`P3 an item's name is one member whichever element holds it — an h3 on one card, a toggle label on another (${fw})`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-card-price` });
    for (const sel of ['.card:nth-child(2) h3', 'label[for=t1]']) {
      const out = (await call('cor_inspect', { selector: sel })).text;
      assert.match(out, /^✓ cardName\(title\) → .* — 4\/4 items checked$/m, out); // Team, Team Ultimate, Volume, Team Pro
      assert.match(out, name, out);
    }
    // a price still gets its own leaf (a slot of prices names nothing)
    assert.match((await call('cor_inspect', { selector: '.card:nth-child(2) .card__price' })).text, /^✓ cardPrice\(title\)/m);
  });
}

for (const [fw, body] of [
  ['playwright', /return this\.page\.locator\(`xpath=\$\{row\}\/\*\[\$\{columnNo\}\]\/\/img`\);/],
  ['cypress', /^ {2}const cellImg = \(featureList, column\) => \{[\s\S]*const inner = 'img';[\s\S]*\.children\(\)\.eq\(i\)\.find\(inner\)\);/m],
  ['webdriverio', /^ {2}const cellImg = \(featureList, column\) => \{[\s\S]*const inner = "\/\/img";\n {4}return \$\(`\$\{row\}\/\*\[\$\{columnNo\}\]\$\{inner\}`\);/m],
]) {
  test(`P3 an image that is a cell's content has a ref of its own and a cell template that reaches it (${fw})`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-cell-image` });
    const row = (await call('cor_snapshot', { within: 'Bug Capture' })).text;
    const ref = /cell "Team Ultimate" \[ref=e\d+\]: img "Feature included" \[ref=(e\d+)\]/.exec(row)?.[1];
    assert.ok(ref, row);
    assert.match(row, new RegExp(`^${ref} → cellAtImg — 6/6 items checked$`, 'm'), 'its entry comes with the row');
    const out = (await call('cor_inspect', { ref })).text;
    assert.match(out, /^✓ cellAtImg\(featureList, column\) → .* — 6\/6 items checked$/m, out); // cells without an image find none
    assert.match(out, body, out);
  });
}

test('P3 a cell image template is scoped to the shown table when a hidden copy holds more images in another row (live BrowserStack)', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-cell-image-copies` });
  const out = (await call('cor_inspect', { selector: 'div[data-product="live"] tr:nth-child(2) td:nth-child(3) img' })).text;
  assert.match(out, /^✓ cellAtImg\(featureList, column\) → /m, out);
  assert.match(out, /const tables = "\/\/div\[@data-product='live'\]\/\/table/, out);
});

test('P3 (WebdriverIO live cells) a selector constant may pass 120 characters; logic lines and interpolated strings may not', async () => {
  const { withinBar } = await import('../src/idioms/shared.js');
  const long = '//div[@data-plan-type=\'teams\']//table[contains(concat(\' \', normalize-space(@class), \' \'), \' comparison-table__table \')]';
  assert.equal(withinBar(['const cell = () => {', `  const tables = "${long}";`, '};']), true, 'a selector constant');
  assert.equal(withinBar(['const cell = () => {', `  return $("${long}");`, '};']), false, 'a call is logic');
  assert.equal(withinBar(['const cell = () => {', `  const row = \`\${tables}${long}\`;`, '};']), false, 'an interpolated string is logic');
  assert.equal(withinBar(Array.from({ length: 9 }, () => 'x')), false, 'still at most 8 lines');
});

// ── run f1380230 follow-ups ──
test('P3 a section named by its header text is a region — in the index, and for within; a long run of table rows is one index line', async (t) => {
  const { call } = await connect(t);
  const opened = (await call('cor_open', { url: `${base}/p3-index` })).text;
  assert.match(opened, /\(index\)/, 'the page is large enough for the index');
  assert.match(opened, /^- section "Have questions about our plans & pricing\?" \(\d+\): clickable "Question number 0\?"/m, opened);
  assert.match(opened, /^- 30 table rows \(30 controls\): "Feature 0", "Feature 1", .* — cor_snapshot within a row's name for its cells$/m, opened);
  const faq = (await call('cor_snapshot', { within: 'Have questions about our plans & pricing?' })).text;
  assert.match(faq, /section "Have questions about our plans & pricing\?" in full/, faq);
});

test('P3 a bare text element that is its wrapper\'s only child gets the wrapper\'s template (an answer holding a link)', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-index` });
  const withLink = (await call('cor_inspect', { selector: '.faq-item__a p' })).text;
  const plain = (await call('cor_inspect', { selector: '.faq-item:nth-child(3) .faq-item__a' })).text;
  for (const out of [withLink, plain]) assert.match(out, /^ {2}faqItemA = \(\w+\) => .*\.locator\('div\.faq-item__a'\);$/m, out);
});

test('P3 a ref passed as target is used as a ref', async (t) => {
  const { call } = await connect(t);
  const opened = (await call('cor_open', { url: `${base}/p8a-start` })).text;
  const ref = /link "Next page" \[ref=(e\d+)\]/.exec(opened)[1];
  const out = (await call('cor_click', { target: ref })).text;
  assert.match(out, /^Clicked e\d+\. Now at .*\/p8a-next/m, out);
});

test('P3 a navigation through an interim page with no headings still lists the destination\'s headings', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p8a-start` });
  const out = (await call('cor_click', { target: 'a[href="/p3-interim"]' })).text;
  assert.match(out, /^ {2}h1 "Next" \[ref=e\d+\]$/m, out);
});

// ── Cypress cells on BrowserStack ──
test('P3 Cypress cells where the names sit inside their cells: found by the holder element, then .closest() the cell', async (t) => {
  const { call } = await connect(t, 'cypress');
  await call('cor_open', { url: `${base}/p3-cell-holder` });
  const out = (await call('cor_inspect', { selector: 'div[data-plan-type="teams"] tr:nth-child(2) td:nth-child(4)' })).text;
  assert.match(out, /^✓ cellAt\(featureList, column\) → /m, out);
  assert.match(out, /const header = '.*th, .*th label\.toggle-label, .*th h3\.col-title';/, 'the plain header, the label and the h3');
  assert.match(out, /const key = '.*tr > :nth-child\(1\) span\.feature-name';/);
  assert.match(out, /return cy\.contains\(header, is\(column\)\)\.closest\('th'\)\.invoke\('index'\)/);
});

test('P3 a cell template is scoped when any checked combination is ambiguous, not only the target\'s own', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p3-cell-holder` });
  // Geolocation Testing × Volume is unique page-wide; Bug Capture × Volume is not (the hidden copy has that row)
  const out = (await call('cor_inspect', { selector: 'div[data-plan-type="teams"] tr:nth-child(3) td:nth-child(4)' })).text;
  assert.match(out, /^✓ cellAt\(featureList, column\) → /m, out);
  assert.match(out, /const tables = "\/\/div\[@data-plan-type='teams'\]/, out);
});

// ── runs 92a3c7e6 (CY) / 8cf9312a (WDIO) ──
for (const [fw, name] of [
  ['playwright', /^ {2}cardName = \(title\) => this\.page\.locator\('div\.card'\)\.filter\(.*\)\.locator\('h3\.card__title, label'\)\.getByText\(title, \{ exact: true \}\);$/m],
  ['cypress', /^ {2}cardName = \(title\) => card\(title\)\.contains\('h3\.card__title, label', new RegExp/m],
  ['webdriverio', /^ {2}cardName = \(title\) => card\(title\)\.\$\$\('h3\.card__title, label'\)\.find\(async \(el\) => \(await el\.getText\(\)\) === title\);$/m],
]) {
  test(`P3 an entry on an item named by either of two elements carries the item's name member (${fw})`, async (t) => {
    const { call } = await connect(t, fw);
    await call('cor_open', { url: `${base}/p3-card-price` });
    const out = (await call('cor_inspect', { selector: '.card:nth-child(2) .card__price' })).text;
    assert.match(out, name, out);
    const id = /cor:([0-9a-f]{6}) · cardPrice\n/.exec(out)[1];
    assert.match(out, new RegExp(`// COR cor:${id} · cardName$`, 'm'), 'under the entry\'s id');
  });
}

test('P3 no name member for an item named one way (a heading only), nor twice when the entry is the name', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/faq` });
  assert.doesNotMatch((await call('cor_inspect', { selector: '.faq-item:nth-child(2) .faq-item__answer' })).text, /Name = /);
  await call('cor_open', { url: `${base}/p3-card-price` });
  assert.equal((await call('cor_inspect', { selector: '.card:nth-child(2) h3' })).text.match(/cardName = /g).length, 1);
});

test('P3 cor_grade takes locator as well as selector (cor_heal\'s name for it)', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${base}/p8a-start` });
  assert.match((await call('cor_grade', { locator: "page.getByRole('heading', { name: 'Start' })" })).text, /1 match/);
});

test('P3 cor_check on a module helper placed without its id names the line to add, from the member that calls it', async (t) => {
  const { dir, call } = await connect(t, 'cypress');
  await call('cor_open', { url: `${base}/p3-card-price` });
  const out = (await call('cor_inspect', { selector: '.card:nth-child(2) .card__price' })).text;
  const id = /cor:([0-9a-f]{6}) · cardPrice\n/.exec(out)[1];
  writeFileSync(join(dir, 'pricing.page.js'), [
    "const card = (title) =>",
    "  cy.get('div.card').contains('h3.card__title, label', new RegExp(`^\\\\s*${Cypress._.escapeRegExp(title)}\\\\s*$`)).closest('div.card');",
    'export class PricingPage {',
    `  // COR cor:${id} · cardPrice`,
    "  cardPrice = (title) => card(title).find('p.card__price').filter(':visible');",
    '}',
  ].join('\n'));
  const check = (await call('cor_check', { files: ['pricing.page.js'] })).text;
  assert.match(check, new RegExp(`This is the helper of cardPrice \\(cor:${id}\\): add this line above it — no other change:\\n {4}// COR cor:${id} · cardPrice · helper, once per file \\(module scope\\)`), check);
});
