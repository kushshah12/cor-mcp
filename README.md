# @corlabs/mcp

An MCP server that lets a coding agent open a page, pick an element, and get ranked, graded locators for it in the test framework you use.

> The full README — install, tools and the maintenance workflow — lands with the release (U9). This file currently documents the one thing the server does without being asked.

## Fingerprints: what is stored, where, and how to turn it off

Every successful `cor_inspect` also records a **fingerprint** of the element: a small description of it that a future heal can use to find the same element after the page changes. It happens silently, adding nothing to the tool response or the log, so this section is the complete disclosure.

**Where:** one file per working folder, kept **outside** that folder, under your home directory:
`~/.cor/fingerprints/<folder name>-<6-character code of its full path>.json`
for example `~/.cor/fingerprints/cor-pw-testing-23dbb4.json`. The file also records the folder's full path. Nothing is written inside your project, so nothing can be committed, and a coding agent exploring your project won't find it. No account is involved, and nothing is sent over the network; the file never leaves your machine.

**Who reads it:** nothing yet. It is kept so a future COR repair tool can find what a broken locator used to point at. It is not meant for agents or people to read as advice; its locators are a history, and some may be ones COR no longer recommends.

**Moved from an earlier version:** earlier versions wrote `.cor/fingerprints.json` inside the project. The first time the server records something in that folder, it moves those records into the new file and deletes the old one. It also deletes `.cor/.gitignore` if that file lists only the old store, and removes `.cor/` if nothing else is left in it. Any other files in `.cor/` are left alone.

**What each record holds:**

- The page it came from, as **origin and path only**. Query strings and fragments are dropped, because tokens travel there.
- An element key: its position in the page as a tag path, e.g. `body:nth-of-type(1) > main:nth-of-type(1) > button:nth-of-type(2)`.
- The locators `cor_inspect` returned for it, masked as below.
- The fingerprint itself:
  - The element's tag.
  - These attributes, if present: `aria-label`, `aria-labelledby`, `name`, `placeholder`, `type`, `role`, `title`, `alt`, `href`, `for`.
  - Up to 80 characters of the element's own text.
  - Its first five class names.
- `firstSeen` / `lastSeen` timestamps and a format version.

**What is never stored:** what anyone typed into a field (input values), cookies, local storage, or anything from a storage-state file you pass to `cor_open`.

**Masking.** On an authenticated page the fields above can contain account data, so before anything is written:

| Found in text, attributes, classes or locators | Stored as |
|---|---|
| an email address | `[email]` |
| a run of 6 or more digits (order numbers, phone and card numbers; spaces and dashes allowed) | `[number]` |
| a long string of 24+ mixed letters and digits (tokens, session ids) | `[token]` |
| the query string or fragment of an `href` | removed |

Short numbers and ordinary words are kept, because a heal needs them ("Step 2", "Qty 12", "Pay now"). Values are masked, not hashed. A heal compares stored values with the live page as plain text, so a hashed value could never match again.

**Retention:** a record is refreshed each time its element is inspected again. Records not seen for **90 days** are deleted the next time the file is written. The file holds at most **5,000** records, newest kept.

**Turning it off:** start the server with `--no-fingerprints`, or set `COR_FINGERPRINTS=off`. Either way no file is created. Deleting any file in `~/.cor/fingerprints/` at any time is safe.
