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
  const outline = (page) => pageOutline(session, page, { idCache });
  return [...sessionTools(session, inspector, outline), ...inspectTools(session, idCache, inspector, records), ...gradeTools(session, idCache), ...checkTools(session, inspector, records), ...healTools(session, inspector, records)];
}

// Sent once at connect. The user asks the agent for tests, not for locators,
// so COR's scores and alternatives only reach them if the agent reports them.
// P4: a short workflow, under 2k characters. What an entry or reply already says (file, member, style, variants, the
// every-item loop) is not repeated here; the P0 compliance metrics measure whether agents follow it.
export const INSTRUCTIONS = [
  'COR finds, checks and grades locators on a live page and gives you entries to place. Workflow:',
  '1. cor_open the page: the reply lists its controls with refs (a region index on a large page — cor_snapshot within a region for its text, controls and entries).',
  '2. Get every element you need in one call: cor_inspect targets: [refs]. To see what an action changes, act with cor_click, cor_fill or cor_press and read the reply: it lists changed and new text, and the new page\'s headings, with their entries. Do not write scripts to read the page.',
  '3. Place each entry as given, its // COR cor:… comment included, in the file it names. An entry taking a parameter (title, question) is one function for every item: write one function that takes the parameter, not a locator per item; when the test covers every item, loop over the every-item locator instead of typing the values. A · label member is what you click for a hidden input; assert the input\'s checked state.',
  '4. Every locator comes from COR, including elements you only assert on. Never match by partial text (*=, a substring cy.contains, getByText without exact). Pass a locator you wrote or extended yourself to cor_grade, with param when it takes one (a step added to a template can match several elements inside an item); keep the page open — no cor_close — until you have graded them.',
  '5. Before running the tests, run cor_check: it fails on any locator without a COR id and returns the entry to paste. An existing method for the element: fix it in place rather than adding a second one.',
  '6. Assert what an action changed — the new text, the URL, that gone items are not displayed — with a retrying assertion, not a fixed sleep.',
  '7. A test failing on a locator: cor_grade it; broken → cor_heal with its cor: line, and apply the proposal only if it is the same element.',
  'Put independent calls in one turn: each turn re-reads the whole conversation.',
  'In your final summary, list each locator you used with its COR score and the runner-up.',
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
