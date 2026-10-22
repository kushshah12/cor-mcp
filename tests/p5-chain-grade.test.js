// P5 remainder (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md): cor_grade reads Cypress and WebdriverIO
// chains — the traversal steps and the .filter / .find callbacks COR's own entries use — and counts them as the Playwright
// chain they stand for. Before, any chain past cy.get(a).find(b) or $(a) was refused, so a locator an agent built on a COR
// member could not be graded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { parseGradable } from '../src/grade-parse.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p5c-'));
after(() => rmSync(root, { recursive: true, force: true }));
const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`../scripts/conformance/fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, dep) {
  const dir = join(root, Math.random().toString(16).slice(2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { [dep]: '1' } }));
  const session = createSession({ headless: true, cwd: dir });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
  await call('cor_open', { url: `${base}/p3-card-price` });
  return call;
}

test('P5 Cypress chains are counted step by step: closest/find to one element, :visible filter, a picked .eq() flagged', async (t) => {
  const grade = await connect(t, 'cypress');
  assert.match(await grade('cor_grade', { selector: "cy.contains('h3', /^Team Ultimate$/).closest('div.card').find('button')" }), /1 match/);
  assert.match(await grade('cor_grade', { selector: "cy.get('div.card').find('.card__price').filter(':visible')" }), /matches 2/, 'Team (shown price) and Team Ultimate; Volume has none');
  assert.match(await grade('cor_grade', { selector: "cy.get('div.card').eq(1).find('button')" }), /position/i);
  assert.match(await grade('cor_grade', { selector: "cy.get('div.card').find('button').click()" }), /action or an assertion/);
});

test('P5 WebdriverIO chains: COR\'s own .find / .filter callbacks are read; .$ inside an item; a first-of-several pick is flagged', async (t) => {
  const grade = await connect(t, '@wdio/cli');
  // COR's either-slot name form, then a step inside the item: one element
  assert.match(await grade('cor_grade', { selector: "$$('div.card').find(async (el) => (await el.$('h3.card__title=Team Ultimate').isExisting()) || (await el.$('label=Team Ultimate').isExisting())).$('.card__price')" }), /1 match/);
  // shown cards: three — .find takes the first, which is a pick by position
  assert.match(await grade('cor_grade', { selector: "$$('div.card').find((el) => el.isDisplayed())" }), /position/i);
  // $(a).$(b) where a matches three cards: WebdriverIO would act on the first card; counted as all three
  assert.match(await grade('cor_grade', { selector: "$('div.card').$('button')" }), /3 matches|matches 3/);
  assert.match(await grade('cor_grade', { selector: "$$('.card__price').filter(async (el) => (await el.getText()) === '$375 / month')" }), /2 matches|matches 2/, 'the sticky bar repeats the price');
  assert.match(await grade('cor_grade', { selector: "$$('.card__price').filter((el) => el.isDisplayed())" }), /matches 3/, 'four prices, the Team Pro one hidden');
});

test('P5 a callback COR does not read, or a step that is not a locator, is refused with what to do', () => {
  assert.throws(() => parseGradable("$$('div.card').find((el) => el.getAttribute('x') > 3)"), /callback is not one COR reads/);
  assert.throws(() => parseGradable("cy.get('a').should('be.visible')"), /action or an assertion/);
  assert.throws(() => parseGradable("$('a').click()"), /action or an assertion/);
});
