// G1b (defect 3): Cypress text buttons. shadcn-admin's "Add User" / "Create" (text in a child <span>) and "Go to next page"
// (sr-only text) were declined in Cypress — the only text candidate, cy.contains('button', …), was resolved to the span.
// Second instance: angular-realworld. Needs the engine fix on fix/g1a-engine-regressions; todo until the MCP pins it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, baseUrl } from './helpers/mcp-site.js';
import { bannedIn } from '../src/positional.js';

const NEEDS_ENGINE = { todo: 'G1b: needs engine > 3.1.0 (hasText resolves by tag) — remove when the pin moves' };

test('G1b Cypress: a button whose text is in a child span or an sr-only span gets cy.contains(\'button\', …), not a decline', NEEDS_ENGINE, async (t) => {
  const { call } = await connect(t, 'cypress');
  await call('cor_open', { url: `${baseUrl()}/g1-text-buttons` });
  for (const [target, code] of [['button:has-text("Add User")', "cy.contains('button', 'Add User')"], ['button:has-text("Go to next page")', "cy.contains('button', 'Go to next page')"]]) {
    const reply = await call('cor_inspect', { selector: target });
    assert.doesNotMatch(reply, /declined/, reply);
    assert.ok(reply.includes(`= () => ${code};`), reply);
    assert.equal(bannedIn(code, 'cypress'), null);
  }
});
