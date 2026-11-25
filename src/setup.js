// U2/U3 (plan 2026-11-24-002): `npx @corlabsdev/mcp setup` — add COR to the agent clients found here, with consent.
// Writes only agent client config files (R11). Never deletes a server entry; Playwright MCP is switched off only where
// the client has an off switch (Claude Code) and only on an explicit yes. Sends no telemetry.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { normalizeSource } from './telemetry.js';

const COR = '@corlabsdev/mcp';
const PLAYWRIGHT = '@playwright/mcp';
const README = 'https://github.com/kushshah12/cor-mcp#readme';
export const FIRST_PROMPT = 'Open <your app URL> with COR and inspect the controls on the page.';

export const CLIENTS = [
  { id: 'claude', label: 'Claude Code', key: 'mcpServers', file: ({ cwd }) => join(cwd, '.mcp.json'), marks: ({ cwd }) => [join(cwd, '.mcp.json'), join(cwd, '.claude')] },
  { id: 'cursor', label: 'Cursor', key: 'mcpServers', file: ({ cwd }) => join(cwd, '.cursor', 'mcp.json'), marks: ({ cwd }) => [join(cwd, '.cursor')] },
  { id: 'vscode', label: 'VS Code', key: 'servers', file: ({ cwd }) => join(cwd, '.vscode', 'mcp.json'), marks: ({ cwd }) => [join(cwd, '.vscode')] },
  { id: 'codex', label: 'Codex', toml: true, file: ({ home }) => join(home, '.codex', 'config.toml'), marks: ({ home }) => [join(home, '.codex')] },
];

export function entryArgs(version, source) {
  return ['-y', `${COR}@${version}`, '--source', normalizeSource(source) === 'unknown' ? 'setup' : normalizeSource(source)];
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.cor-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** What a client's config holds today: { configured, playwright: [names], error? } and the parsed form for writing. */
export function inspectClient(client, paths) {
  const file = client.file(paths);
  const text = readText(file);
  if (client.toml) {
    // ponytail: line scan, not a TOML parser. Tables are tracked by their [mcp_servers.<name>…] header; comments ignored.
    let table = null;
    let configured = false;
    const playwright = new Set();
    for (const line of (text ?? '').split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      const header = t.match(/^\[\s*mcp_servers\.("?)([^".\]]+)\1/);
      if (header) table = header[2];
      else if (t.startsWith('[')) table = null;
      if (!table) continue;
      if (t.includes(COR)) configured = true;
      if (t.includes(PLAYWRIGHT)) playwright.add(table);
    }
    return { file, text: text ?? '', configured, playwright: [...playwright] };
  }
  let config = {};
  if (text !== null && text.trim()) {
    try {
      config = JSON.parse(text);
    } catch {
      return { file, error: 'could not parse it (comments or invalid JSON), so it was left alone' };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { file, error: 'it is not a JSON object, so it was left alone' };
  }
  const servers = config[client.key] && typeof config[client.key] === 'object' ? config[client.key] : {};
  const mentions = (s, pkg) => [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].some((v) => typeof v === 'string' && v.includes(pkg));
  return {
    file,
    config,
    configured: Object.values(servers).some((s) => mentions(s, COR)),
    playwright: Object.entries(servers).filter(([, s]) => mentions(s, PLAYWRIGHT)).map(([n]) => n),
  };
}

export function addCor(client, state, args) {
  if (client.toml) {
    const quoted = args.map((a) => JSON.stringify(a)).join(', ');
    const sep = state.text && !state.text.endsWith('\n') ? '\n' : '';
    writeAtomic(state.file, `${state.text}${sep}${state.text ? '\n' : ''}[mcp_servers.cor]\ncommand = "npx"\nargs = [${quoted}]\n`);
    return;
  }
  const entry = client.id === 'vscode' ? { type: 'stdio', command: 'npx', args } : { command: 'npx', args };
  const config = { ...state.config, [client.key]: { ...(state.config[client.key] ?? {}), cor: entry } };
  writeAtomic(state.file, `${JSON.stringify(config, null, 2)}\n`);
}

/** U3: Claude Code's own off switch. The entry stays in .mcp.json; re-enable it from /mcp. Returns an error string or null. */
export function disablePlaywright(cwd, names) {
  const file = join(cwd, '.claude', 'settings.local.json');
  const text = readText(file);
  let settings = {};
  if (text !== null && text.trim()) {
    try {
      settings = JSON.parse(text);
    } catch {
      return `could not parse ${relative(cwd, file)}, so Playwright MCP was left on`;
    }
  }
  const list = new Set([...(Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers : []), ...names]);
  writeAtomic(file, `${JSON.stringify({ ...settings, disabledMcpjsonServers: [...list] }, null, 2)}\n`);
  return null;
}

export function manualSetup(version) {
  const args = JSON.stringify(entryArgs(version, 'readme'));
  return [
    `Claude Code  .mcp.json            {"mcpServers": {"cor": {"command": "npx", "args": ${args}}}}`,
    `Cursor       .cursor/mcp.json     {"mcpServers": {"cor": {"command": "npx", "args": ${args}}}}`,
    `VS Code      .vscode/mcp.json     {"servers": {"cor": {"type": "stdio", "command": "npx", "args": ${args}}}}`,
    `Codex        ~/.codex/config.toml [mcp_servers.cor] command = "npx" args = ${args}`,
    `More: ${README}`,
  ].join('\n');
}

function yesNo(answer, fallback) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (!a) return fallback;
  return a === 'y' || a === 'yes';
}

