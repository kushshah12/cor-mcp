// P4 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md) — reply diet: the default cor_inspect reply is the
// answer and its code; detail: true gives the rest; one comment format naming the member; smaller entry budgets; short
// instructions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, INSTRUCTIONS } from '../src/server.js';
import { createSession } from '../src/session.js';
import { ACT_ENTRIES } from '../src/tools/session-tools.js';
import { compactEntries } from '../src/tools/inspect.js';

const site = createHttpServer((req, res) => {
  let body;
  try { body = readFileSync(new URL(`./fixtures/${req.url.slice(1).split('?')[0]}.html`, import.meta.url)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
let base;
before(() => new Promise((r) => site.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${site.address().port}`; r(); })));
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t) {
  const session = createSession({ headless: true, cwd: new URL('./golden/projects/empty/', import.meta.url).pathname });
  t.after(() => session.close());
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(() => client.close());
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');
}
const refOf = (text, re) => re.exec(text)?.[1];

test('P4 the default cor_inspect reply is the answer and its code — a status line with the proof, the comment, the code', async (t) => {
  const call = await connect(t);
  const opened = await call('cor_open', { url: `${base}/cards` });
  const lonely = await call('cor_inspect', { ref: refOf(opened, /button "Lonely" \[ref=(e\d+)\]/) });
  assert.deepEqual(lonely.split('\n').map((l) => l.replace(/cor:[0-9a-f]{6}/, 'cor:{id}')), [
    "✓ lonelyButton → tests/pages/cards.page.js — 79 Good · 1 match",
    '  // COR cor:{id} · lonelyButton',
    "  lonelyButton = () => this.page.getByRole('button', { name: 'Lonely' });",
  ]);
  const full = await call('cor_inspect', { ref: refOf(opened, /button "Lonely" \[ref=(e\d+)\]/), detail: true });
  assert.match(full, /^Best locator \(playwright\):/m);
  assert.match(full, /^Durable — /m, 'detail: true gives the full reply');
  assert.ok(full.length > lonely.length * 3, `${full.length} vs ${lonely.length}`);
});

test('P4 notes ride along: the every-item loop for a template; a declined element\'s fix', async (t) => {
  const call = await connect(t);
  const opened = await call('cor_open', { url: `${base}/cards` });
  const choose = await call('cor_inspect', { ref: refOf(opened, /button "Choose" \[ref=(e\d+)\] in "Team"/) });
  assert.match(choose, /^✓ choose\(value\) → tests\/pages\/cards\.page\.js — 2\/2 items checked$/m);
  assert.match(choose, /^every item: page\.locator\('div\.card'\) — loop over it/m);
  assert.ok(choose.split('\n').length <= 6, choose);
  await call('cor_open', { url: `${base}/p1-no-durable` });
  const declined = await call('cor_inspect', { selector: '.list > div:nth-child(2) .dot' });
  assert.match(declined, /^✗ element — declined: no durable locator/);
  assert.match(declined, /^fix: add a test attribute — <span data-testid=/m);
});

test('P4 a helper that reaches only the item is named for the item and says so (Cypress)', async (t) => {
  const call = await connect(t);
  const opened = await call('cor_open', { url: `${base}/cards` });
  const out = await call('cor_inspect', { ref: refOf(opened, /button "Choose" \[ref=(e\d+)\] in "Team"/), framework: 'cypress' });
  assert.match(out, /^✓ card\(value\) → /);
  assert.match(out, /^ {2}card = \(value\) => card\(value\);$/m);
  assert.match(out, /^note: card\(…\) finds the item, not the element you inspected/m);
  assert.match(out, /^every item: cy\.get\('div\.card'\) — loop over it/m, 'the helper\'s every-item form');
});

test('P4 one comment format: // COR cor:<id> · <member> — no grade or count in it', async (t) => {
  const call = await connect(t);
  const opened = await call('cor_open', { url: `${base}/cards` });
  const out = await call('cor_inspect', { targets: [refOf(opened, /radio "Team" \[ref=(e\d+)\]/), refOf(opened, /button "Lonely" \[ref=(e\d+)\]/)] });
  for (const line of out.split('\n').filter((l) => l.includes('// COR cor:'))) {
    assert.match(line, /^ {2}\/\/ COR cor:[0-9a-f]{6} · \w+(?: · label — .*)?$/, line);
    assert.doesNotMatch(line.split(' · label')[0], /checked|match|Good|Fair|Excellent/, line);
  }
});

test('P4 an act reply carries at most 4 entries; the rest are refs to ask for with cor_inspect targets', async () => {
  assert.equal(ACT_ENTRIES, 4);
  const info = (n) => ({ member: `m${n}`, file: 'f.js', proof: '79 Good · 1 match', comment: `  // COR cor:00000${n} · m${n}`, body: `  m${n} = () => x${n};`, lines: [] });
  const inspector = async ({ ref }) => ({ info: info(Number(ref.slice(1))), declined: null });
  const out = await compactEntries(inspector, [1, 2, 3, 4, 5, 6].map((n) => ({ label: `e${n}`, args: { ref: `e${n}` } })), { max: ACT_ENTRIES });
  assert.equal(out.filter((l) => / → m\d/.test(l)).length, 4);
  assert.equal(out.at(-1), '… 2 more: cor_inspect targets: ["e5", "e6"]');
});

test('P4 the instructions are a short workflow, under 2k characters', () => {
  assert.ok(INSTRUCTIONS.length < 2000, `${INSTRUCTIONS.length} characters`);
  assert.match(INSTRUCTIONS, /cor_inspect targets: \[refs\]/);
  assert.match(INSTRUCTIONS, /A · label member is what you click for a hidden input/);
});
