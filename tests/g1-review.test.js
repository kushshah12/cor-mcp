// G1 review (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8): a blind SDET review of Gate 3 wave 1
// (cor-benchmark agent/blind-review) marked COR's shadcn-admin entries down where a short, unique, readable locator existed.
// Rule (user, 2026-10-12): uniqueness first; then the shortest stable locator; scope to a dialog; no long chains or XPath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, baseUrl } from './helpers/mcp-site.js';

const open = async (t) => {
  const run = await connect(t);
  await run.call('cor_open', { url: `${baseUrl()}/g1-review` });
  return run;
};
const member = (reply) => /= \(\) => (.*);$/m.exec(reply)?.[1];

test('G1 review: a toast title is found by its exact text, not //div[normalize-space()=…]', async (t) => {
  const { call } = await open(t);
  assert.equal(member(await call('cor_inspect', { selector: '[data-title]' })), "this.page.getByText('You submitted the following values:', { exact: true })");
});

test('G1 review: a field in an open dialog is scoped to the dialog — the page behind has a "Username" field too', async (t) => {
  const { call } = await open(t);
  assert.equal(member(await call('cor_inspect', { selector: '#u1' })), "this.page.getByRole('dialog').getByRole('textbox', { name: 'Username' })");
});

test('G1 review: "Password" inside "Confirm Password" gets an exact role or label, not input[name][type]', async (t) => {
  const { call } = await open(t);
  assert.match(member(await call('cor_inspect', { selector: '#p1' })), /(getByLabel\('Password'|getByRole\('textbox', \{ name: 'Password'), \{? ?exact: true \}\)$/);
});

test('G1 review: a select option mirrored in a hidden native <select> is getByRole(option, exact), not XPath', async (t) => {
  const { call } = await open(t);
  assert.match(member(await call('cor_inspect', { selector: '[role=option] >> nth=1' })), /getByRole\('option', \{ name: 'Admin', exact: true \}\)$/);
});

// G1 review (table scope): rows keyed by `tr:has(> td)` alone take in every table on the page — "5/5 items checked" and an
// every-item loop over the users AND the pending invitations. Scoped to the target's table only when another table collides.
test('G1 review: a row template is scoped to its own table when another table on the page has rows of the same shape', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${baseUrl()}/g1-review-tables` });
  const reply = await call('cor_inspect', { selector: 'table[aria-label=Users] tr:nth-child(2) button' });
  assert.match(reply, /3\/3 items checked/, reply);
  assert.match(reply, /this\.page\.locator\('table\[aria-label="Users"\] tr:has\(> td\)'\)/, reply);
});

test('G1 review: one table on the page — the row template stays unscoped', async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${baseUrl()}/g1c-tailwind-table` });
  assert.match(await call('cor_inspect', { selector: 'tr:nth-child(2) button:has(.sr-only)' }), /this\.page\.locator\('tr:has\(> td\)'\)/);
});
