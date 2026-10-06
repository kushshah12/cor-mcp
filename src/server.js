import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSession } from './session.js';
import { sessionTools } from './tools/session-tools.js';
import { inspectTools } from './tools/inspect.js';
import { gradeTools } from './tools/grade.js';
import { checkTools } from './tools/check.js';
import { healTools } from './tools/heal.js';
import { createInspector, pageOutline } from './tools/inspect.js';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Tools join this list as they are implemented (U8). No placeholders: an
// agent must never be offered a tool that cannot work.
export function defaultTools(session, records = null) {
  const idCache = new Map(); // id-stability verdicts, shared by inspect and grade
  const inspector = createInspector(session, idCache, records); // shared: cor_check and cor_heal issue entries too
  const outline = (page) => pageOutline(session, page, { idCache, records });
  return [...sessionTools(session, inspector, outline), ...inspectTools(session, idCache, inspector, records), ...gradeTools(session, idCache), ...checkTools(session, inspector, records), ...healTools(session, inspector, records)];
}

// Sent once at connect. The user asks the agent for tests, not for locators,
// so COR's scores and alternatives only reach them if the agent reports them.
export const INSTRUCTIONS = [
  'COR finds, scores and match-counts locators on a live page. Use cor_snapshot to pick an element and cor_inspect to get its locator.',
  'When cor_inspect returns a Parameterised block and the test touches more than one of those items, or the codebase uses page objects, ' +
    'write one function that takes the parameter (e.g. addToCart(title)) instead of a locator per item. ' +
    'When the test covers every item ("every FAQ question", "all plans"), loop over the Every item locator instead of typing the values, so an item added later is tested too; use the listed values only for items the test names.',
  'To read a table value, cor_snapshot within the row\'s name — it lists the row\'s cells by column with refs — then cor_inspect the cell for a row × column template.',
  'cor_inspect gives an Entry for each element: the code to place, the file and member it belongs in, and a // COR cor:… comment. Place it as given, comment included — ' +
    'the id is how COR tells its locators from typed ones. Before running the tests, run cor_check: it fails on any locator without a COR id and returns the entry to paste. ' +
    'If the entry\'s file does not exist, create it in the project\'s style (a class wrapping the page for page objects). ' +
    'Pass a locator you wrote or extended yourself to cor_grade, with param when it takes one — graded is not accepted: cor_check still needs its COR id, so replace it with the entry cor_check returns. ' +
    'Adding a step to a template (card.locator(\'.price\')) makes a new locator: the step can match several elements inside an item. ' +
    'Keep the page open — no cor_close — until you have graded them: grading needs it. ' +
    'Every locator comes from cor_inspect or is graded — including elements you only assert on (a heading, a total, a message): a navigation reply lists the new page\'s headings with refs. ' +
    'Never match by partial text (*=, a substring cy.contains, getByText without exact): use the exact text on the element itself, or an attribute.',
  'To see what an action changes — a new price, an answer that opens, the page a link leads to — act with it and read the reply of cor_click, cor_fill or cor_press: ' +
    'it lists changed and new text and the new page\'s headings with refs, and gives their entries — no cor_snapshot or cor_inspect needed for them. Do not write scripts to read the page. ' +
    'Assert what an action changed — the new or changed text, the URL, that gone items are no longer displayed — not only that an element exists, ' +
    'and wait for that state with a retrying assertion, not a fixed sleep.',
  'Put independent calls in one turn — the elements you need to inspect (cor_inspect targets: [...] takes them all in one call), the locators you need to grade — rather than one call per turn: each turn re-reads the whole conversation.',
  // U11: the Entry names the file, member and style (U7/U8), so the page-object and convention paragraphs went.
  'A Variants line becomes an action method that clicks the toggle first. Write the test against the entries\' members. ' +
    'An existing method for the element: cor_check gives it COR\'s id or the entry to replace it — fix it in place rather than adding a second one.',
  'When a test fails on a locator: cor_grade it. Broken → cor_heal with the locator line, its cor: comment included — it proposes a replacement from the committed record, or declines; apply it only if it is the same element.',
  'In your final summary, list each locator you used on one line: the locator, its COR score, and the runner-up with its score — ' +
    'so the user can ask for a different choice.',
].join('\n');

/**
 * Build the server. Needs no credentials, env vars or config file — COR's
 * local path is account-less, so missing credentials are the normal case.
 *
 * @param {{
 *   session?: ReturnType<typeof createSession>,
 *   tools?: Array<{ name: string, config: object, handler: Function }>,
 * }} [options]
 */
export function createServer({
  session = createSession(),
  records = null, // U8: .cor/records/ in the project is written only when the bin turns it on (bin/cor-mcp.js)
  tools = defaultTools(session, records),
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
