import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { parseGradable } from '../src/grade-parse.js';
import { expandGroups } from './helpers/outline.js';

let base;
const site = createHttpServer((req, res) => {
  let html;
  try {
    html = readFileSync(new URL(`./fixtures/${req.url.slice(1)}`, import.meta.url));
  } catch {
    res.writeHead(404); // e.g. the browser's own /favicon.ico request
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
const session = createSession({ headless: true });
let client;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
});
after(async () => {
  await client.close();
  await session.close();
  site.close();
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: expandGroups(result.content.map((c) => c.text).join('\n')) };
}
const open = (page) => call('cor_open', { url: `${base}/${page}` });
const grade = (selector, framework) => call('cor_grade', framework ? { selector, framework } : { selector });
const verdict = (out) => out.text.split('\n')[0];

test('AE4: a build-generated class reports its risk, its match count and a more durable alternative', async () => {
  await open('traps.html');
  const out = await grade('.css-1x7f2k');
  assert.match(verdict(out), /^Resolves to exactly one element, but fragile \(Risky\): styled-components\/emotion generated class names/);
  assert.match(out.text, /Point-in-time — true on this page now: 40 Risky · 1 match/);
  assert.match(out.text, /More durable alternative for the same element \(playwright\):\n\s+page\.getByRole\('button', \{ name: 'Continue' \}\)\n\s+79 Good · 1 match/);
});

test('a selector matching nothing reports zero matches as Broken, without throwing', async () => {
  await open('traps.html');
  const out = await grade('#nope');
  assert.equal(out.isError, false);
  assert.match(verdict(out), /^Broken — matches no element/);
  assert.match(out.text, /· 0 matches/);
  assert.match(out.text, /rates how durable the string is; whether it resolves is the verdict above/);
  // "matches no elements" is a fact about this page now, not about the string.
  assert.equal(out.text.split('\n').find((l) => l.startsWith('// COR:')), '// COR: anchored on a stable, human-named id; no known risk');
});

test('a selector matching several reports the count and is marked unusable', async () => {
  await open('traps.html');
  const out = await grade('button.rm');
  assert.match(verdict(out), /^Ambiguous — matches 3 elements, so it is not usable as written/);
  assert.match(out.text, /· 3 matches/);
  assert.doesNotMatch(out.text, /alternative/i, 'which element was meant is unknown, so nothing is offered for it');
});

test('an already-optimal selector says nothing scores higher and is not presented as needing replacement', async () => {
  await open('traps.html');
  const out = await grade("page.getByTestId('place-order')");
  assert.match(verdict(out), /^Healthy/);
  assert.match(out.text, /No generated candidate scores higher\./);
  assert.doesNotMatch(out.text, /alternative|replace it|Recommendation/i);
});

test('the three repair cases read differently: broken, ambiguous, healthy', async () => {
  await open('traps.html');
  const verdicts = await Promise.all(['#nope', 'button.rm', '#cart'].map(async (s) => verdict(await grade(s))));
  assert.deepEqual(verdicts.map((v) => v.split(' ')[0]), ['Broken', 'Ambiguous', 'Healthy']);
});

test('AE8: a healthy selector ends the repair and offers no replacement', async () => {
  await open('traps.html');
  const out = await grade("page.getByRole('button', { name: 'Place order' })");
  assert.match(verdict(out), /^Healthy — resolves to exactly one element\. If a test using it failed, the cause is in the product or the assertion, not this locator\. Stop repairing the locator\./);
  // A higher score exists (the test id, 99) — it must not be offered as a fix.
  assert.doesNotMatch(out.text, /getByTestId/);
  assert.doesNotMatch(out.text, /alternative|Recommendation|change the application/i);
  assert.match(out.text, /Not a repair case: the locator works\. A higher-scoring form exists/);
});

test('the tool description makes the agent grade before re-identifying and names Healthy as a stop', async () => {
  const { tools } = await client.listTools();
  const { description } = tools.find((t) => t.name === 'cor_grade');
  assert.match(description, /When a test fails on a locator, call this FIRST, before re-identifying the element/);
  assert.match(description, /If it reports Healthy, STOP/);
});

test('an XPath is graded like a CSS selector', async () => {
  await open('traps.html');
  const out = await grade("//header//a[@href='/terms']");
  assert.match(verdict(out), /^Healthy/);
  assert.match(out.text, /· 1 match\n/);
  assert.match(await grade("//main//a[@href='/terms']").then(verdict), /^Broken/, 'the link is in <header>, not <main>');
});

test('AE11: a Playwright getByRole lifted from a test file is scored and counted with Playwright semantics', async () => {
  await open('traps.html');
  const ok = await grade("await this.page.getByRole('button', { name: 'Place order' });");
  assert.match(ok.text, /79 Good · 1 match/);
  assert.doesNotMatch(ok.text, /unknown/i);
  const many = await grade("page.getByRole('button', { name: 'Remove' })");
  assert.match(many.text, /· 3 matches/);
  const regex = await grade('page.getByText(/terms of service/i)');
  assert.match(regex.text, /· 1 match\n/);
});

test('Cypress cy.get and cy.contains are graded', async () => {
  await open('traps.html');
  const get = await grade("cy.get('[data-testid=\"apply-promo\"]')");
  assert.match(verdict(get), /^Healthy/);
  const contains = await grade("cy.contains('Continue')");
  assert.match(contains.text, /· 1 match\n/);
  assert.match(contains.text, /cy\.contains acts on the first match/);
  const scoped = await grade("cy.contains('li', 'Blue Shirt')");
  assert.match(scoped.text, /· 1 match\n/);
});

test('an unparseable expression is refused as not gradable, naming the fix, with no -1', async () => {
  await open('traps.html');
  for (const s of ["page.getByRole('button').click()", 'page.getByRole(role)', "driver.findElement(By.id('x'))", 'cy.get(`#row-${id}`)']) {
    const out = await grade(s);
    assert.equal(out.isError, true, s);
    assert.match(out.text, /^Not gradable as written: /, s);
    assert.match(out.text, /CSS selector/);
    assert.match(out.text, /cor_inspect the element by ref/);
    assert.doesNotMatch(out.text, /-1/);
  }
});

test('an uncountable selector and an unparseable one are told apart', async () => {
  await open('traps.html');
  const uncountable = await grade('custom-engine=foo');
  assert.equal(uncountable.isError, false);
  assert.match(verdict(uncountable), /^Match count unknown — the selector was understood but could not be counted/);
  assert.match(uncountable.text, /match count unknown/);
  assert.doesNotMatch(uncountable.text, /-1/);
  const unparseable = await grade('page.getByRole(role)');
  assert.equal(unparseable.isError, true);
  assert.match(unparseable.text, /^Not gradable as written/);
});

test('grade and inspect describe the same locator identically', async () => {
  await open('shapes.html');
  const inspected = await call('cor_inspect', { selector: '#email' });
  const graded = await grade("page.getByRole('textbox', { name: 'Email' })");
  const pit = (t) => t.match(/Point-in-time — true on this page now: .*/)[0];
  const line = (t) => t.split('\n').find((l) => l.startsWith('// COR:')).split('; chosen over')[0];
  assert.equal(pit(graded.text), pit(inspected.text));
  assert.equal(line(graded.text), line(inspected.text));
  assert.match(graded.text, /Durable — stays true while the locator string is unchanged/);
});

test('verification: a positional selector names the positional risk and a stable alternative', async () => {
  await open('traps.html');
  // The Apply button that carries data-testid="apply-promo", addressed by position.
  const out = await grade('main > div:nth-of-type(1) > button:nth-of-type(1)');
  assert.match(verdict(out), /fragile \((Risky|Unstable)\): depends on element position/);
  assert.match(out.text, /- Unique only by position/);
  assert.match(out.text, /More durable alternative for the same element \(playwright\):\n\s+page\.getByTestId\('apply-promo'\)/);
});

test('a fragile selector with no durable alternative recommends changing the application', async () => {
  await open('traps.html');
  // The second of two identical "Select" buttons: nothing but position tells them apart.
  const out = await grade('main > div:nth-of-type(3) > div:nth-of-type(2) > button');
  assert.match(out.text, /No durable locator exists for this element\. Recommendation: change the application\.\nAdd a test attribute \(this requires an application change\):\n\s+<button data-testid="select">/);
  assert.doesNotMatch(out.text, /More durable alternative/);
});

test('parse: receivers, await, semicolons and framework inference', () => {
  assert.equal(parseGradable("await this.page.getByText('x');").scoreValue, "page.getByText('x')");
  assert.equal(parseGradable("cy.get('.a')").framework, 'cypress');
  assert.equal(parseGradable("page.locator('#a')").scoreValue, '#a');
  assert.equal(parseGradable('xpath=//a').scoreValue, '//a');
  assert.equal(parseGradable('#a').framework, null);
});

// ── chained locators (from the BrowserStack benchmark, 2026-09-25) ──────────
// The agent composed .filter(…).getByRole(…) chains and cor_grade refused them
// ("chained calls are not graded"), so they shipped unscored.
test('a composed chain is graded: Playwright counts it; each step is scored; the weakest sets the score', async () => {
  await open('chains.html');
  const out = await grade("page.locator('div.plan-card').filter({ visible: true }).filter({ has: page.getByRole('heading', { name: 'Team Ultimate', exact: true }) }).getByRole('button', { name: /users/ })");
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /1 match/);
  assert.match(out.text, /Chain — scored by its weakest step/);
  assert.match(out.text, /1\. locator\('div\.plan-card'\) {3}\d+ \w+/);
  assert.match(out.text, /2\. filter has: getByRole\('heading', \{ name: 'Team Ultimate', exact: true \}\) {3}\d+/);
  assert.match(out.text, /3\. getByRole\('button', \{ name: \/users\/ \}\) {3}\d+/);
  assert.match(out.text, /← weakest/);
  assert.match(out.text, /! \.filter\(\{ visible: true \}\) — unique only while the other matches stay hidden/);
  const scores = [...out.text.matchAll(/^ {4}\d\. .+? {3}(\d+) /gm)].map((m) => Number(m[1]));
  const overall = Number(/Point-in-time — true on this page now: (\d+)/.exec(out.text)[1]);
  assert.equal(overall, Math.min(...scores), 'the chain\'s score is its weakest step\'s');
});

