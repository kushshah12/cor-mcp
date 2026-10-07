// U8: one committed record per issued entry, under <project>/.cor/records/<id>.json — what a heal (U12) reads on any
// machine that has the repo. P8a: an entry is pending (.cor/pending/<id>.json, git-ignored) until cor_check finds its id
// in code and promotes it; a page's reach and states are in .cor/pages/<page>.json. A record holds the page (origin + path, masked), the element's fingerprint and up to 12
// ranked strategies as data ({ kind, value }), masked (src/redact.js). It holds no ready-to-paste code,
// and COR never puts a record's contents in a reply: records are COR's, not advice for the agent (README).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageKey, redactFingerprint, redactLocator, redactText } from './redact.js';

export const RECORD_VERSION = 2; // P8a: state, kind, values, usedIn, leadsTo; version 1 is still read (state unknown)
const PENDING_DAYS = 14;
const MAX_STRATEGIES = 12;
export const ID_PATTERN = /cor:([0-9a-f]{6})\b/;
const randomId = () => randomBytes(3).toString('hex');

/** Review fix: a record's page is masked (a path can carry a token), and pages match by path, not host. */
export const recordPage = (url) => redactText(pageKey(url));
export const pathOf = (page) => { try { return new URL(page).pathname; } catch { return String(page); } };
/** P8a: a page's file name — its path (`/orders/new` → `orders-new`, `/` → `index`). */
export const pageSlug = (url) => pathOf(recordPage(url)).replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-') || 'index';
/** P8a: a state is keyed by its steps; the page as opened is `initial`. */
export const stateKey = (steps) => (steps?.length
  ? `s${createHash('sha1').update(steps.map((st) => `${st.action}:${st.id ?? ''}:${st.value ?? ''}`).join('>')).digest('hex').slice(0, 6)}` : 'initial');
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

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
  const pendingDir = () => join(root(), '.cor', 'pending');
  const pagesDir = () => join(root(), '.cor', 'pages');
  const fileOf = (id) => join(dir(), `${id}.json`);
  const pendingOf = (id) => join(pendingDir(), `${id}.json`);
  const store = { issue, link, read, list, listPending, isPlaced, promote, demote, place, prune, liveUsedIn, readPage, listPages, recordState, recordReach, leadsTo, enabled, dir, lastError: null };

  /** A fresh id — regenerated if a record by that name already exists. */
  function issueId() {
    for (let i = 0; i < 20; i++) {
      const id = newId();
      if (!enabled || (!existsSync(fileOf(id)) && !existsSync(pendingOf(id)))) return id;
    }
    throw new Error('could not find a free record id in .cor/records/');
  }

  const ids = (d) => { try { return readdirSync(d).filter((n) => /^[0-9a-f]{6}\.json$/.test(n)).map((n) => n.slice(0, -5)); } catch { return []; } };
  /** Every placed record id in the project (P8a: pending entries are not listed). */
  function list() { return ids(dir()); }
  function listPending() { return ids(pendingDir()); }
  function isPlaced(id) { return existsSync(fileOf(id)); }

  /**
   * The id already recorded for this element: same page path, same position, same member, same identity (tag and
   * text). Review fix: a position alone is not identity — saucedemo's Add to cart button turns into Remove in place,
   * and reusing by position made two different entries share one id.
   */
  function existing({ page, elementKey, member, fingerprint }) {
    // ponytail: a linear scan per inspect; an index file if a project ever holds thousands of records.
    for (const id of [...list(), ...listPending()]) {
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
  function issue({ url, fingerprint, elementKey = null, member = null, strategies, declined = null, state = 'initial', kind = 'single', values = null, cell = null }) {
    store.lastError = null;
    const page = recordPage(url);
    const id = (enabled && elementKey && existing({ page, elementKey, member, fingerprint })) || issueId();
    if (!enabled) return id;
    try {
      const placed = isPlaced(id);
      const before = read(id);
      // P8a: an element already seen in an earlier state of this visit keeps it — the steps since then did not reveal it
      // (b14ddae4: the plan-type toggle, on the page as opened, was re-recorded three clicks deep).
      const stepsOf = (key) => (key === 'initial' ? [] : readPage(page)?.states?.[key]?.steps);
      const was = before?.state != null && pathOf(before.page) === pathOf(page) ? stepsOf(before.state) : null;
      const steps = stepsOf(state);
      if (was && steps && was.length <= steps.length && JSON.stringify(steps.slice(0, was.length)) === JSON.stringify(was)) state = before.state;
      const record = {
        v: RECORD_VERSION,
        id,
        page,
        elementKey,
        member,
        // P8a: where the element lives (the page as opened, or a state reached by steps), what it is, and who uses it.
        state,
        kind,
        ...(values?.length ? { values } : {}),
        ...(cell ? { cell: Object.fromEntries(Object.entries(cell).map(([k, v]) => [k, redactText(v)])) } : {}), // P8b: the cell's row and column, to verify it at
        fingerprint: redactFingerprint(fingerprint),
        strategies: strategies.slice(0, MAX_STRATEGIES).map((s) => ({ kind: s.kind, value: redactLocator(s.value) })),
        created: before?.created ?? new Date(now()).toISOString().slice(0, 10),
        // P1: a decline id — COR found no locator that passes the shared check; cor_check reports it as declined, cited.
        ...(declined ? { declined } : {}),
        ...(before?.usedIn ? { usedIn: before.usedIn } : {}),
        ...(before?.leadsTo ? { leadsTo: before.leadsTo } : {}),
      };
      write(record, placed);
    } catch (error) {
      store.lastError = error.message;
    }
    return id;
  }

  /** A record into records/ (placed) or pending/ — pending is git-ignored: an entry nobody placed never reaches a commit. */
  function write(record, placed) {
    if (placed) {
      mkdirSync(dir(), { recursive: true });
      writeAtomic(fileOf(record.id), `${JSON.stringify(record, null, 2)}\n`);
      return;
    }
    mkdirSync(pendingDir(), { recursive: true });
    const ignore = join(pendingDir(), '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '# COR: entries shown but not yet placed in code — cor_check promotes them to ../records/\n*\n');
    writeAtomic(pendingOf(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** P8a: a pending entry whose id is in code becomes a record, with every element its state and its page's reach replay. */
  function promote(id, seen = new Set()) {
    if (!enabled || seen.has(id)) return;
    seen.add(id);
    const r = read(id);
    if (!r) return;
    if (!isPlaced(id)) {
      write(r, true);
      try { unlinkSync(pendingOf(id)); } catch { /* gone */ }
    }
    const page = readPage(r.page);
    const steps = [...(page?.reach?.steps ?? []), ...(page?.states?.[r.state]?.steps ?? [])];
    for (const st of steps) if (st.id) promote(st.id, seen);
  }

  /** P8a: a placed record no code uses goes back to pending (cor_check all: true — it saw every file). */
  function demote(id) {
    const r = isPlaced(id) ? read(id) : null;
    if (!r) return;
    const { usedIn: _, ...rest } = r;
    write(rest, false);
    unlinkSync(fileOf(id));
  }

  /** P8a: the code locations that use an id — those in the scanned files are replaced, the rest kept. */
  function place(id, found, scanned) {
    const r = read(id);
    if (!r || !enabled) return;
    const usedIn = [...(r.usedIn ?? []).filter((u) => !scanned.has(u.file)), ...found].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    if (JSON.stringify(usedIn) === JSON.stringify(r.usedIn ?? [])) return;
    write({ ...r, usedIn }, isPlaced(id));
  }

  /** P8b (run 6efb7196): the code locations that still hold the id — a deleted or rewritten file is not "in your code". */
  function liveUsedIn(record) {
    return (record.usedIn ?? []).filter((u) => { try { return readFileSync(join(root(), u.file), 'utf8').includes(`cor:${record.id}`); } catch { return false; } });
  }

  /** P8a: pending entries older than PENDING_DAYS are deleted — unless a placed element's steps need them (they were promoted). */
  function prune() {
    const cutoff = new Date(now() - PENDING_DAYS * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const id of listPending()) {
      const r = readJson(pendingOf(id));
      if (r?.created && r.created < cutoff) { try { unlinkSync(pendingOf(id)); removed++; } catch { /* gone */ } }
    }
    return removed;
  }

  // ── P8a: page files — how a page is reached and the states inside it ──
  const pageFile = (url) => join(pagesDir(), `${pageSlug(url)}.json`);
  function readPage(url) { return readJson(pageFile(url)); }
  /** P8b: every recorded page, by its file name (a reach's `from`). */
  function listPages() {
    const pages = {};
    try { for (const n of readdirSync(pagesDir())) if (n.endsWith('.json')) { const p = readJson(join(pagesDir(), n)); if (p) pages[n.slice(0, -5)] = p; } } catch { /* none yet */ }
    return pages;
  }
  function writePage(url, update) {
    if (!enabled) return;
    try {
      const page = readPage(url) ?? { v: 1, page: recordPage(url), reach: { open: pathOf(recordPage(url)) }, states: {} };
      update(page);
      mkdirSync(pagesDir(), { recursive: true });
      writeAtomic(pageFile(url), `${JSON.stringify(page, null, 2)}\n`);
    } catch (error) {
      store.lastError = error.message;
    }
  }
  /** The state a list of steps reaches on this page, recorded once; returns its key. */
  function recordState(url, steps) {
    const key = stateKey(steps);
    if (key !== 'initial' && !readPage(url)?.states?.[key]) writePage(url, (p) => { p.states[key] = { steps }; });
    return key;
  }
  /** A page reached from another page by steps — the first way it was reached is kept. */
  function recordReach(url, from, steps) {
    if (readPage(url)?.reach?.from) return;
    writePage(url, (p) => { p.reach = { from: pageSlug(from), steps }; });
  }
  /** The control that led to another page. */
  function leadsTo(id, url) {
    const r = read(id);
    if (!r || !enabled || r.leadsTo === pageSlug(url)) return;
    try { write({ ...r, leadsTo: pageSlug(url) }, isPlaced(id)); } catch (error) { store.lastError = error.message; }
  }

  /** U8 (R42): JSON stores cannot hold a comment, so `file#key → id` lives in COR's own sidecar, never in the team's map. */
  function link(fileKey, id) {
    if (!enabled) return;
    const file = join(root(), '.cor', 'ids.json');
    // P6: two COR sessions on one repo read, change and write this file — under a lock, so neither loses the other's ids.
    try { mkdirSync(join(root(), '.cor'), { recursive: true }); } catch { /* reported by the write below */ }
    const release = lock(`${file}.lock`);
    if (!release) { store.lastError = '.cor/ids.json is locked by another COR session — not changed'; return; }
    try { linkLocked(file, fileKey, id); } finally { release(); }
  }

  function linkLocked(file, fileKey, id) {
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

  /**
   * P6: a directory lock (mkdir is atomic on every filesystem COR runs on). Waits up to 2 s; a lock older than 10 s is a
   * crashed session's and is taken over. Returns the release function, or null when it could not be had.
   */
  function lock(path) {
    const until = Date.now() + 2000;
    for (;;) {
      try { mkdirSync(path); return () => { try { rmdirSync(path); } catch { /* gone */ } }; } catch (error) {
        if (error.code !== 'EEXIST') return null;
        try { if (Date.now() - statSync(path).mtimeMs > 10_000) { rmdirSync(path); continue; } } catch { continue; }
        if (Date.now() > until) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // ponytail: a 10 ms sleep; link() is synchronous
      }
    }
  }

  /** A record COR can read — placed, else pending; version 1 or 2, with a fingerprint and strategies — else null. */
  function read(id) {
    const r = readJson(fileOf(id)) ?? readJson(pendingOf(id));
    if (!(r && (r.v === 1 || r.v === RECORD_VERSION) && r.fingerprint && Array.isArray(r.strategies))) return null;
    return r.v === 1 ? { ...r, state: null } : r; // P8a: a version-1 record's state is unknown
  }

  return store;
}
