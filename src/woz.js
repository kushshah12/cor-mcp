// ponytail: phase 0 Wizard-of-Oz experiment only (framework-aware spec §5) — local,
// never shipped; delete this file and its call site after the runs.
import { readFileSync } from 'node:fs';

/**
 * Hand-written text to append to a cor_inspect reply. COR_WOZ_FILE names a JSON
 * array of { match, text }: an entry applies when `match` occurs in the reply
 * (the template's item selector). Re-read on every call so edits apply mid-run.
 */
export function wozNotes(reply) {
  const file = process.env.COR_WOZ_FILE;
  if (!file) return '';
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  return entries.filter((e) => reply.includes(e.match)).map((e) => `\n\n${e.text}`).join('');
}
