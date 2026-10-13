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
  return { events, track: (built) => { if (built) events.push(built); } };
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
  assert.equal(event.event, 'mcp_tool_called');
  assert.equal(event.properties.tool, 'cor_open');
  assert.equal(event.properties.outcome, 'ok');
  assert.ok(Number.isInteger(event.properties.duration_ms) && event.properties.duration_ms >= 0);
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
  assert.equal(telemetry.events[0].properties.tool, 'cor_explore');
});

test('a disabled telemetry leaves tool results identical', async (t) => {
  const disabled = { track: () => {} };
  const client = await connect(t, createServer({ tools: [tool('cor_open', async () => ok)], telemetry: disabled }));
  assert.deepEqual(await client.callTool({ name: 'cor_open', arguments: {} }), ok);
});
