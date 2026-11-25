# Directory listings (U6, plan 2026-11-24-002)

One copy source for every directory. Change the wording here first, then on each listing. Every sentence cites a
claim in `MESSAGING.md` (C-id) or a fact in this repo (README, `server.json`). Do not add C16–C19: token, turn and
positional-locator claims are not claimable yet.

## Copy

**Name:** COR MCP (`@corlabsdev/mcp`)

**One line (≤ 100 characters):**
Ranked locators from a live page, scored A–F, in the test framework you use.
— C2, C3

**Short description:**
COR MCP lets your coding agent open a page, pick an element, and get ranked locators for it. *(README)*
Every candidate is scored A–F on uniqueness, stability, and complexity. *(C2)*
Output for Playwright, Cypress, Selenium, WebdriverIO, Nightwatch, TestCafe, and Puppeteer. *(C3)*
No account. One command sets it up in Claude Code, Cursor, VS Code, or Codex: `npx @corlabsdev/mcp setup`. *(README)*

**Tools:** `cor_open`, `cor_snapshot`, `cor_inspect`, `cor_explore`, `cor_click`, `cor_fill`, `cor_press`,
`cor_grade`, `cor_check`, `cor_heal`, `cor_close`.

**Category:** Browser automation / testing. **Runs:** locally over stdio; needs Node 18+ and Chrome or Edge.

**Tags:** testing, locators, selectors, playwright, cypress, selenium, webdriverio, qa

## Install command per directory

The `--source` value is what the funnel (U5) splits on. A listing whose install command lacks it counts as `unknown`.

| Directory | Command or config args |
|-----------|------------------------|
| Smithery | `npx -y @corlabsdev/mcp --source smithery` |
| Glama | `npx -y @corlabsdev/mcp --source glama` |
| PulseMCP | `npx -y @corlabsdev/mcp --source pulsemcp` |
| Cursor directory | `{"mcpServers":{"cor":{"command":"npx","args":["-y","@corlabsdev/mcp","--source","cursor"]}}}` |
| mcp.so | `npx -y @corlabsdev/mcp --source mcpso` |
| awesome-mcp-servers | links to the README, which uses `setup --source readme` |

## awesome-mcp-servers entry

Section **Browser Automation**, alphabetical by `kushshah12/cor-mcp`:

```
- [kushshah12/cor-mcp](https://github.com/kushshah12/cor-mcp) [![kushshah12/cor-mcp MCP server](https://glama.ai/mcp/servers/kushshah12/cor-mcp/badges/score.svg)](https://glama.ai/mcp/servers/kushshah12/cor-mcp) 📇 🏠 🍎 🪟 🐧 - Open a page, pick an element, and get ranked locators scored A–F on uniqueness, stability and complexity, for Playwright, Cypress, Selenium, WebdriverIO, Nightwatch, TestCafe or Puppeteer.
```

PR description must name the backlink: the Glama badge in `README.md`.

## Status

Checked 2026-11-25.

| Directory | Method | URL | Submitted | Status | Re-crawls on release |
|-----------|--------|-----|-----------|--------|----------------------|
| Official MCP registry | `mcp-publisher publish` with `server.json` | registry.modelcontextprotocol.io | 2026-10-27 | live, but shows 0.1.7: republish 0.1.8 | no, publish each release |
| Glama | auto-indexed from GitHub; claim with `glama.json` | glama.ai/mcp/servers/kushshah12/cor-mcp | — | listed, unclaimed | yes (Sync Server after claim) |
| awesome-mcp-servers | PR to punkpeye/awesome-mcp-servers; needs Glama backlink | github.com/punkpeye/awesome-mcp-servers | — | not submitted | no, static line |
| mcp.so | form at mcp.so/submit, or issue on chatmcp/mcpso | mcp.so | — | not submitted | unknown |
| Cursor directory | web form, signed in | cursor.directory/mcp | — | not submitted | unknown |
| PulseMCP | form at pulsemcp.com/submit | pulsemcp.com | — | submissions paused; ingests the official registry | via official registry |
| Smithery | `smithery mcp publish <bundle>.mcpb`: stdio servers need an MCPB bundle | smithery.ai | — | not submitted: needs an MCPB build | no, publish each release |
