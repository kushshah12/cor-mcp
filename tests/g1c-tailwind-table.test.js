// G1c (gold locators, docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8), mode "Tables": on a Tailwind page
// shadcn-admin's row template was keyed by utility classes — `tr.border-b:has(> td)` filtered by `div.ps-3` (users) or
// `div.w-\[80px\]` (tasks). Utilities style an element, they do not name it: a restyle breaks the template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, baseUrl } from './helpers/mcp-site.js';

const rowEntry = async (t) => {
  const { call } = await connect(t);
  await call('cor_open', { url: `${baseUrl()}/g1c-tailwind-table` });
  const reply = await call('cor_inspect', { selector: 'tr:nth-child(2) button:has(.sr-only)' });
  return { reply, code: reply.split('\n').filter((l) => / = \(/.test(l)).join('\n') };
};

test('G1c Tailwind table: the row template names rows and cells without utility classes, and still checks every row', async (t) => {
  const { reply, code } = await rowEntry(t);
  assert.match(reply, /3\/3 items checked/, reply);
  assert.doesNotMatch(code, /border-b|transition-colors|ps-3|\.p-2|w-fit/, reply);
  assert.match(code, /getByRole\('button', \{ name: 'Open menu'/, reply);
});

test('G1c Tailwind table: a max-/min- size (shadcn\'s `max-w-36 ps-3` username cell) and a group/ marker (`tr.group/row`) name nothing either', async (t) => {
  const { reply, code } = await rowEntry(t);
  assert.doesNotMatch(code, /max-w-36|group\\\\\/row/, reply);
});
