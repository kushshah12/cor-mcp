import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSession } from './session.js';
import { sessionTools } from './tools/session-tools.js';
import { inspectTools } from './tools/inspect.js';
import { gradeTools } from './tools/grade.js';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Tools join this list as they are implemented (U8). No placeholders: an
// agent must never be offered a tool that cannot work.
export function defaultTools(session, fingerprints = null) {
  const idCache = new Map(); // id-stability verdicts, shared by inspect and grade
  return [...sessionTools(session), ...inspectTools(session, idCache, fingerprints), ...gradeTools(session, idCache)];
}

// Sent once at connect. The user asks the agent for tests, not for locators,
// so COR's scores and alternatives only reach them if the agent reports them.
export const INSTRUCTIONS = [
  'COR finds, scores and match-counts locators on a live page. Use cor_snapshot to pick an element and cor_inspect to get its locator.',
  'When cor_inspect returns a Parameterised block and the test touches more than one of those items, or the codebase uses page objects, ' +
    'write one function that takes the parameter (e.g. addToCart(title)) instead of a locator per item. ' +
    'When the test covers every item ("every FAQ question", "all plans"), loop over the Every item locator instead of typing the values, so an item added later is tested too; use the listed values only for items the test names.',
  'To read a table value, cor_snapshot within the row\'s name — it lists the row\'s cells by column with refs — then cor_inspect the cell for a row × column template.',
  'Before running the tests, pass each locator you wrote or extended yourself — anything not copied as-is from cor_inspect — to cor_grade, with param when it takes one. ' +
    'Adding a step to a template (card.locator(\'.price\')) makes a new locator: the step can match several elements inside an item. ' +
    'Keep the page open — no cor_close — until you have graded them: grading needs it. ' +
    'Every locator comes from cor_inspect or is graded — including elements you only assert on (a heading, a total, a message): a navigation reply lists the new page\'s headings with refs. ' +
    'Never match by partial text (*=, a substring cy.contains, getByText without exact): use the exact text on the element itself, or an attribute.',
  'To see what an action changes — a new price, an answer that opens, the page a link leads to — act with it and read the reply of cor_click, cor_fill or cor_press: ' +
    'it lists changed and new text with refs (cor_inspect them) and the new page\'s headings with refs. Do not write scripts to read the page. ' +
    'Assert what an action changed — the new or changed text, the URL, that gone items are no longer displayed — not only that an element exists, ' +
    'and wait for that state with a retrying assertion, not a fixed sleep.',
  'Put independent calls in one turn — the elements you need to inspect, the locators you need to grade — rather than one call per turn: each turn re-reads the whole conversation.',
  'If the codebase already follows a locator convention (e.g. data-testid page objects), you may choose a listed alternative that fits it; say so.',
  'Page objects: before writing a locator, check whether the project has page objects (a pages/ or page-objects/ folder, classes wrapping a page). ' +
    'If it does, put each locator on the page object for that URL — a Parameterised block becomes one method taking the parameter; ' +
    'a Variants line becomes an action method that clicks the toggle first — and write the test against those methods, following the file\'s existing style.',
  'Reuse before adding: if a page object already has a method for the element, pass its locator to cor_grade as written, with param set to the method\'s argument — one call proves it for every value on the page. ' +
    'Healthy → reuse the method; broken or fragile → fix that method in place rather than adding a second one.',
  'In your final summary, list each locator you used on one line: the locator, its COR score, and the runner-up with its score — ' +
    'so the user can ask for a different choice.',
].join('\n');

/**
 * Build the server. Needs no credentials, env vars or config file — COR's
 * local path is account-less, so missing credentials are the normal case.
 *
 * @param {{
 *   session?: ReturnType<typeof createSession>,
 *   fingerprints?: ReturnType<typeof import('./fingerprints.js').createFingerprintStore> | null,
 *   tools?: Array<{ name: string, config: object, handler: Function }>,
 * }} [options]
 */
export function createServer({
  session = createSession(),
  fingerprints = null, // capture is the bin's decision (bin/cor-mcp.js), not a library default
  tools = defaultTools(session, fingerprints),
} = {}) {
  const server = new McpServer({ name, version }, { instructions: INSTRUCTIONS });
  // The client going away must not leave a Chrome process behind.
  server.server.onclose = () => session.close().catch(() => {});
  // ponytail: McpServer installs tools/list lazily on the first registerTool,
  // so with zero tools it would answer "method not found". Install it up front.
  server.setToolRequestHandlers();
  for (const { name: toolName, config, handler } of tools) {
    server.registerTool(toolName, config, handler);
  }
  return server;
}
