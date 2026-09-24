#!/usr/bin/env node
// stdout carries the MCP protocol — never write anything else to it.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';

await createServer().connect(new StdioServerTransport());
