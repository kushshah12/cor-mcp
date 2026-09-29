// ponytail: phase 0 Wizard-of-Oz experiment only (framework-aware spec §5) — this branch
// is never merged; delete this file, woz/ and the call site after the runs.
import { existsSync, readFileSync } from 'node:fs';

const FILES = { webdriverio: 'woz-webdriverio.json', cypress: 'woz-cypress.json' };

/**
 * The project's test framework, as the end user has it: the `framework` argument when
 * the agent passed one, else the package.json in the directory the agent runs in.
 */
export function wozFramework(framework, cwd = process.cwd()) {
  if (FILES[framework]) return framework;
  const pkg = `${cwd}/package.json`;
  if (!existsSync(pkg)) return null;
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(pkg, 'utf8'));
  const deps = { ...dependencies, ...devDependencies };
  if (deps['@wdio/cli'] || deps.webdriverio) return 'webdriverio';
  if (deps.cypress) return 'cypress';
  return null;
}

/**
 * Hand-written helpers to append to a cor_inspect reply. The file is the one shipped for
 * the project's framework (woz/), or COR_WOZ_FILE when set: a JSON array of
 * { match, text }. An entry applies when `match` (a string, or a list of alternatives)
 * occurs in the element's template (`params`, present in every framework mode) or in the
 * reply. Read on every call so edits apply mid-run.
 */
export function wozNotes(reply, params, framework) {
  const fw = wozFramework(framework);
  const file = process.env.COR_WOZ_FILE || (fw && new URL(`../woz/${FILES[fw]}`, import.meta.url));
  if (!file) return '';
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  const haystack = `${JSON.stringify(params ?? null)}\n${reply}`;
  return entries.filter((e) => [].concat(e.match).some((m) => haystack.includes(m))).map((e) => `\n\n${e.text}`).join('');
}
