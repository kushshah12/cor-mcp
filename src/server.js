import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSession } from './session.js';
import { sessionTools } from './tools/session-tools.js';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Tools join this list as they are implemented (U6–U8). No placeholders: an
// agent must never be offered a tool that cannot work.
export const defaultTools = (session) => [...sessionTools(session)];

/**
 * Build the server. Needs no credentials, env vars or config file — COR's
 * local path is account-less, so missing credentials are the normal case.
 *
 * @param {{
 *   session?: ReturnType<typeof createSession>,
 *   tools?: Array<{ name: string, config: object, handler: Function }>,
 * }} [options]
 */
export function createServer({ session = createSession(), tools = defaultTools(session) } = {}) {
  const server = new McpServer({ name, version });
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
