// P5 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — check and grade with no extra turns: cor_grade
// reads `${param}` template literals in every framework; cor_check finds the id of a locator inside a block body.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { parseGradable, substituteParam } from '../src/grade-parse.js';
import { scanLocators } from '../src/check-scan.js';

test('P5 a template literal filled with the parameter is read: counted per value, graded on a literal copy', () => {
  const src = 'page.locator(`div.card[data-plan="${title}"] .price`)';
  assert.equal(parseGradable(src, { param: 'title' }).usesParam, true);
  assert.equal(substituteParam(src, 'title', 'Team `Pro`'), 'page.locator(`div.card[data-plan="Team \\`Pro\\`"] .price`)', 'escaped for the literal');
  assert.equal(parseGradable(substituteParam(src, 'title', 'Team Pro')).scoreValue, 'div.card[data-plan="Team Pro"] .price');
  for (const [s, fw] of [['$(`label=${plan}`)', 'webdriverio'], ['cy.get(`[data-plan="${plan}"]`)', 'cypress'], ["cy.contains('label', plan)", 'cypress']]) {
    const p = parseGradable(s, { param: 'plan' });
    assert.deepEqual([p.framework, p.usesParam], [fw, true], s);
  }
});

test('P5 without param, or with another name inside, the refusal says what to pass', () => {
  assert.throws(() => parseGradable('page.locator(`x[data-plan="${title}"]`)'), /pass param: "title" \(and values\)/);
  assert.throws(() => parseGradable('page.locator(`xpath=${row}/td`)', { param: 'title' }), /only \$\{title\} is filled in/);
});

test('P5 cor_check reads the id of a locator inside a block body — COR\'s own cell entry and Cypress cell helper', () => {
  const src = [
    'export class P {',
    '  // COR cor:abc123 · cellAt',
    '  cellAt = (order, column) => {',
    '    const tables = "//table";',
    '    return this.page.locator(`xpath=${tables}/*[${column}]`);',
    '  };',
    '  plain = () => {',
    '    return this.page.locator("#x");',
    '  };',
    '}',
    '// COR cor:def456 · cellAt · helper, once per file (module scope)',
    'const cell = (r, c) => {',
    '  const header = "th";',
    '  return cy.contains(header, r).invoke("index")',
    '    .then((i) => cy.contains("td", c).closest("tr").children().eq(i));',
    '};',
  ].join('\n');
  assert.deepEqual(scanLocators(src).map((s) => [s.line, s.id, s.helper]), [[5, 'abc123', false], [8, null, false], [14, 'def456', true]]);
});

// ── through the server ──
const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`./fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

test('P5 cor_grade grades a ${param} locator across its values in one call', async (t) => {
  const session = createSession({ headless: true, cwd: new URL('./golden/projects/empty/', import.meta.url).pathname });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
  await call('cor_open', { url: `${base}/toggles` });
  const out = await call('cor_grade', { selector: 'page.locator(`input[value="${plan}"]`)', param: 'plan', values: ['teams', 'individuals'] });
  assert.match(out, /^Across the given values \(plan\):\n {2}"teams": ✓ 1 match\n {2}"individuals": ✓ 1 match\nWorks for 2 of 2 values\./m, out);
  assert.match(out, /Durability, graded on plan = "teams":/);
});
