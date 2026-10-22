import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceFirstRun, FIRST_RUN_NOTICE } from '../src/telemetry.js';

function fakeStderr() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(s) };
}

test('first run sends mcp_installed once and writes the notice to stderr', () => {
  const sent = [];
  const stderr = fakeStderr();
  announceFirstRun({ installCreated: true, track: (e) => sent.push(e) }, { version: '0.1.4', stderr });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'mcp_installed');
  assert.deepEqual(stderr.chunks, [FIRST_RUN_NOTICE]);
});

test('a later run sends nothing and writes nothing', () => {
  const sent = [];
  const stderr = fakeStderr();
  announceFirstRun({ installCreated: false, track: (e) => sent.push(e) }, { version: '0.1.4', stderr });
  assert.equal(sent.length, 0);
  assert.equal(stderr.chunks.length, 0);
});

test('the notice names the opt-out', () => {
  assert.match(FIRST_RUN_NOTICE, /COR_TELEMETRY=off/);
});