test('Playwright\'s own semantics decide the count: CSS and text steps see hidden copies, getByRole does not', async () => {
  await open('chains.html');
  // CSS + text steps count the hidden card's button too: ambiguous.
  const css = await grade("page.locator('div.plan-card').filter({ hasText: 'Team Ultimate' }).locator('button:last-child')");
  assert.equal(css.isError, false, css.text);
  assert.match(css.text, /^Ambiguous — matches 2 elements/);
  // getByRole leaves hidden elements out, so the same intent resolves to one.
  const role = await grade("page.locator('div.plan-card').filter({ has: page.getByRole('heading', { name: 'Team Ultimate', exact: true }) }).getByRole('button', { name: 'Choose' })");
  assert.match(role.text, /1 match/);
});

test('a filter by text and a nested .locator step are graded too', async () => {
  await open('chains.html');
  const out = await grade("page.locator('.faq-item').filter({ hasText: 'cancellation policy' }).locator('.faq-item__answer')");
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /1 match/);
  assert.match(out.text, /filter hasText: 'cancellation policy'/);
});

test('.first() / .nth() are graded with a position note', async () => {
  await open('chains.html');
  const out = await grade("page.locator('li').nth(1)");
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /1 match/);
  assert.match(out.text, /! \.nth\(1\) — picks by position/);
});

