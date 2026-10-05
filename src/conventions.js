// U7: where and how a team keeps its locators — read from the repo, overridden by the project's cor.config.js.
// COR writes nothing here; the entries it returns (U8) target what this finds, and cor_open says what it found.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

export const STORES = ['page-object-class', 'constants', 'json', 'yaml'];
const ORDERS = ['framework', 'testid-first'];
const FRAMEWORKS = ['playwright', 'webdriverio', 'cypress'];
const LABEL = { 'page-object-class': 'page objects', constants: 'locator constants', json: 'a JSON locator map', yaml: 'a YAML locator map' };
const DEFAULT_DIR = { playwright: 'tests/pages', webdriverio: 'test/pageobjects', cypress: 'cypress/pages' };

const MAX_SPECS = 20; // spec files read, per N3 of the framework spec
const MAX_DEPTH = 5;
const MAX_DIRS = 400; // ponytail: a cap on folders visited; a huge repo is sampled, not walked
const SPEC = /\.(spec|test|cy)\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cor']);
const IMPORT = /(?:import\s[^'"]*?from\s*|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const CODE_EXT = ['', '.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

const posix = (p) => p.split(sep).join('/');
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * The project's cor.config.js — the same file @corlabs/client reads (`framework` at the top level, as the SDK has it;
 * the MCP's settings under `locators`). It is the team's own module, imported as the SDK imports it. ESM first; a
 * CommonJS file (what `cor init` writes) through require. A missing file is the normal case.
 * @returns {Promise<{ raw: object|null, problem: string|null }>}
 */
export async function loadCorConfig(root) {
  const file = join(root, 'cor.config.js');
  if (!existsSync(file)) return { raw: null, problem: null };
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`);
    return { raw: mod.default ?? mod, problem: null };
  } catch (esmError) {
    try {
      return { raw: createRequire(file)(file), problem: null };
    } catch {
      return { raw: null, problem: `cor.config.js could not be loaded (${esmError.message.split('\n')[0]}) — ignored` };
    }
  }
}

/** The settings COR uses from cor.config.js: only known keys with valid values; anything else is reported, not used. */
export function readConfig(raw) {
  const config = {};
  const problems = [];
  if (!raw || typeof raw !== 'object') return { config, problems };
  const take = (key, value, ok, where) => {
    if (value === undefined) return;
    if (ok(value)) config[key] = value;
    else problems.push(`cor.config.js ${where}: ${JSON.stringify(value)} is not one of the accepted values — ignored`);
  };
  take('framework', raw.framework, (v) => FRAMEWORKS.includes(v), 'framework');
  const l = raw.locators ?? {};
  take('order', l.order, (v) => ORDERS.includes(v), 'locators.order');
  take('testIdAttribute', l.testIdAttribute, (v) => typeof v === 'string' && /^[\w:.-]+$/.test(v), 'locators.testIdAttribute');
  take('store', l.store, (v) => STORES.includes(v), 'locators.store');
  take('storeDir', l.storeDir, (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('/') && !v.includes('..'), 'locators.storeDir');
  // Review fix: './locators/' and 'locators' are the same folder — entries, the sidecar and cor_check compare it as text.
  if (config.storeDir) config.storeDir = config.storeDir.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
  return { config, problems };
}

function specFiles(root) {
  const out = [];
  // Only inside a project: with no package.json at the root (a home folder, `/`), there is nothing to infer from.
  if (!existsSync(join(root, 'package.json'))) return out;
  let dirs = 0;
  const walk = (dir, depth) => {
    if (out.length >= MAX_SPECS || depth > MAX_DEPTH || ++dirs > MAX_DIRS) return;
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_SPECS) return;
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (SPEC.test(name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/** What one imported file is, as a locator store — or null when it is not one. */
function storeOf(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  const src = readText(file);
  if (!src) return null;
  const locatorish = /\b(page\.(locator|getBy\w+)|cy\.get|cy\.contains|\$\$?\(|By\.\w+)/.test(src) || /['"`](\[data-[\w-]+=|#[\w-]+|\.[\w-]+|\/\/\w)/.test(src);
  if (!locatorish) return null;
  if (/\bclass\s+\w+/.test(src)) return 'page-object-class';
  return 'constants';
}

const resolveImport = (from, spec) => {
  for (const ext of CODE_EXT) {
    const full = resolve(dirname(from), spec + ext);
    try { if (statSync(full).isFile()) return full; } catch { /* next */ }
  }
  return null;
};

/** The store shapes and folders the specs import from, most-used first. */
export function inferStore(root) {
  const tally = new Map();
  const specs = specFiles(root);
  for (const spec of specs) {
    const src = readText(spec) ?? '';
    for (const [, path] of src.matchAll(IMPORT)) {
      const target = resolveImport(spec, path);
      const store = target && storeOf(target);
      if (!store) continue;
      const key = `${store}|${posix(relative(root, dirname(target))) || '.'}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const found = [...tally].sort((a, b) => b[1] - a[1]).map(([key, imports]) => {
    const [store, dir] = key.split('|');
    return { store, dir, imports };
  });
  return { specs: specs.length, found };
}

/**
 * The conventions COR follows: config first, then what the repo shows, then defaults — each value with where it came
 * from, so cor_open can say so.
 */
export function resolveConventions(root, detectedFramework, loaded = { raw: null, problem: null }) {
  const { config, problems } = readConfig(loaded.raw);
  if (loaded.problem) problems.push(loaded.problem);
  const { specs, found } = inferStore(root);
  const framework = config.framework ?? detectedFramework ?? 'playwright';
  const top = found[0];
  return {
    framework: { value: framework, from: config.framework ? 'cor.config.js' : detectedFramework ? 'detected' : 'default' },
    order: { value: config.order ?? 'framework', from: config.order ? 'cor.config.js' : 'default' },
    testIdAttribute: config.testIdAttribute ? { value: config.testIdAttribute, from: 'cor.config.js' } : null,
    store: config.store
      ? { value: config.store, from: 'cor.config.js' }
      : top ? { value: top.store, from: `inferred from ${top.imports} spec import${top.imports === 1 ? '' : 's'}` } : { value: 'page-object-class', from: specs ? 'default — no spec imports a locator file' : 'default — no specs found' },
    storeDir: config.storeDir
      ? { value: config.storeDir, from: 'cor.config.js' }
      : top ? { value: top.dir, from: 'inferred' } : { value: DEFAULT_DIR[framework], from: 'default' },
    others: config.store ? [] : found.slice(1).filter((f) => f.store !== top.store || f.dir !== top.dir),
    problems,
  };
}

/** The lines cor_open adds (at most 4): where locators go, any other store in use, the order, config problems. */
export function conventionsLines(c) {
  const lines = [`Locators: ${LABEL[c.store.value]} in ${c.storeDir.value}/ (${c.store.from}).`];
  if (c.others.length) lines.push(`Also in use: ${c.others.slice(0, 2).map((o) => `${LABEL[o.store]} in ${o.dir}/ (${o.imports})`).join('; ')} — COR follows the most-used; set locators.store in cor.config.js to choose.`);
  if (c.order.value === 'testid-first') lines.push('Order: test id first (cor.config.js) — then id, name, stable attribute, class, text.');
  if (c.problems.length) lines.push(c.problems.join('; '));
  return lines.slice(0, 4);
}
