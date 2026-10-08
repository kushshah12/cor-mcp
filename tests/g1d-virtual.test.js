// G1d (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8, gate 1): class page for the mode
// "Virtual or lazy lists" — g1d-virtual.html windows 500 users into 14 recycled row elements, so the n-th row element
// holds another user after a scroll. Measurement first: a COR defect is a `todo` naming the mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl, connect, members } from './helpers/mcp-site.js';
import { bannedIn } from '../src/positional.js';

const TEMPLATE = "page.locator('div.row').filter({ has: page.locator('span.row__name').getByText(name, { exact: true }) }).getByRole('button', { name: 'Open', exact: true })";
const row = (name) => `.row:has(.row__name:text-is("${name}")) .row__open`;
const open = async (t) => {
  const run = await connect(t);
  await run.call('cor_open', { url: `${baseUrl()}/g1d-virtual` });
  return run;
};
const jump = async (call, n) => {
  await call('cor_fill', { target: '#jump', value: String(n) });
  return call('cor_click', { target: '#go' });
};

test('G1d virtual list: a row\'s button gets a name template, each rendered value checked, never the row\'s slot', async (t) => {
  const { call } = await open(t);
  const reply = await call('cor_inspect', { selector: row('User 003'), detail: true });
  assert.match(reply, /Recommended — parameterised: 14 items share this shape; every value checked, each finds exactly its own item \(14\/14\)\./);
  assert.ok(reply.includes(`  ${TEMPLATE}\n`), 'the template is the top entry');
  assert.match(reply, /Declined as the answer/, 'the slot locator (nth-of-type) is declined, not issued');
  for (const line of members(reply)) assert.equal(bannedIn(line, 'playwright'), null, line);
});

test('G1d virtual list recycles rows: after a scroll the same template finds the newly shown user and a scrolled-away one finds 0, never another row', async (t) => {
  const { call } = await open(t);
  const before = await call('cor_inspect', { selector: row('User 003'), detail: true });
  const scrolled = await jump(call, 250);
  assert.match(scrolled, /~ "User 003" → "User 250"/, 'the reply shows the recycled row');
  const after = await call('cor_inspect', { selector: row('User 251'), detail: true });
  assert.ok(after.includes(`  ${TEMPLATE}\n`), 'the same template after the scroll');
  assert.equal(members(after).find((l) => l.startsWith('open =')), members(before).find((l) => l.startsWith('open =')));
  const graded = await call('cor_grade', { selector: TEMPLATE, param: 'name', values: ['User 251', 'User 003'] });
  assert.match(graded, /"User 251": ✓ 1 match\n  "User 003": ✗ 0 matches/, 'a scrolled-away user is gone, never another row');
  await call('cor_click', { target: row('User 251') });
  assert.match(await call('cor_grade', { selector: "page.getByText('Opened User 251', { exact: true })" }), /^Healthy/, 'the click opened that user');
});

test('G1d virtual list: COR says the list is windowed — "Every item" covers 14 rendered rows of 500', { todo: 'G1d: virtual or lazy lists — "Every item (14 now)" loops only the rendered rows of a 500-row windowed list, with no word that the list is virtual or how to reach the rest' }, async (t) => {
  const { call } = await open(t);
  const reply = await call('cor_inspect', { selector: row('User 003'), detail: true });
  assert.match(reply, /\b(?:virtual|windowed) list|\bof 500\b|only the rendered/i);
});

test('G1d virtual list: an act\'s own outcome is listed ahead of the rows it recycled', { todo: 'G1d: virtual or lazy lists — clicking a row scrolls the list into view; the 28 recycled-row text changes fill the reply and "Opened User 251" is cut off ("…and 21 more")' }, async (t) => {
  const { call } = await open(t);
  await jump(call, 250);
  assert.match(await call('cor_click', { target: row('User 251') }), /"Opened User 251"/);
});
