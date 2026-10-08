// G1d (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8, gate 1): class page for the mode
// "Modals, portals, menus" — g1d-modal.html mounts a dialog and a menu at the end of <body> on open and rebuilds them on
// every open. Measurement first: a COR defect is a `todo` naming the mode, fixed later by failure mode (two-site rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, connect, entry, members } from './helpers/mcp-site.js';
import { bannedIn } from '../src/positional.js';

const noPositional = (reply) => {
  const code = members(reply);
  assert.ok(code.length, 'the reply has entries');
  for (const line of code) assert.equal(bannedIn(line, 'playwright'), null, line);
};
const open = async (t, opts) => {
  const run = await connect(t, '@playwright/test', opts);
  run.opened = await run.call('cor_open', { url: `${baseUrl()}/g1d-modal` });
  return run;
};

test('G1d modal: the dialog exists only after its act; the act lists its controls with one-match, non-positional entries', async (t) => {
  const { call, opened } = await open(t);
  assert.doesNotMatch(opened, /Delete project|dialog/, 'nothing of the portal before the act');
  const reply = await call('cor_click', { target: '.project:nth-of-type(2) .project__delete' });
  assert.match(reply, /\+ dialog "Delete Beta\?": button "Cancel" \[ref=e\d+\], button "Delete project" \[ref=e\d+\]/);
  assert.match(reply, /deleteProjectButton = \(\) => this\.page\.getByRole\('button', \{ name: 'Delete project' \}\);/);
  assert.match(reply, /deleteBetaHeading = \(\) => this\.page\.getByRole\('heading', \{ name: 'Delete Beta\?' \}\);/);
  noPositional(reply);
  const ok = await call('cor_inspect', { selector: '.dialog__ok' });
  assert.match(ok, /deleteProjectButton .*· 1 match\n.*\n  deleteProjectButton = \(\) => this\.page\.getByRole\('button', \{ name: 'Delete project' \}\);/);
  noPositional(ok);
});

test('G1d modal: each card\'s trigger is a per-project template with exact names — "Delete" never also finds the open dialog\'s "Delete project"', async (t) => {
  const { call } = await open(t);
  await call('cor_click', { target: '.project:nth-of-type(2) .project__delete' });
  const reply = await call('cor_inspect', { selector: '.project:nth-of-type(2) .project__delete' });
  assert.match(reply, /delete = \(title\) => this\.page\.locator\('section\.project'\)\.filter\(\{ has: this\.page\.getByRole\('heading', \{ name: title, exact: true \}\) \}\)\.getByRole\('button', \{ name: 'Delete', exact: true \}\);/);
  assert.match(reply, /2\/2 items checked/);
  noPositional(reply);
  const graded = await call('cor_grade', { selector: "page.locator('section.project').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: 'Delete', exact: true })", param: 'title', values: ['Alpha', 'Beta'] });
  assert.match(graded, /"Alpha": ✓ 1 match\n  "Beta": ✓ 1 match\nWorks for 2 of 2 values\./);
});

test('G1d portal rebuilt on every open: the entry from the first open finds 0 while closed and exactly one after reopening on another card', async (t) => {
  const { call } = await open(t);
  await call('cor_click', { target: '.project:nth-of-type(2) .project__delete' });
  const selector = "page.getByRole('button', { name: 'Delete project' })";
  assert.match(await call('cor_grade', { selector }), /^Healthy — resolves to exactly one element/);
  const closed = await call('cor_click', { target: '.dialog__cancel' });
  assert.match(closed, /gone \(\d+\):.*button "Delete project"/, 'the close is reported');
  assert.match(await call('cor_grade', { selector }), /^Broken — matches no element on this page/);
  await call('cor_click', { target: '.project:nth-of-type(1) .project__delete' });
  assert.match(await call('cor_grade', { selector }), /^Healthy — resolves to exactly one element/);
  assert.match(await call('cor_click', { target: '.dialog__ok' }), /"Alpha deleted"/, 'the act lands on the rebuilt portal');
});

test('G1d menu: items reachable after "More", one match each, and the same entry holds on the other card\'s rebuilt menu', async (t) => {
  const { call } = await open(t);
  const reply = await call('cor_click', { target: '.project:nth-of-type(1) .project__more' });
  for (const name of ['Rename', 'Duplicate', 'Archive']) {
    assert.match(reply, new RegExp(`${name.toLowerCase()} = \\(\\) => this\\.page\\.getByRole\\('menuitem', \\{ name: '${name}' \\}\\);`));
  }
  noPositional(reply);
  await call('cor_press', { key: 'Escape' });
  await call('cor_click', { target: '.project:nth-of-type(2) .project__more' });
  assert.match(await call('cor_grade', { selector: "page.getByRole('menuitem', { name: 'Archive' })" }), /^Healthy — resolves to exactly one element/);
  assert.match(await call('cor_click', { target: '[role=menuitem]:text-is("Archive")' }), /"Archive Beta"/);
});

test('G1d portal records: cor_check verifies the dialog button through its replayed open', async (t) => {
  const { call, dir } = await open(t, { records: true });
  await call('cor_click', { target: '.project:nth-of-type(2) .project__delete' });
  writeFileSync(join(dir, 'p.spec.js'), `${entry(await call('cor_inspect', { selector: '.dialog__ok' }))}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});

test('G1d portal records: a menu reached after closing a dialog with Escape (a press with no target) is verified', async (t) => {
  const { call, dir } = await open(t, { records: true });
  await call('cor_click', { target: '.project:nth-of-type(2) .project__delete' });
  await call('cor_press', { key: 'Escape' });
  await call('cor_click', { target: '.project:nth-of-type(1) .project__more' });
  writeFileSync(join(dir, 'p.spec.js'), `${entry(await call('cor_inspect', { selector: '[role=menuitem]:text-is("Archive")' }))}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});

// G2 (state replay): shadcn-admin's row menu opened with Enter — the replay filled the trigger's card template with the
// key ("Enter") instead of the card, found nothing, and called the menu entries "state not reached".
test('G2 portal records: a menu opened by pressing Enter on one card\'s trigger is verified — the key is not the item', async (t) => {
  const { call, dir } = await open(t, { records: true });
  await call('cor_press', { key: 'Enter', target: '.project:nth-of-type(2) .project__more' });
  writeFileSync(join(dir, 'p.spec.js'), `${entry(await call('cor_inspect', { selector: '[role=menuitem]:text-is("Archive")' }))}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});