test('an action or a helper function in the chain is still refused, naming what it reads', async () => {
  await open('chains.html');
  const action = await grade("page.locator('li').click()");
  assert.equal(action.isError, true);
  assert.match(action.text, /\.click\(\) is not a locator step cor_grade reads/);
  const helper = await grade("planCard(page, 'Team').getByRole('button')");
  assert.equal(helper.isError, true);
  assert.match(helper.text, /planCard\(…\) is not a form cor_grade reads/);
});

test('the weakest step sets the score even when it is not the first', async () => {
  await open('chains.html');
  const out = await grade("page.locator('.faq').locator('div:nth-of-type(2) > div')");
  assert.equal(out.isError, false, out.text);
  const steps = [...out.text.matchAll(/^ {4}(\d)\. .+? {3}(\d+) .*?(← weakest)?$/gm)].map((m) => ({ n: Number(m[1]), score: Number(m[2]), weakest: Boolean(m[3]) }));
  assert.equal(steps.find((s) => s.weakest).n, 2, out.text);
  assert.ok(steps[1].score < steps[0].score);
  assert.equal(Number(/Point-in-time — true on this page now: (\d+)/.exec(out.text)[1]), steps[1].score);
});

test('a page-object locator is graded as written: this.page receivers, nested in has: too (POM reuse check)', async () => {
  await open('chains.html');
  const out = await grade("this.page.locator('div.plan-card').filter({ has: this.page.getByRole('heading', { name: 'Team Ultimate', exact: true }) }).getByRole('button', { name: 'Choose' })");
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^Healthy — resolves to exactly one element/);
  assert.match(out.text, /filter has: getByRole\('heading'/);
});

