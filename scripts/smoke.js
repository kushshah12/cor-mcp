// Packs the package, installs the tarball into an empty folder (the way a customer gets it),
// and checks the installed server answers an MCP initialize.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'corlabs-smoke-'));
const run = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

run(['pack', '--pack-destination', tmp], pkgDir);
const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
run(['init', '-y'], tmp);
run(['install', join(tmp, tgz)], tmp);

if (existsSync(join(tmp, 'node_modules/@corlabs/engine'))) throw new Error('engine reached a customer install');
const bin = join(tmp, 'node_modules/.bin/cor-mcp');
const child = spawn(bin, ['--headless'], { stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => { child.kill(); console.error('smoke failed: no initialize reply in 20s'); process.exit(1); }, 20_000);
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  if (!out.includes('\n')) return;
  clearTimeout(timer);
  child.kill();
  const name = JSON.parse(out.split('\n')[0]).result?.serverInfo?.name;
  if (name !== '@corlabsdev/mcp') { console.error(`smoke failed: serverInfo.name = ${name}`); process.exit(1); }
  console.log(`smoke ok: ${name} answered initialize from ${tmp}`);
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) + '\n');
