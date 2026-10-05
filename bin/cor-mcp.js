#!/usr/bin/env node
// stdout carries the MCP protocol — never write anything else to it.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';
import { createSession, DEFAULT_IDLE_MS } from '../src/session.js';
import { createRecordStore } from '../src/records.js';

const { values } = parseArgs({
  options: {
    headless: { type: 'boolean', default: false },
    'idle-minutes': { type: 'string' },
    'no-records': { type: 'boolean', default: false },
    'no-fingerprints': { type: 'boolean', default: false }, // the old name, kept as an alias
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

// U8: one record per issued entry in <project>/.cor/records/ — committed, so heal works on any machine.
// Off with --no-records (or the old --no-fingerprints) or COR_RECORDS=off (or COR_FINGERPRINTS=off).
const capture = !values['no-records'] && !values['no-fingerprints'] && process.env.COR_RECORDS !== 'off' && process.env.COR_FINGERPRINTS !== 'off';
const records = createRecordStore({ enabled: capture, root: () => session.root });

await createServer({ session, records }).connect(new StdioServerTransport());
