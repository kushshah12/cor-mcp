import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Tools join this list as they are implemented (U5–U8). No placeholders: an
// agent must never be offered a tool that cannot work.
export const TOOLS = [];

/**
 * Build the server. Needs no credentials, env vars or config file — COR's
 * local path is account-less, so missing credentials are the normal case.
 *
 * @param {{ tools?: Array<{ name: string, config: object, handler: Function }> }} [options]
 */
export function createServer({ tools = TOOLS } = {}) {
  const server = new McpServer({ name, version });
  // ponytail: McpServer installs tools/list lazily on the first registerTool,
  // so with zero tools it would answer "method not found". Install it up front.
  server.setToolRequestHandlers();
  for (const { name: toolName, config, handler } of tools) {
    server.registerTool(toolName, config, handler);
  }
  return server;
}