// ── U19.1: .or() / .and() chains; the short Healthy grade ───────────────────
// The owner's page-object run: the agent's first two cor_grade calls were
// refused on `.or()` — which COR's own mixed-naming template uses.
test('.or() chains grade as written — the run\'s refused planCard locator', async () => {
  await open('chains.html');
  const out = await grade("page.locator('div.plan-card').filter({ visible: true }).filter({ has: page.getByRole('heading', { name: 'Team Ultimate', exact: true }).or(page.locator('label').getByText('Team Ultimate', { exact: true })) })");
  assert.equal(out.isError, false, out.text);
  // The bare `label` branch is the weak link — what the agent found and fixed in the run.
  assert.match(out.text, /^Resolves to exactly one element, but fragile \(Risky\)/);
  assert.match(out.text, /filter has: or: locator\('label'\) {3}45 Risky .*← weakest/);
  assert.match(out.text, /! (filter has: )?\.or\(\) — matches if either branch does; the score is the weaker branch's/);
});

test('.and() chains grade as written', async () => {
  await open('chains.html');
  const out = await grade("page.getByRole('button', { name: 'Choose' }).and(page.locator('div.plan-card button'))");
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /Ambiguous — matches 2 elements|1 match/);
  assert.match(out.text, /and: locator\('div\.plan-card button'\)/);
});

test('a Healthy grade is short: no input echo, no signal list — fragile and broken keep the detail', async () => {
  await open('chains.html');
  const healthy = await grade("page.locator('.faq-item').filter({ hasText: 'cancellation policy' }).locator('.faq-item__answer')");
  assert.match(healthy.text, /^Healthy/);
  assert.doesNotMatch(healthy.text, /^Graded: /m, 'the agent already has the locator it sent');
  assert.doesNotMatch(healthy.text, /^ {2}[+-] /m, 'no per-signal lines');
  assert.match(healthy.text, /Chain — scored by its weakest step/);
  assert.match(healthy.text, /^\/\/ COR: /m, 'the durable line stays (R27)');
  const fragile = await grade("page.locator('li').nth(1)");
  assert.match(fragile.text, /^Graded: /m, 'a non-Healthy verdict keeps the full block');
});

// ── Cypress chains (Cypress run 5b3bc6b9, 2026-09-30): 2 of 3 grades refused ─
test('cy.get(a).find(b) is graded as the descendant selector; other chains still are not', async () => {
  await open('chains.html');
  const one = await grade("cy.get('div.faq-item').find('div.faq-item__answer')");
  assert.equal(one.isError, false, one.text);
  assert.match(one.text, /Ambiguous — matches 2 elements/);
  const two = await grade("cy.get('div.faq').find('div.faq-item').find('p')");
  assert.match(two.text, /Ambiguous — matches 2 elements/);
  const base = await grade("cy.get('div.faq-item').find('div.faq-item__answer')");
  assert.match(base.text, /Graded: cy\.get\('div\.faq-item'\)\.find\('div\.faq-item__answer'\)|div\.faq-item div\.faq-item__answer/);
  for (const bad of ["cy.get('div.faq-item').eq(0)", "cy.get('div.faq-item').find('p').click()", "cy.get('div.faq-item').find(p)", "cy.get('@x').find('p')"]) {
    const r = await grade(bad);
    assert.match(r.text, /^Not gradable/, bad);
  }
});
