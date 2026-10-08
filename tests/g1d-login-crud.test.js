// G1d (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8, gate 1): class pages for the mode
// "Forms behind a login (CRUD)" — g1d-login.html stores a session in sessionStorage and goes to g1d-crud.html, which
// sends you back without one; a customer table with Edit and Delete per row, inline edit, and an add form that puts the
// new row first. Measurement first: a COR defect is a `todo` naming the mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, connect, entry, members } from './helpers/mcp-site.js';
import { bannedIn } from '../src/positional.js';

const DELETE = "page.locator('tr').filter({ has: page.locator('td').getByText(name, { exact: true }) }).getByRole('button', { name: 'Delete', exact: true })";
const row = (name, button) => `tr:has(td:text-is("${name}")) .${button}`;
const noPositional = (reply) => {
  assert.ok(members(reply).length, 'the reply has entries');
  for (const line of members(reply)) assert.equal(bannedIn(line, 'playwright'), null, line);
};
async function signIn(t, opts) {
  const run = await connect(t, '@playwright/test', opts);
  run.redirected = await run.call('cor_open', { url: `${baseUrl()}/g1d-crud` });
  await run.call('cor_fill', { target: 'input[name=email]', value: 'qa@example.com' });
  await run.call('cor_fill', { target: 'input[name=password]', value: 'secret' });
  run.landed = await run.call('cor_click', { target: 'button[type=submit]' });
  return run;
}

test('G1d login: the form\'s entries are role + name, one match each; a wrong password\'s message is reachable after the act', async (t) => {
  const { call } = await connect(t);
  const opened = await call('cor_open', { url: `${baseUrl()}/g1d-crud` });
  assert.match(opened, /Now at http:\/\/[\d.:]+\/g1d-login — "G1d login"/, 'no session: the app sends you to sign in');
  const reply = await call('cor_inspect', { targets: ['input[name=email]', 'input[name=password]', 'button[type=submit]'] });
  assert.match(reply, /emailInput = \(\) => this\.page\.getByRole\('textbox', \{ name: 'Email' \}\);/);
  assert.match(reply, /passwordInput = \(\) => this\.page\.getByRole\('textbox', \{ name: 'Password' \}\);/);
  assert.match(reply, /signInButton = \(\) => this\.page\.getByRole\('button', \{ name: 'Sign in' \}\);/);
  assert.equal(reply.match(/· 1 match/g).length, 3);
  noPositional(reply);
  await call('cor_fill', { target: 'input[name=password]', value: 'nope' });
  const failed = await call('cor_click', { target: 'button[type=submit]' });
  assert.match(failed, /\+ "Wrong email or password" \[ref=e\d+\]/);
  assert.match(failed, /err = \(\) => this\.page\.getByRole\('alert'\);/);
});

