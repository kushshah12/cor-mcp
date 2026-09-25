// Silent fingerprint capture: what a later heal verifies against.
//
// Every successful cor_inspect appends (or refreshes) one record in
// ~/.cor/fingerprints/<folder>-<code>.json — one file per working folder,
// kept OUTSIDE it. It used to live in <folder>/.cor/, where agents exploring
// the project read it (1,500 chars in one run) and saw stale locators as if
// they were advice. Nothing reads it yet; a future repair tool will.
// Nothing is printed — not to the tool response, not to stderr. The README
// states exactly what is stored; keep this file and that section in step.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const FORMAT_VERSION = 1;
export const RETENTION_DAYS = 90;
export const MAX_RECORDS = 5000;
const MAX_LOCATORS = 12;

// ── redaction ───────────────────────────────────────────────────────────────
// Masking, not hashing: healLocator() compares stored values with live ones as
// plain strings, so a hashed value could never match again. A masked value
// just loses that one comparison; the rest of the fingerprint still heals.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const TOKEN = /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b/g; // long mixed letters+digits
const LONG_NUMBER = /\d(?:[\d\s-]{4,}\d)/g; // 6+ digits, allowing spaces/dashes

export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(EMAIL, '[email]')
    .replace(TOKEN, '[token]')
    .replace(LONG_NUMBER, (m) => (m.replace(/\D/g, '').length >= 6 ? '[number]' : m));
}

/** A computeFingerprint() snapshot with sensitive parts masked; same shape. */
export function redactFingerprint(fp) {
  const attrs = {};
  for (const [name, value] of Object.entries(fp.attrs ?? {})) {
    // Query strings and fragments are where session tokens and ids ride.
    attrs[name] = redactText(name === 'href' ? value.split(/[?#]/)[0] : value);
  }
  return { tag: fp.tag, attrs, text: redactText(fp.text), classes: (fp.classes ?? []).map(redactText) };
}

/**
 * A locator string gets the same masking: `a[aria-label="… jane@x.com"]` or
 * `a[href="/o?token=…"]` would otherwise carry what the fingerprint dropped.
 * Masking is deterministic, so lookup() masks the locator it is asked for and
 * the original text still finds its record.
 */
export function redactLocator(value) {
  return redactText(String(value).replace(/((?:href|src|action)[~|^$*]?=\s*["']?[^"'?#\]\s]*)[?#][^"'\]]*/g, '$1'));
}

/** Origin + path only: a URL's query or fragment can carry a token. */
export function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

// ── the store ───────────────────────────────────────────────────────────────
/** The store file for a working folder: its name plus a short code of its full path, so two folders named `tests` never share a file. */
const realPath = (dir) => {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
};

export function storeFileFor(dir, home = homedir()) {
  // The real path: a folder opened through a symlink (macOS /var → /private/var)
  // is still one project with one history.
  const full = realPath(dir);
  const code = createHash('sha1').update(full).digest('hex').slice(0, 6);
  const name = (basename(full) || 'root').replace(/[^\w.-]+/g, '_');
  return join(home, '.cor', 'fingerprints', `${name}-${code}.json`);
}

/**
 * @param {{ dir?: string, home?: string, enabled?: boolean, now?: () => number }} [options]
 */
export function createFingerprintStore({ dir = process.cwd(), home = homedir(), enabled = true, now = Date.now } = {}) {
  const file = storeFileFor(dir, home);
  const folder = join(home, '.cor', 'fingerprints');
  const legacyFolder = join(dir, '.cor');
  const legacy = join(legacyFolder, 'fingerprints.json');

  /**
   * Move a store written by an earlier version out of the project, once. The
   * legacy .cor/ folder goes too, but only when nothing in it is someone
   * else's: our file and a .gitignore that lists only it.
   */
  function migrate(records) {
    if (!existsSync(legacy)) return records;
    let old = [];
    try {
      old = JSON.parse(readFileSync(legacy, 'utf8')).records ?? [];
    } catch {
      // unreadable: nothing to carry over, still remove it below
    }
    const key = (r) => `${r.page}|${r.elementKey}`;
    const merged = [...records];
    for (const r of old) if (!merged.some((m) => key(m) === key(r))) merged.push(r);
    try {
      unlinkSync(legacy);
      const ignore = join(legacyFolder, '.gitignore');
      if (existsSync(ignore) && readFileSync(ignore, 'utf8').trim() === 'fingerprints.json') unlinkSync(ignore);
      if (readdirSync(legacyFolder).length === 0) rmdirSync(legacyFolder);
    } catch {
      // a read-only project keeps its old file; the merged copy lives in the new store
    }
    return merged;
  }

  function load() {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(data.records) ? data.records : [];
    } catch {
      return []; // absent or unreadable: start over rather than fail an inspect
    }
  }

  /**
   * @param {{ url: string, elementKey: string, fingerprint: object, locators: string[] }} capture
   */
  function record({ url, elementKey, fingerprint, locators: raw }) {
    if (!enabled || !fingerprint) return;
    try {
      mkdirSync(folder, { recursive: true });
      const at = new Date(now()).toISOString();
      const page = pageKey(url);
      const cutoff = now() - RETENTION_DAYS * 86_400_000;
      const records = migrate(load()).filter((r) => Date.parse(r.lastSeen) >= cutoff);

      const existing = records.find((r) => r.page === page && r.elementKey === elementKey);
      const stored = redactFingerprint(fingerprint);
      const locators = raw.map(redactLocator);
      if (existing) {
        existing.fingerprint = stored;
        existing.locators = [...new Set([...locators, ...existing.locators])].slice(0, MAX_LOCATORS);
        existing.lastSeen = at;
      } else {
        records.push({ v: FORMAT_VERSION, page, elementKey, fingerprint: stored, locators: locators.slice(0, MAX_LOCATORS), firstSeen: at, lastSeen: at });
      }
      records.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      records.length = Math.min(records.length, MAX_RECORDS);

      // Write-then-rename, so a crash mid-write never leaves half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: FORMAT_VERSION, folder: realPath(dir), records }, null, 2)}\n`);
      renameSync(tmp, file);
    } catch {
      // Capture must never fail or slow down an inspect, and it is silent by
      // design (R15): a read-only directory just means nothing is recorded.
    }
  }

  /** Records for a page, optionally only those listing a given locator. */
  function lookup(url, locator) {
    const page = pageKey(url);
    const wanted = locator && redactLocator(locator);
    let legacyRecords = [];
    try {
      legacyRecords = JSON.parse(readFileSync(legacy, 'utf8')).records ?? []; // not yet migrated
    } catch {
      // none
    }
    return [...load(), ...legacyRecords].filter((r) => r.page === page && (!wanted || r.locators.includes(wanted)));
  }

  return { record, lookup, file, enabled };
}
