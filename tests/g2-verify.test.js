// G2 (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md §8, gate 2 baseline): verification called entries
// "broken" that still found their element — false broken, on angular-realworld before any release.
//   - accessible name: an icon font's ::before glyph is in the browser's name ("\uf12c New Article"), not the engine's;
//     the stored role strategy was run exact and found 0 (also G1b: WebdriverIO aria/ found nothing).
//   - scoped entries: a stored `div.banner >> role=link, name=…` was run as one CSS string and found 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, connect, entry } from './helpers/mcp-site.js';

test('G2 verify: a link whose name carries an icon-font glyph, and a banner-scoped link, are verified — not broken', async (t) => {
  const { call, dir } = await connect(t, '@playwright/test', { records: true });
  await call('cor_open', { url: `${baseUrl()}/g2-names` });
  const nav = entry(await call('cor_inspect', { selector: 'a[href="/editor"]' }));
  const banner = entry(await call('cor_inspect', { selector: '.banner a' }));
  assert.match(banner, /locator\('div\.banner'\)\.getByRole\('link', \{ name: 'Edit Article' \}\)/);
  writeFileSync(join(dir, 'p.spec.js'), `${nav}\n${banner}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 2 of 2 verified on the live page\./);
});

// G2 (tables): shadcn-admin's users table — a cell holding an email is recorded masked ("[email]", src/redact.js) and the
// live text never matches the mask, so the cell record was "finds one cell at freeman.dicki × Email, but not the recorded one".
test('G2 verify: a cell whose text is masked in its record (an email) is verified at its row × column', async (t) => {
  const { call, dir } = await connect(t, '@playwright/test', { records: true });
  await call('cor_open', { url: `${baseUrl()}/g2-cells` });
  const reply = await call('cor_inspect', { selector: 'tr:nth-child(2) td:nth-child(3) div' });
  const member = /  \/\/ COR[\s\S]*?\n  \};/.exec(reply)?.[0];
  assert.ok(member, reply);
  writeFileSync(join(dir, 'p.spec.js'), `class P {\n${member}\n}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});

// G2 (masked attributes): shadcn-admin's email inputs (sign-in, Add User) — the record masks the placeholder
// ("name@example.com" → "[email]") and the comparison dropped it from the record only. The live element still has it, so it
// counted as a miss (0.53 of 0.8, under the 0.7 bar): "finds one element, but not the recorded one", at A already.
test('G2 verify: an input whose placeholder is masked in its record (an email) is verified, not "not the recorded one"', async (t) => {
  const { call, dir } = await connect(t, '@playwright/test', { records: true });
  await call('cor_open', { url: `${baseUrl()}/g2-cells` });
  writeFileSync(join(dir, 'p.spec.js'), `${entry(await call('cor_inspect', { selector: '#em' }))}\n`);
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});

// G2 (attribute churn): angular-realworld's bio and body textareas gain name= at the next release; the record had only the
// placeholder, and the new attribute counted as a miss (0.53 of 0.8) — "not the recorded one" on an unchanged element.
test('G2 verify: an attribute the next release adds does not make the element "not the recorded one"', async (t) => {
  const { call, dir } = await connect(t, '@playwright/test', { records: true });
  await call('cor_open', { url: `${baseUrl()}/g2-cells` });
  writeFileSync(join(dir, 'p.spec.js'), `${entry(await call('cor_inspect', { selector: '.settings textarea' }))}\n`);
  await call('cor_open', { url: `${baseUrl()}/g2-cells?release=2` });
  assert.match(await call('cor_check', { files: ['p.spec.js'] }), /Records: 1 of 1 verified on the live page\./);
});

// G1b/G2 (accessible name): WebdriverIO's aria/ needs the browser's whole name, glyph included — angular-realworld's
// $('aria/New Article') found nothing. The engine no longer offers aria/ when generated content changes the name.
test('G2 WebdriverIO: a link whose name carries an icon-font glyph is not issued as aria/', async (t) => {
  const { call } = await connect(t, 'webdriverio');
  await call('cor_open', { url: `${baseUrl()}/g2-names` });
  const reply = await call('cor_inspect', { selector: 'a[href="/editor"]' });
  assert.doesNotMatch(reply, /aria\/New Article/, reply);
  assert.match(await call('cor_inspect', { selector: 'a[href="/"]' }), /\$\('aria\/Home'\)/, 'a name without generated content keeps aria/');
});
