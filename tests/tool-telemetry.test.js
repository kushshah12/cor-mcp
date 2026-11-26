import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

async function connect(t, server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return client;
}

function recorder() {
  const events = [];
  // The handshake also sends $mcp_initialize; these tests count tool events only.
  return { events, track: (built) => { if (built?.event === '$mcp_tool_call') events.push(built); } };
}

const ok = { content: [{ type: 'text', text: 'fine' }] };
const tool = (name, handler) => ({ name, config: { description: name }, handler });

test('a successful call emits one ok event with a duration', async (t) => {
  const telemetry = recorder();
  const client = await connect(t, createServer({ tools: [tool('cor_open', async () => ok)], telemetry }));
  const reply = await client.callTool({ name: 'cor_open', arguments: {} });
  assert.deepEqual(reply, ok);
  assert.equal(telemetry.events.length, 1);
  const [event] = telemetry.events;
  assert.equal(event.event, '$mcp_tool_call');
  assert.equal(event.properties.$mcp_tool_name, 'cor_open');
  assert.equal(event.properties.outcome, 'ok');
  assert.ok(Number.isInteger(event.properties.$mcp_duration_ms) && event.properties.$mcp_duration_ms >= 0);
});

test('a result with isError is reported as tool_error and passes through unchanged', async (t) => {
  const telemetry = recorder();
  const errored = { isError: true, content: [{ type: 'text', text: 'no page' }] };
  const client = await connect(t, createServer({ tools: [tool('cor_click', async () => errored)], telemetry }));
  const reply = await client.callTool({ name: 'cor_click', arguments: {} });
  assert.equal(reply.isError, true);
  assert.equal(reply.content[0].text, 'no page');
  assert.equal(telemetry.events[0].properties.outcome, 'tool_error');
});

test('a thrown error is reported as exception and still reaches the client', async (t) => {
  const telemetry = recorder();
  const boom = async () => { throw new Error('secret page text https://x.test'); };
  const client = await connect(t, createServer({ tools: [tool('cor_fill', boom)], telemetry }));
  const reply = await client.callTool({ name: 'cor_fill', arguments: {} });
  assert.equal(reply.isError, true);
  assert.equal(telemetry.events[0].properties.outcome, 'exception');
  assert.doesNotMatch(JSON.stringify(telemetry.events), /secret|https?:\/\//);
});

test('a TimeoutError is reported as timeout', async (t) => {
  const telemetry = recorder();
  const slow = async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; };
  const client = await connect(t, createServer({ tools: [tool('cor_snapshot', slow)], telemetry }));
  await client.callTool({ name: 'cor_snapshot', arguments: {} });
  assert.equal(telemetry.events[0].properties.outcome, 'timeout');
});

test('a wrapped tool keeps its name in the tool list', async (t) => {
  const client = await connect(t, createServer({ tools: [tool('cor_open', async () => ok)], telemetry: recorder() }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['cor_open']);
});

test('the wrapper counts one outer call, not the steps a nested runner invokes', async (t) => {
  // Mirrors cor_explore: the runner calls the raw inner handler directly, not through the server.
  const telemetry = recorder();
  const inner = async () => ok;
  const runner = async () => { await inner(); await inner(); return ok; };
  const client = await connect(t, createServer({ tools: [tool('cor_explore', runner)], telemetry }));
  await client.callTool({ name: 'cor_explore', arguments: {} });
  assert.equal(telemetry.events.length, 1);
  assert.equal(telemetry.events[0].properties.$mcp_tool_name, 'cor_explore');
});

test('a disabled telemetry leaves tool results identical', async (t) => {
  const disabled = { track: () => {} };
  const client = await connect(t, createServer({ tools: [tool('cor_open', async () => ok)], telemetry: disabled }));
  assert.deepEqual(await client.callTool({ name: 'cor_open', arguments: {} }), ok);
});

test('MCP Analytics: errors carry a fixed type label, never the thrown text', async (t) => {
  const telemetry = recorder();
  const thrower = (message) => async () => { throw new Error(message); };
  const client = await connect(t, createServer({
    tools: [
      tool('cor_grade', thrower('No page is open — call cor_open with https://secret.test first.')),
      tool('cor_inspect', thrower('Pass exactly one of ref (from cor_snapshot), selector, or targets.')),
      tool('cor_fill', thrower('Cannot read properties of undefined')),
      tool('cor_click', async () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] })),
    ],
    telemetry,
  }));
  for (const name of ['cor_grade', 'cor_inspect', 'cor_fill', 'cor_click']) await client.callTool({ name, arguments: {} });
  const types = telemetry.events.map((e) => [e.properties.$mcp_tool_name, e.properties.$mcp_error_type, e.properties.$mcp_is_error]);
  assert.deepEqual(types, [['cor_grade', 'missing_context', true], ['cor_inspect', 'validation', true], ['cor_fill', 'internal', true], ['cor_click', 'Error', true]]);
  for (const e of telemetry.events) assert.equal(e.properties.$mcp_error_message, e.properties.$mcp_error_type);
  assert.doesNotMatch(JSON.stringify(telemetry.events), /secret|Pass exactly|undefined|nope/);
});

test('MCP Analytics: every call of a connection shares one ses_ session id and the client name', async (t) => {
  const telemetry = recorder();
  const client = await connect(t, createServer({ tools: [tool('cor_open', async () => ok)], telemetry }));
  await client.callTool({ name: 'cor_open', arguments: {} });
  await client.callTool({ name: 'cor_open', arguments: {} });
  const [a, b] = telemetry.events;
  assert.match(a.properties.$session_id, /^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.properties.$session_id, b.properties.$session_id);
  assert.equal(a.properties.$mcp_client_name, 'test');
  assert.ok(a.timestamp instanceof Date);
});