test('G1d CRUD after login: the table\'s Edit and Delete are row templates by name, every row checked, none positional', async (t) => {
  const { call, landed } = await signIn(t);
  assert.match(landed, /The page navigated\. Headings on the new page[\s\S]*h1 "Customers" \[ref=e\d+\]/);
  assert.match(await call('cor_snapshot', {}), /3 rows, each: button "Edit", button "Delete"\n {4}- "Ada Lovelace": e\d+, e\d+\n {4}- "Grace Hopper"/);
  const reply = await call('cor_inspect', { selector: row('Grace Hopper', 'delete'), detail: true });
  assert.ok(reply.includes(`  ${DELETE}\n`), 'the row template is the top entry');
  assert.match(reply, /each finds exactly its own item \(3\/3\)/);
  noPositional(reply);
  const cell = await call('cor_inspect', { selector: 'tr:has(td:text-is("Grace Hopper")) td:nth-child(2)' });
  assert.match(cell, /cellAt = \(name, column\) => \{/, 'a cell by row name × column header, not by index');
  noPositional(cell);
});

test('G1d CRUD state changes: adding a row first and deleting another, the Delete template still finds exactly each remaining row', async (t) => {
  const { call } = await signIn(t);
  await call('cor_fill', { target: '#add input[name=name]', value: 'Linus Torvalds' });
  await call('cor_fill', { target: '#add input[name=city]', value: 'Helsinki' });
  const added = await call('cor_click', { target: '#add button' });
  assert.match(added, /\+ "Linus Torvalds" \[ref=e\d+\] in table/);
  noPositional(added);
  const values = ['Linus Torvalds', 'Ada Lovelace', 'Grace Hopper', 'Alan Turing'];
  assert.match(await call('cor_grade', { selector: DELETE, param: 'name', values }), /Works for 4 of 4 values\./, 'every row moved down one');
  await call('cor_click', { target: row('Grace Hopper', 'delete') });
  const after = await call('cor_grade', { selector: DELETE, param: 'name', values });
  assert.match(after, /"Grace Hopper": ✗ 0 matches/);
  assert.match(after, /Works for 3 of 4 values\./);
});

test('G1d CRUD inline edit: the row\'s Name input is told apart from the add form\'s Name input, without an index', async (t) => {
  const { call } = await signIn(t);
  const editing = await call('cor_click', { target: row('Grace Hopper', 'edit') });
  assert.match(editing, /\+ table: textbox "Name" \[ref=e\d+\], textbox "City" \[ref=e\d+\], button "Save" \[ref=e\d+\]/);
  assert.match(editing, /nameInput = \(\) => this\.page\.locator\('#rows'\)\.getByRole\('textbox', \{ name: 'Name' \}\);/);
  noPositional(editing);
  const add = await call('cor_inspect', { selector: '#add input[name=name]' });
  assert.match(add, /this\.page\.locator\('#add'\)\.getByRole\('textbox', \{ name: 'Name' \}\)/);
  await call('cor_fill', { target: '#rows input[aria-label=City]', value: 'Arlington' });
  const saved = await call('cor_click', { target: '#rows .save' });
  assert.match(saved, /"Arlington"/, 'the save is reported');
});

test('G1d CRUD records: cor_check verifies the table entries behind the login', async (t) => {
  const { call, dir } = await signIn(t, { records: true });
  const del = entry(await call('cor_inspect', { selector: row('Grace Hopper', 'delete') }));
  const heading = entry(await call('cor_inspect', { selector: 'h1' }));
  writeFileSync(join(dir, 'crud.spec.js'), `${del}\n${heading}\n`);
  assert.match(await call('cor_check', { files: ['crud.spec.js'] }), /Records: 2 of 2 verified on the live page\./);
});

test('G1d CRUD: "Every item" is the data rows only — not the header row', { todo: 'G1d: forms behind a login (CRUD) — the row template\'s "Every item (3 now)" is page.locator(\'tr\'), which also matches the header row (4); looping it calls deleteOf on the header' }, async (t) => {
  const { call } = await signIn(t);
  const reply = await call('cor_inspect', { selector: row('Grace Hopper', 'delete'), detail: true });
  const every = /Every item \(3 now\): (page\.locator\([^)]*\))/.exec(reply)[1];
  assert.match(await call('cor_grade', { selector: every }), /matches 3 elements/);
});

test('G1d CRUD: cor_grade\'s "more durable alternative" passes the shared positional / partial-text check', { todo: 'G1d: forms behind a login (CRUD) — cor_grade on the Delete template proposes page.locator(\'tr\').filter({ hasText: … }).locator(\'button.delete\'), a partial-text match the shared check bans (cor_inspect declines the same locator)' }, async (t) => {
  const { call } = await signIn(t);
  const graded = await call('cor_grade', { selector: DELETE, param: 'name', values: ['Grace Hopper'] });
  const alt = /More durable alternative[^\n]*\n {2}(.+)/.exec(graded);
  assert.ok(alt, 'an alternative is offered');
  assert.equal(bannedIn(alt[1], 'playwright'), null, alt[1]);
});
