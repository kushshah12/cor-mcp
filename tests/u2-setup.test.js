// U2 (plan 2026-11-24-002): `setup` detects clients and writes the COR entry only where confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runSetup } from '../src/setup.js';

const VERSION = '0.2.0';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'cor-u2-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  return { root, cwd, home };
}

function files(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

function out() {
  const chunks = [];
  return { stream: { write: (s) => chunks.push(s) }, text: () => chunks.join('') };
}

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const always = (answer) => async () => answer;

test('U2/AE4: no client found writes nothing and prints manual setup for all four clients', async () => {
  const { root, cwd, home } = dirs();
  const o = out();
  const r = await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: always('y') });
  assert.deepEqual(r.written, []);
  assert.deepEqual(files(root), []);
  for (const label of ['Claude Code', 'Cursor', 'VS Code', 'Codex']) assert.match(o.text(), new RegExp(label));
  assert.match(o.text(), /--source/);
});

test('U2: Cursor gets a pinned COR entry and keeps existing servers', async () => {
  const { cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  const other = { command: 'node', args: ['x.js'], env: { A: '1' } };
  writeFileSync(join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other } }));
  const r = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('') });
  assert.deepEqual(r.written, ['cursor']);
  const cfg = json(join(cwd, '.cursor', 'mcp.json'));
  assert.deepEqual(cfg.mcpServers.other, other);
  assert.deepEqual(cfg.mcpServers.cor, { command: 'npx', args: ['-y', '@corlabsdev/mcp@0.2.0', '--source', 'setup'] });
});

test('U2/AE2: a second run changes nothing and says so', async () => {
  const { root, cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  const before = readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8');
  const listed = files(root);
  const o = out();
  const r = await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: always('y') });
  assert.deepEqual(r.written, []);
  assert.equal(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'), before);
  assert.deepEqual(files(root), listed);
  assert.match(o.text(), /already set up/);
});

test('U2: COR under another server name counts as configured', async () => {
  const { cwd, home } = dirs();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { locators: { command: 'npx', args: ['@corlabsdev/mcp'] } } }));
  const r = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  assert.deepEqual(r.written, []);
});

test('U2: VS Code uses servers with type stdio', async () => {
  const { cwd, home } = dirs();
  mkdirSync(join(cwd, '.vscode'));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  const cfg = json(join(cwd, '.vscode', 'mcp.json'));
  assert.equal(cfg.mcpServers, undefined);
  assert.equal(cfg.servers.cor.type, 'stdio');
});

test('U2: Codex gets an appended block; other tables survive; an existing COR table under any name is left alone', async () => {
  const { cwd, home } = dirs();
  mkdirSync(join(home, '.codex'));
  const file = join(home, '.codex', 'config.toml');
  const original = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "node"\n';
  writeFileSync(file, original);
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith(original));
  assert.match(text, /\[mcp_servers\.cor\]\ncommand = "npx"\nargs = \["-y", "@corlabsdev\/mcp@0\.2\.0", "--source", "setup"\]\n$/);

  writeFileSync(file, '[mcp_servers.locators]\nargs = ["@corlabsdev/mcp"]\n');
  const r = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  assert.deepEqual(r.written, []);

  writeFileSync(file, '# [mcp_servers.old]\n# args = ["@corlabsdev/mcp"]\n');
  const r2 = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  assert.deepEqual(r2.written, ['codex'], 'a commented-out entry is not a live one');
});

test('U2: a malformed or commented JSON config is skipped and left unchanged', async () => {
  const { cwd, home } = dirs();
  const bad = '{ // my servers\n "mcpServers": {} }';
  writeFileSync(join(cwd, '.mcp.json'), bad);
  const o = out();
  const r = await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: always('y') });
  assert.deepEqual(r.written, []);
  assert.equal(readFileSync(join(cwd, '.mcp.json'), 'utf8'), bad);
  assert.match(o.text(), /skipped .*could not parse/);
});

test('U2: no TTY and no --yes writes nothing and explains how to rerun', async () => {
  const { root, cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  const o = out();
  const r = await runSetup({ cwd, home, version: VERSION, stdout: o.stream, stdin: { isTTY: false } });
  assert.deepEqual(r.written, []);
  assert.deepEqual(files(root), []);
  assert.match(o.text(), /--yes/);
});

test('U2: --yes writes every detected client without prompting, and --source flows into the entry', async () => {
  const { cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  mkdirSync(join(cwd, '.vscode'));
  const r = await runSetup({ cwd, home, version: VERSION, yes: true, source: 'lens', stdout: out().stream, stdin: { isTTY: false } });
  assert.deepEqual(r.written, ['cursor', 'vscode']);
  assert.deepEqual(json(join(cwd, '.cursor', 'mcp.json')).mcpServers.cor.args.slice(-2), ['--source', 'lens']);
});

test('U2: declining a client skips it', async () => {
  const { root, cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  const r = await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('n') });
  assert.deepEqual(r.written, []);
  assert.deepEqual(files(root), []);
});

test('U2/R11: only client config files are written — no ~/.cor, no temp files left', async () => {
  const { root, cwd, home } = dirs();
  for (const d of ['.claude', '.cursor', '.vscode']) mkdirSync(join(cwd, d));
  mkdirSync(join(home, '.codex'));
  await runSetup({ cwd, home, version: VERSION, stdout: out().stream, ask: always('y') });
  assert.deepEqual(files(root), ['home/.codex/config.toml', 'project/.cursor/mcp.json', 'project/.mcp.json', 'project/.vscode/mcp.json']);
  assert.equal(existsSync(join(home, '.cor')), false);
});

test('U2: the closing message prints the first prompt and the review reminder', async () => {
  const { cwd, home } = dirs();
  mkdirSync(join(cwd, '.cursor'));
  const o = out();
  await runSetup({ cwd, home, version: VERSION, stdout: o.stream, ask: always('y') });
  assert.match(o.text(), /inspect the controls/);
  assert.match(o.text(), /review them before committing/);
});
