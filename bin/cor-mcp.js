#!/usr/bin/env node
// stdout carries the MCP protocol — never write anything else to it.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';
import { createSession, DEFAULT_IDLE_MS } from '../src/session.js';
import { createFingerprintStore } from '../src/fingerprints.js';
import { createRecordStore } from '../src/records.js';

const { values } = parseArgs({
  options: {
    headless: { type: 'boolean', default: false },
    'idle-minutes': { type: 'string' },
    'no-fingerprints': { type: 'boolean', default: false },
  },
});
const idleMinutes = Number(values['idle-minutes']);
const session = createSession({
  headless: values.headless,
  idleMs: idleMinutes > 0 ? idleMinutes * 60_000 : DEFAULT_IDLE_MS,
});

// The stdio transport does not watch for stdin closing, and an open browser
// keeps the event loop alive — so without this a client that exits leaves a
// Chrome process behind.
const shutdown = () => session.close().finally(() => process.exit(0));
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Silent capture to ~/.cor/fingerprints/<folder>-<code>.json, outside the project; see the README.
const capture = !values['no-fingerprints'] && process.env.COR_FINGERPRINTS !== 'off';
const fingerprints = createFingerprintStore({ enabled: capture });
// U8: one record per issued entry in <project>/.cor/records/ — committed, so heal works on any machine. Same switch.
const records = createRecordStore({ enabled: capture, root: () => session.root });

await createServer({ session, fingerprints, records }).connect(new StdioServerTransport());
