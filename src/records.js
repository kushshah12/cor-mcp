// U8: one committed record per issued entry, under <project>/.cor/records/<id>.json — what a heal (U12) reads on any
// machine that has the repo. A record holds the page (origin + path, masked), the element's fingerprint and up to 12
// ranked strategies as data ({ kind, value }), masked (src/redact.js). It holds no ready-to-paste code,
// and COR never puts a record's contents in a reply: records are COR's, not advice for the agent (README).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageKey, redactFingerprint, redactLocator, redactText } from './redact.js';

export const RECORD_VERSION = 1;
const MAX_STRATEGIES = 12;
export const ID_PATTERN = /cor:([0-9a-f]{6})\b/;
const randomId = () => randomBytes(3).toString('hex');

/** Review fix: a record's page is masked (a path can carry a token), and pages match by path, not host. */
export const recordPage = (url) => redactText(pageKey(url));
export const pathOf = (page) => { try { return new URL(page).pathname; } catch { return String(page); } };

const writeAtomic = (file, body) => {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw error;
  }
};

/**
 * @param {{ root: () => string, enabled?: boolean, newId?: () => string, now?: () => number }} options
 * `root` is a function: the project root is known only once the session has detected the project.
 */
export function createRecordStore({ root, enabled = true, newId = randomId, now = Date.now }) {
  const dir = () => join(root(), '.cor', 'records');
  const fileOf = (id) => join(dir(), `${id}.json`);
  const store = { issue, link, read, list, enabled, dir, lastError: null };

  /** A fresh id — regenerated if a record by that name already exists. */
  function issueId() {
    for (let i = 0; i < 20; i++) {
      const id = newId();
      if (!enabled || !existsSync(fileOf(id))) return id;
    }
    throw new Error('could not find a free record id in .cor/records/');
  }

  /** Every record id in the project. */
  function list() {
    try { return readdirSync(dir()).filter((n) => /^[0-9a-f]{6}\.json$/.test(n)).map((n) => n.slice(0, -5)); } catch { return []; }
  }

  /**
   * The id already recorded for this element: same page path, same position, same member, same identity (tag and
   * text). Review fix: a position alone is not identity — saucedemo's Add to cart button turns into Remove in place,
   * and reusing by position made two different entries share one id.
   */
  function existing({ page, elementKey, member, fingerprint }) {
    // ponytail: a linear scan per inspect; an index file if a project ever holds thousands of records.
    for (const id of list()) {
      const r = read(id);
      if (r && pathOf(r.page) === pathOf(page) && r.elementKey === elementKey && r.member === member
        && r.fingerprint?.tag === fingerprint.tag && (r.fingerprint?.text ?? null) === (redactFingerprint(fingerprint).text ?? null)) return r.id;
    }
    return null;
  }

  /**
   * Write the record for a just-issued entry. Returns the id; with capture off, an id and nothing written. A failed
   * write never fails the inspect: the id is returned and `lastError` says why the record is missing.
   */
  function issue({ url, fingerprint, elementKey = null, member = null, strategies }) {
    store.lastError = null;
    const page = recordPage(url);
    const id = (enabled && elementKey && existing({ page, elementKey, member, fingerprint })) || issueId();
    if (!enabled) return id;
    try {
      mkdirSync(dir(), { recursive: true });
      const record = {
        v: RECORD_VERSION,
        id,
        page,
        elementKey,
        member,
        fingerprint: redactFingerprint(fingerprint),
        strategies: strategies.slice(0, MAX_STRATEGIES).map((s) => ({ kind: s.kind, value: redactLocator(s.value) })),
        created: new Date(now()).toISOString().slice(0, 10),
      };
      writeAtomic(fileOf(id), `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      store.lastError = error.message;
    }
    return id;
  }

  /** U8 (R42): JSON stores cannot hold a comment, so `file#key → id` lives in COR's own sidecar, never in the team's map. */
  function link(fileKey, id) {
    if (!enabled) return;
    const file = join(root(), '.cor', 'ids.json');
    let ids = {};
    try {
      ids = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      // Review fix: only a missing file is "new" — a corrupt or unreadable one is never overwritten.
      if (error.code !== 'ENOENT') { store.lastError = `.cor/ids.json is unreadable (${error.message}) — not changed`; return; }
    }
    try {
      mkdirSync(join(root(), '.cor'), { recursive: true });
      ids[fileKey] = id;
      writeAtomic(file, `${JSON.stringify(Object.fromEntries(Object.entries(ids).sort()), null, 2)}\n`);
    } catch (error) {
      store.lastError = error.message;
    }
  }

  /** A record COR can read: this format version, with a fingerprint and strategies — else null. */
  function read(id) {
    try {
      const r = JSON.parse(readFileSync(fileOf(id), 'utf8'));
      return r?.v === RECORD_VERSION && r.fingerprint && Array.isArray(r.strategies) ? r : null;
    } catch {
      return null;
    }
  }

  return store;
}
