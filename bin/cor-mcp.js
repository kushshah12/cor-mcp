#!/usr/bin/env node
// stdout carries the MCP protocol — never write anything else to it.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';
import { createSession, DEFAULT_IDLE_MS } from '../src/session.js';
import { createRecordStore } from '../src/records.js';
import { createTelemetry, announceFirstRun } from '../src/telemetry.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

// U8: one record per issued entry in <project>/.cor/records/ — committed, so heal works on any machine. P8a: an entry
// waits in .cor/pending/ (git-ignored) until cor_check finds its id in code.
// Off with --no-records (or the old --no-fingerprints) or COR_RECORDS=off (or COR_FINGERPRINTS=off).
const capture = !values['no-records'] && !values['no-fingerprints'] && process.env.COR_RECORDS !== 'off' && process.env.COR_FINGERPRINTS !== 'off';
const records = createRecordStore({ enabled: capture, root: () => session.root });

// U3: the install event and first-run notice. Off with COR_TELEMETRY=off or COR_OFFLINE=true (no file written).
const telemetry = createTelemetry();
announceFirstRun(telemetry, { version });

await createServer({ session, records, telemetry }).connect(new StdioServerTransport());
