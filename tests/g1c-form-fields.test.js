// G1c (gold locators, docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8): COR's entry against the gold one.
// Mode "Modals / forms": shadcn-admin's Add User dialog lays each labelled field in a row that shares a class, and COR offered
// a template over the label text (`div.grid-cols-6` filtered by `label.col-span-2`, then `input.file\:text-foreground`) where
// a reviewer writes getByLabel. A list whose labels are its data (a todo list) still gets its template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, baseUrl } from './helpers/mcp-site.js';

const open = async (t) => {
  const run = await connect(t);
  await run.call('cor_open', { url: `${baseUrl()}/g1c-form-fields` });
  return run;
};

test('G1c form fields: a labelled field in a form is found by its label, with no template over the label text', async (t) => {
  const { call } = await open(t);
  for (const [sel, name] of [['#f1', 'First Name'], ['#f3', 'Email']]) {
    const reply = await call('cor_inspect', { selector: sel });
    assert.match(reply, new RegExp(`= \\(\\) => this\\.page\\.(getByLabel\\('${name}'|getByRole\\('textbox', \\{ name: '${name}')`), reply);
    assert.doesNotMatch(reply, /items checked|grid-cols-6/, reply);
  }
});

test('G1c form fields: a labelled list outside a form (todos) keeps its per-item template', async (t) => {
  const { call } = await open(t);
  assert.match(await call('cor_inspect', { selector: '#t2' }), /items checked/);
});


test('G1c form fields: a Radix Select trigger (<button role="combobox">) is named by its <label for>', async (t) => {
  const { call } = await open(t);
  const reply = await call('cor_inspect', { selector: '#f5' });
  assert.match(reply, /= \(\) => this\.page\.(getByRole\('combobox', \{ name: 'Role'|getByLabel\('Role'\))/, reply);
});
