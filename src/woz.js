// ponytail: phase 0 Wizard-of-Oz experiment only (framework-aware spec §5) — local,
// never shipped; delete this file and its call site after the runs.
import { readFileSync } from 'node:fs';

/**
 * Hand-written text to append to a cor_inspect reply. COR_WOZ_FILE names a JSON
 * array of { match, text }: an entry applies when `match` (a string, or a list of alternatives) occurs in the element's
 * template (`params`, present in every framework mode) or in the reply. Re-read on
 * every call so edits apply mid-run.
 */
export function wozNotes(reply, params) {
  const file = process.env.COR_WOZ_FILE;
  if (!file) return '';
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  const haystack = `${JSON.stringify(params ?? null)}\n${reply}`;
  return entries.filter((e) => [].concat(e.match).some((m) => haystack.includes(m))).map((e) => `\n\n${e.text}`).join('');
}
