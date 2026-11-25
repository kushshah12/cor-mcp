# Changelog

All notable changes to `@corlabsdev/mcp` are recorded here.
Format: `[mcp] description`.

## [Unreleased]

- [mcp] Reach U1: new `mcp_session_started` event, sent after the MCP handshake. It carries the client's reported name and version (64 printable ASCII characters at most), the package version, `ci` and `container` booleans, and `source`. A new `--source <name>` flag sets the source: known directory names, Lens, setup or readme pass through, anything else is `other`, and no flag is `unknown`. Processes that never complete a handshake (directory crawlers) send no session event, so real sessions can be told apart from bare starts.
- [mcp] Reach U2: `npx @corlabsdev/mcp setup` finds Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`), VS Code (`.vscode/mcp.json`) and Codex (`~/.codex/config.toml`). It asks before adding a COR entry pinned to the running version, with `--source setup` (or the `--source` passed to setup). A second run changes nothing. Configs that do not parse are skipped. Without a terminal it writes only with `--yes`. It writes nothing outside these files and sends no telemetry.
- [mcp] Reach U3: when `setup` finds Playwright MCP in Claude Code, it offers to switch it off through `disabledMcpjsonServers` in `.claude/settings.local.json`. The entry stays in `.mcp.json`. This needs a typed yes; `--yes` does not count. Cursor, VS Code and Codex have no off switch, so `setup` leaves Playwright there and warns.

- [mcp] U7 fix 1: a parameterised helper for a control inside a frame keeps the frame (`page.frameLocator(…)`). The frame prefix now covers the template's `params.code`, not only the locator list. A frame with no title, name, or usable id is addressed by its host (`iframe[src*="…"]`) instead of a position.
- [mcp] P8a test fix: the record-expiry test wrote its fixture with a fixed date (2026-10-01). `prune()` deletes pending entries older than 14 days, so the fixture expired on 2026-10-15 and the test failed. The fixture date is now yesterday, relative to the run.
- [mcp] Build: `tsup` and `typescript` are devDependencies. They were declared only in the `cor-sdk` root, so `npm run build` and the `pretest` step could not run after the package moved to this repo.
