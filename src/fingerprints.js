// Silent fingerprint capture: what a later heal verifies against.
//
// Every successful cor_inspect appends (or refreshes) one record in
// .cor/fingerprints.json under the project directory. Nothing is printed —
// not to the tool response, not to stderr. The README states exactly what is
// stored; keep this file and that section in step.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
/**
 * @param {{ dir?: string, enabled?: boolean, now?: () => number }} [options]
 */
export function createFingerprintStore({ dir = process.cwd(), enabled = true, now = Date.now } = {}) {
  const folder = join(dir, '.cor');
  const file = join(folder, 'fingerprints.json');

  function ensureIgnored() {
    // A .gitignore inside .cor/ — the user's own .gitignore is never edited.
    const ignore = join(folder, '.gitignore');
    let current = '';
    try {
      current = readFileSync(ignore, 'utf8');
    } catch {
      // absent — created below
    }
    if (!current.split(/\r?\n/).includes('fingerprints.json')) {
      writeFileSync(ignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}fingerprints.json\n`);
    }
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
      ensureIgnored();
      const at = new Date(now()).toISOString();
      const page = pageKey(url);
      const cutoff = now() - RETENTION_DAYS * 86_400_000;
      const records = load().filter((r) => Date.parse(r.lastSeen) >= cutoff);

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
      writeFileSync(tmp, `${JSON.stringify({ version: FORMAT_VERSION, records }, null, 2)}\n`);
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
    return load().filter((r) => r.page === page && (!wanted || r.locators.includes(wanted)));
  }

  return { record, lookup, file, enabled };
}