/**
 * Run setup. `ask(question)` returns the user's answer; it is null when nobody can answer (no TTY), and then only
 * `--yes` lets COR entries be written. Playwright is never switched off without a typed yes.
 */
export async function runSetup({ yes = false, source, version, cwd = process.cwd(), home = homedir(), stdin = process.stdin, stdout = process.stdout, ask } = {}) {
  const say = (line = '') => stdout.write(`${line}\n`);
  let rl = null;
  if (!ask && stdin.isTTY) {
    rl = createInterface({ input: stdin, output: stdout });
    ask = (q) => rl.question(q);
  }
  try {
    const paths = { cwd, home };
    const found = CLIENTS.filter((c) => c.marks(paths).some((p) => existsSync(p)));
    if (!found.length) {
      say('No supported agent client found here (Claude Code, Cursor, VS Code, Codex). Nothing was written.');
      say('Add COR by hand:');
      say(manualSetup(version));
      return { written: [] };
    }
    if (!ask && !yes) {
      say(`Found: ${found.map((c) => c.label).join(', ')}. Nothing was written: run in a terminal to confirm, or rerun with --yes.`);
      return { written: [] };
    }
    const args = entryArgs(version, source);
    const written = [];
    for (const client of found) {
      const state = inspectClient(client, paths);
      const where = client.toml ? '~/.codex/config.toml' : relative(cwd, state.file);
      if (state.error) {
        say(`${client.label}: skipped ${where}: ${state.error}.`);
        continue;
      }
      if (state.configured) {
        say(`${client.label}: COR is already set up in ${where}. No change.`);
        continue;
      }
      const add = yes || yesNo(await ask(`Add COR to ${client.label} (${where})? [Y/n] `), true);
      if (!add) {
        say(`${client.label}: skipped.`);
        continue;
      }
      addCor(client, state, args);
      written.push(client.id);
      say(`${client.label}: added COR to ${where}.`);
      if (!state.playwright.length) continue;
      const names = state.playwright.join(', ');
      if (client.id === 'claude' && ask) {
        const off = yesNo(await ask(`Playwright MCP (${names}) is also set up. Two browser tools make the agent pick between them. Switch Playwright MCP off for this project? It stays in .mcp.json and can be turned back on from /mcp. [y/N] `), false);
        if (off) {
          const err = disablePlaywright(cwd, state.playwright);
          say(err ? `${client.label}: ${err}.` : `${client.label}: Playwright MCP switched off in .claude/settings.local.json.`);
          continue;
        }
      }
      say(`${client.label}: warning: Playwright MCP (${names}) is still on next to COR. The agent may use it instead; turn it off in ${client.label}'s MCP settings to use COR alone.`);
    }
    if (written.length) {
      say();
      say('Project config files are shared with your team: review them before committing.');
      say(`Restart your agent, then try: "${FIRST_PROMPT}"`);
    }
    return { written };
  } finally {
    rl?.close();
  }
}
