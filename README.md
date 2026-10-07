# @corlabsdev/mcp

An MCP server that lets a coding agent open a page, pick an element, and get ranked, graded locators for it in the test framework you use.

More at [corlabs.dev](https://corlabs.dev).

## Install

Requires Node 18+ and Google Chrome (Microsoft Edge, or Playwright's Chromium, also work). Nothing is installed globally: your agent runs the server with `npx`.

Add COR to your client. Every client runs the same command, `npx -y @corlabsdev/mcp`.

**Claude Code**

```bash
claude mcp add cor -- npx -y @corlabsdev/mcp
```

To share it with your team, put it in `.mcp.json` at the project root instead:

```json
{ "mcpServers": { "cor": { "command": "npx", "args": ["-y", "@corlabsdev/mcp"] } } }
```

**GitHub Copilot (VS Code)** — create `.vscode/mcp.json` (or run **MCP: Add Server** from the Command Palette):

```json
{ "servers": { "cor": { "type": "stdio", "command": "npx", "args": ["-y", "@corlabsdev/mcp"] } } }
```

Then open Copilot Chat, switch to **Agent** mode, and enable `cor` in the tools list.

**Codex** (CLI and IDE extension)

```bash
codex mcp add cor -- npx -y @corlabsdev/mcp
```

or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.cor]
command = "npx"
args = ["-y", "@corlabsdev/mcp"]
```

**Cursor** — `.cursor/mcp.json`, and **Claude Desktop** — `claude_desktop_config.json`:

```json
{ "mcpServers": { "cor": { "command": "npx", "args": ["-y", "@corlabsdev/mcp"] } } }
```

Any other MCP client: register a stdio server whose command is `npx` with arguments `-y @corlabsdev/mcp`.

Restart the client (or reload the window), then ask your agent to open your page: *"Use COR to open https://example.com/login and write the locators for the sign-in form."*

If no browser is found the server says so; install Chrome, or run `npx playwright-core install chromium`.

**Options** (append to `args`, or after `--` in `claude mcp add`):

| Flag | Effect |
|---|---|
| `--headless` | Run the browser without a window (default: visible) |
| `--idle-minutes <n>` | Close the browser after `n` idle minutes |
| `--no-records` | Write no entry records into your project (see below) |

## Tools

| Tool | Does |
|---|---|
| `cor_open` | Open a page; lists its controls with refs |
| `cor_snapshot` | Text, controls and entries within one region of a large page |
| `cor_inspect` | Ranked, graded locators for the elements you name, as entries to place in your code |
| `cor_click`, `cor_fill`, `cor_press` | Act on the page and report what changed |
| `cor_check` | Fail any locator in your files that did not come from COR |
| `cor_grade` | Score a locator you wrote yourself |
| `cor_heal` | Propose a repair for a locator that stopped matching |
| `cor_close` | Close the browser |

## Workflow

1. `cor_open` the page, then `cor_inspect` every element the test touches, in one call.
2. Place each entry as given, its `// COR cor:…` comment included, in the file it names.
3. Run `cor_check` before the tests. When a test breaks on a locator, `cor_grade` it and `cor_heal` if it is broken.

## Updating

`npx -y @corlabsdev/mcp` runs the latest version each time it starts. To pin one, use `npx -y @corlabsdev/mcp@0.1.0`.

## Setup: COR as the only browser tool

Configure COR MCP **instead of** Playwright MCP for test authoring, not alongside it: COR drives the browser (open, click, fill, press), returns locators as entries for your locator files, checks them (`cor_check`) and repairs them (`cor_heal`). With a second browser server attached, an agent falls back to its snapshots and types its own selectors — which `cor_check` will then fail.

Settings are optional. COR infers your test framework and conventions from the repo; to override them, add a `cor.config.js` at the project root. `framework` names the test framework and the rest go under `locators`. Every field is optional; `cor_open` reports what was inferred and what was overridden:

```js
module.exports = {
  framework: 'playwright',          // 'playwright' | 'cypress' | 'webdriverio'
  locators: {
    order: 'framework',             // 'framework' (default: each framework's published guidance, after uniqueness) or 'testid-first'
    testIdAttribute: 'data-test',   // what getByTestId reads (default: playwright.config's testIdAttribute, else data-testid)
    store: 'page-object-class',     // 'page-object-class' | 'constants' | 'json' | 'yaml'
    storeDir: 'tests/pages',
  },
}
```

## Entry records: what is written inside your project

Every `cor_inspect` that recommends a locator also gives it an **entry**: the code to place in your locator file, the file and member it belongs in, and a comment carrying a short id, `// COR cor:7f3a2c · …` (in a YAML map, `# COR cor:…`). Keep that comment: `cor_check` uses the id to tell COR's locators from typed ones, and a later repair uses it to find what the locator pointed at. COR never edits your files — the agent places the entry.

**Where:** `.cor/records/<id>.json` in your project root (where your test framework's `package.json` is), one small file per element. Inspecting the same element again reuses its id and refreshes its file. For a JSON locator map, which cannot hold comments, COR also keeps `.cor/ids.json` (`"file#key": "id"`) — it never adds keys to your map.

**Commit them.** They are how a repair works on a teammate's machine or in a CI checkout: the id travels in your code and the record travels with the repo. Add `.cor/records/` to `.gitignore` if you would rather keep them on one machine.

**What each record holds:** the page (origin and path, masked), the element's position as a tag path, the entry's member name, the element's fingerprint — its tag; `aria-label`, `aria-labelledby`, `name`, `placeholder`, `type`, `role`, `title`, `alt`, `href`, `for` if present; up to 80 characters of its own text; its first five class names — and up to 12 locators ranked for it, stored as data (`{ "kind": "testId", "value": "[data-test=\"…\"]" }`), not as code to paste. COR never shows a record's contents to the agent.

**What is never stored:** what anyone typed into a field (input values), cookies, local storage, or anything from a storage-state file you pass to `cor_open`.

**Masking.** On an authenticated page the fields above can contain account data, so before anything is written:

| Found in text, attributes, classes or locators | Stored as |
|---|---|
| an email address | `[email]` |
| a run of 6 or more digits (order numbers, phone and card numbers; spaces and dashes allowed) | `[number]` |
| a long string of 24+ mixed letters and digits (tokens, session ids) | `[token]` |
| the query string or fragment of an `href` | removed |

Short numbers and ordinary words are kept, because a heal needs them ("Step 2", "Qty 12", "Pay now"). Values are masked, not hashed. A heal compares stored values with the live page as plain text, so a hashed value could never match again.

**Turning it off:** start the server with `--no-records` or set `COR_RECORDS=off` (the old `--no-fingerprints` / `COR_FINGERPRINTS=off` still work): no record is written; entries still carry an id, and `cor_check` then checks ids for presence only. The `~/.cor/fingerprints/` store of earlier versions is no longer written or read; deleting it is safe.
