// P3a: the idiom tables and what is known about them (spec §7.2, §8, §10).
// A renderer emits only idioms in its own table (R1); a template it cannot say falls back to facts plus a single-element locator.
import { readFileSync } from 'node:fs';
import * as webdriverio from './webdriverio.js';
import * as cypress from './cypress.js';

const TABLES = { webdriverio, cypress };

/** The recorded conformance run for a framework, or null (§10: `<framework>.conformance.json`). */
function conformanceOf(framework) {
  try {
    return JSON.parse(readFileSync(new URL(`./${framework}.conformance.json`, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Render the parameterised helper for a framework from the checked model.
 * `level` is 'L2' only when every idiom used passed its conformance run on this framework major; otherwise 'L3' (§10).
 * @returns {{ code: string, define: string, uses: string[], idioms: string[], level: 'L2'|'L3', ranOn: string|null } | { none: string }}
 */
export function renderHelper(framework, params, { typescript = false, major = null, testingLibrary = false, record = conformanceOf(framework) } = {}) {
  const table = TABLES[framework];
  if (!table || !params?.model) return { none: `no parameterised ${framework} form for this shape yet` };
  const out = table.render(params, { typescript, testingLibrary });
  if (out.none) return out;
  const passed = record?.runs?.find((r) => String(r.major) === String(major));
  const ok = passed && out.idioms.every((id) => passed.idioms?.[id]?.ok === true);
  return { ...out, level: ok ? 'L2' : 'L3', ranOn: ok ? passed.version : null };
}

export const everyItem = (framework, model) => TABLES[framework]?.every(model) ?? null;
export const idiomsOf = (framework) => TABLES[framework]?.IDIOMS ?? [];
