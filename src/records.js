// U8: one committed record per issued entry, under <project>/.cor/records/<id>.json — what a heal (U12) reads on any
// machine that has the repo. A record holds the page (origin + path), the element's fingerprint and up to 12 ranked
// strategies as data ({ kind, value }), masked like the old fingerprint store. It holds no ready-to-paste code, and
// COR never puts a record's contents in a reply: records are COR's, not advice for the agent (README).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageKey, redactFingerprint, redactLocator } from './fingerprints.js';

export const RECORD_VERSION = 1;
const MAX_STRATEGIES = 12;
export const ID_PATTERN = /cor:([0-9a-f]{6})\b/;
const randomId = () => randomBytes(3).toString('hex');

const writeAtomic = (file, body) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
};

/**
 * @param {{ root: () => string, enabled?: boolean, newId?: () => string, now?: () => number }} options
 * `root` is a function: the project root is known only once the session has detected the project.
 */
export function createRecordStore({ root, enabled = true, newId = randomId, now = Date.now }) {
  const dir = () => join(root(), '.cor', 'records');
  const fileOf = (id) => join(dir(), `${id}.json`);

  /** A fresh id — regenerated if a record by that name already exists. */
  function issueId() {
    for (let i = 0; i < 20; i++) {
      const id = newId();
      if (!enabled || !existsSync(fileOf(id))) return id;
    }
    throw new Error('could not find a free record id in .cor/records/');
  }

  /** The id already recorded for this element on this page — a re-inspect reuses it, so records do not pile up. */
  function existing(page, elementKey) {
    let names = [];
    try { names = readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return null; }
    // ponytail: a linear scan per inspect; an index file if a project ever holds thousands of records.
    for (const name of names) {
      const r = read(name.slice(0, -5));
      if (r && r.page === page && r.elementKey === elementKey) return r.id;
    }
    return null;
  }

  /** Write the record for a just-issued entry. Returns the id; with capture off, an id and nothing written. */
  function issue({ url, fingerprint, elementKey = null, strategies }) {
    const id = (enabled && elementKey && existing(pageKey(url), elementKey)) || issueId();
    if (!enabled) return id;
    mkdirSync(dir(), { recursive: true });
    const record = {
      v: RECORD_VERSION,
      id,
      page: pageKey(url),
      elementKey,
      fingerprint: redactFingerprint(fingerprint),
      strategies: strategies.slice(0, MAX_STRATEGIES).map((s) => ({ kind: s.kind, value: redactLocator(s.value) })),
      created: new Date(now()).toISOString().slice(0, 10),
    };
    writeAtomic(fileOf(id), `${JSON.stringify(record, null, 2)}\n`);
    return id;
  }

  /** U8 (R42): JSON stores cannot hold a comment, so `file#key → id` lives in COR's own sidecar, never in the team's map. */
  function link(fileKey, id) {
    if (!enabled) return;
    mkdirSync(join(root(), '.cor'), { recursive: true });
    const file = join(root(), '.cor', 'ids.json');
    let ids = {};
    try { ids = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new */ }
    ids[fileKey] = id;
    writeAtomic(file, `${JSON.stringify(Object.fromEntries(Object.entries(ids).sort()), null, 2)}\n`);
  }

  function read(id) {
    try { return JSON.parse(readFileSync(fileOf(id), 'utf8')); } catch { return null; }
  }

  return { issue, link, read, enabled, dir };
}
