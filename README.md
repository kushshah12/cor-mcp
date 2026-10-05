# @corlabs/mcp

An MCP server that lets a coding agent open a page, pick an element, and get ranked, graded locators for it in the test framework you use.

> The full README — install, tools and the maintenance workflow — lands with the release (U9). This file currently documents the one thing the server does without being asked.

## Setup: COR as the only browser tool

Configure COR MCP **instead of** Playwright MCP for test authoring, not alongside it: COR drives the browser (open, click, fill, press), returns locators as entries for your locator files, checks them (`cor_check`) and repairs them (`cor_heal`). With a second browser server attached, an agent falls back to its snapshots and types its own selectors — which `cor_check` will then fail.

Settings live in the project's `cor.config.js` — the same file `@corlabs/client` reads, which `cor init` writes. `framework` is the SDK's own key; the MCP's settings go under `locators`. Every field is optional and overrides what COR infers from the repo; `cor_open` reports both:

```js
module.exports = {
  // …the SDK's apiUrl, projectId, branch, cacheFile…
  framework: 'playwright',          // also the SDK's
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
