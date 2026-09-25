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
  for (const s of ["page.getByRole('button').first()", 'page.getByRole(role)', "driver.findElement(By.id('x'))", 'cy.get(`#row-${id}`)']) {
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
