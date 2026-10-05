// P1a: which test framework does this project use? Read from the nearest package.json
// (then workspace packages), never from the page. Spec §6.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const LABELS = { playwright: 'Playwright', webdriverio: 'WebdriverIO', cypress: 'Cypress' };

// Only a test runner counts: `playwright` alone (a library) is not Playwright Test.
const SIGNALS = [
  { framework: 'playwright', packages: ['@playwright/test'], testingLibrary: null },
  { framework: 'webdriverio', packages: ['@wdio/cli', 'webdriverio'], testingLibrary: '@testing-library/webdriverio' },
  { framework: 'cypress', packages: ['cypress'], testingLibrary: '@testing-library/cypress' },
];

const MAX_PACKAGES = 20; // workspace package.json files read
const MAX_DEPTH = 3; // directory levels below the workspace root
const MAX_UP = 8; // directories walked up from the working directory

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const major = (range) => /\d+/.exec(String(range ?? ''))?.[0] ?? null;

/** The frameworks one package.json declares. */
function signalsOf(dir, pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const typescript = Boolean(deps.typescript) || existsSync(join(dir, 'tsconfig.json'));
  return SIGNALS.flatMap(({ framework, packages, testingLibrary }) => {
    const via = packages.find((p) => deps[p]);
    if (!via) return [];
    return [{ framework, version: major(deps[via]), via, typescript, testingLibrary: Boolean(testingLibrary && deps[testingLibrary]), dir }];
  });
}

/** Directories a workspace pattern names: `packages/*`, `apps/**`, `e2e`. At most MAX_DEPTH levels. */
function expand(root, pattern) {
  let dirs = [root];
  const parts = pattern.replace(/^\.\//, '').split('/').filter(Boolean);
  for (const part of parts.slice(0, MAX_DEPTH)) {
    dirs = dirs.flatMap((d) => {
      if (part !== '*' && part !== '**') return [join(d, part)];
      try {
        return readdirSync(d).filter((n) => !n.startsWith('.') && n !== 'node_modules').map((n) => join(d, n)).filter((p) => statSync(p).isDirectory());
      } catch {
        return [];
      }
    });
  }
  return dirs;
}

function fromWorkspaces(root, pkg) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const found = [];
  let read = 0;
  for (const dir of patterns.flatMap((p) => expand(root, p))) {
    if (read >= MAX_PACKAGES) break;
    const child = readJson(join(dir, 'package.json'));
    if (!child) continue;
    read++;
    found.push(...signalsOf(dir, child));
  }
  return found;
}

const PW_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];

/**
 * U3 (D7): the `testIdAttribute` a project's playwright.config sets — read as text, never executed.
 * @returns {{ value: string|null, file: string, readable: boolean } | null} null when no config mentions it.
 */
export function readTestIdAttribute(dir) {
  for (const name of PW_CONFIGS) {
    let src;
    try { src = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    if (!/\btestIdAttribute\b/.test(src)) return null;
    const m = /\btestIdAttribute\s*:\s*(['"`])([\w:.-]+)\1/.exec(src);
    return { value: m ? m[2] : null, file: name, readable: Boolean(m) };
  }
  return null;
}

/**
 * @returns {{ framework: string|null, candidates: object[], ambiguous: boolean, testIdAttribute: ReturnType<typeof readTestIdAttribute> }}
 * framework is null when nothing was found or several frameworks were.
 */
export function detectFramework(cwd = process.cwd()) {
  let dir = cwd;
  for (let i = 0; i < MAX_UP; i++) {
    const pkg = readJson(join(dir, 'package.json'));
    if (pkg) {
      const found = [...signalsOf(dir, pkg), ...(pkg.workspaces ? fromWorkspaces(dir, pkg) : [])];
      // one candidate per framework: the first package that declares it
      const candidates = found.filter((c, n) => found.findIndex((o) => o.framework === c.framework) === n);
      if (candidates.length) {
        const pw = candidates.find((c) => c.framework === 'playwright');
        return { framework: candidates.length === 1 ? candidates[0].framework : null, candidates, ambiguous: candidates.length > 1, cwd, testIdAttribute: pw ? readTestIdAttribute(pw.dir) : null };
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { framework: null, candidates: [], ambiguous: false, cwd, testIdAttribute: null };
}

const describe = (c, cwd) => {
  const where = relative(cwd, join(c.dir, 'package.json')).split(sep).join('/') || 'package.json';
  const name = `${LABELS[c.framework]}${c.version ? ` v${c.version}` : ''}`;
  return { name, where: where.startsWith('..') ? join(c.dir, 'package.json') : `./${where}` };
};

/** The one line cor_open prints (spec §6.4). U2: an argument never changes it — it applies to its own call only. */
export function frameworkLine(detection) {
  const { candidates, ambiguous, cwd } = detection;
  if (ambiguous) {
    const list = candidates.map((c) => { const d = describe(c, cwd); return `${d.name} (${d.where})`; }).join(', ');
    const args = candidates.map((c) => `"${c.framework}"`).join(' or ');
    return `Framework: several found — ${list}. Rendering Playwright unless a call passes framework: ${args}.`;
  }
  if (!candidates.length) return 'Framework: no framework found — rendering Playwright. Pass framework: "…" to change.';
  const [c] = candidates;
  const d = describe(c, cwd);
  const extras = [c.typescript && 'TypeScript', c.testingLibrary && 'Testing Library'].filter(Boolean);
  const tid = detection.testIdAttribute;
  const testId = !tid ? '' : tid.readable
    ? ` getByTestId reads ${tid.value} (${tid.file}).`
    : ` testIdAttribute in ${tid.file} is not a plain string — not read; getByTestId is assumed to read data-testid.`;
  return `Framework: ${d.name}${extras.length ? ` (${extras.join(', ')})` : ''} — from ${d.where} (${c.via}). Override with framework: "…".${testId}`;
}
