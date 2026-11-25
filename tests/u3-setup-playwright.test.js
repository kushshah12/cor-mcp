// U3 (plan 2026-11-24-002): Playwright MCP is switched off only in Claude Code, only on a typed yes, and never deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup.js';

const VERSION = '0.2.0';
const PW = { command: 'npx', args: ['@playwright/mcp@latest'] };

function project() {
  const root = mkdtempSync(join(tmpdir(), 'cor-u3-'));
  const cwd = join(root, 'p');
  const home = join(root, 'h');
  mkdirSync(cwd);
  mkdirSync(home);
  return { cwd, home };
}
function out() {
  const c = [];
  return { stream: { write: (s) => c.push(s) }, text: () => c.join('') };
}
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
// Answers in order: the add question, then the Playwright question.
const answers = (...a) => async () => a.shift();

test('U3/AE1: agree → COR added, Playwright disabled in settings.local.json and still in .mcp.json', async () => {
  const { cwd, home } = project();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: PW } }));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: answers('', 'y') });
  const mcp = json(join(cwd, '.mcp.json'));
  assert.deepEqual(mcp.mcpServers.playwright, PW);
  assert.ok(mcp.mcpServers.cor);
  assert.deepEqual(json(join(cwd, '.claude', 'settings.local.json')).disabledMcpjsonServers, ['playwright']);
});

test('U3/AE1: decline → COR added, Playwright untouched, warning printed', async () => {
  const { cwd, home } = project();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: PW } }));
  const o = out();
  await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: answers('y', '') });
  assert.ok(json(join(cwd, '.mcp.json')).mcpServers.cor);
  assert.throws(() => readFileSync(join(cwd, '.claude', 'settings.local.json')));
  assert.match(o.text(), /warning: Playwright MCP \(playwright\) is still on/);
});

test('U3: existing settings.local.json keys are kept', async () => {
  const { cwd, home } = project();
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, disabledMcpjsonServers: ['old'] }));
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { pw: PW } }));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: answers('y', 'yes') });
  const s = json(join(cwd, '.claude', 'settings.local.json'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(s.disabledMcpjsonServers, ['old', 'pw']);
});

test('U3: re-run after disabling changes nothing', async () => {
  const { cwd, home } = project();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: PW } }));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: answers('y', 'y') });
  const before = [readFileSync(join(cwd, '.mcp.json'), 'utf8'), readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')];
  const r = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: answers('y', 'y') });
  assert.deepEqual(r.written, []);
  assert.deepEqual([readFileSync(join(cwd, '.mcp.json'), 'utf8'), readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')], before);
});

test('U3: --yes alone never switches Playwright off', async () => {
  const { cwd, home } = project();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: PW } }));
  const o = out();
  await runSetup({ cwd, home, version: VERSION, yes: true, stdout: o.stream, stdin: { isTTY: false } });
  assert.throws(() => readFileSync(join(cwd, '.claude', 'settings.local.json')));
  assert.match(o.text(), /warning/);
});

test('U3: Cursor with Playwright → only the COR entry is added; warning names the manual step', async () => {
  const { cwd, home } = project();
  mkdirSync(join(cwd, '.cursor'));
  writeFileSync(join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { playwright: PW } }));
  const o = out();
  await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: answers('y', 'y', 'y') });
  const cfg = json(join(cwd, '.cursor', 'mcp.json'));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['cor', 'playwright']);
  assert.deepEqual(cfg.mcpServers.playwright, PW);
  assert.match(o.text(), /turn it off in Cursor's MCP settings/);
});
