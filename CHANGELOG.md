# Changelog

All notable changes to `@corlabsdev/mcp` are recorded here.
Format: `[mcp] description`.

## [Unreleased]

- [mcp] U7 fix 1: a parameterised helper for a control inside a frame keeps the frame (`page.frameLocator(…)`). The frame prefix now covers the template's `params.code`, not only the locator list. A frame with no title, name, or usable id is addressed by its host (`iframe[src*="…"]`) instead of a position.
- [mcp] P8a test fix: the record-expiry test wrote its fixture with a fixed date (2026-10-01). `prune()` deletes pending entries older than 14 days, so the fixture expired on 2026-10-15 and the test failed. The fixture date is now yesterday, relative to the run.
- [mcp] Build: `tsup` and `typescript` are devDependencies. They were declared only in the `cor-sdk` root, so `npm run build` and the `pretest` step could not run after the package moved to this repo.
