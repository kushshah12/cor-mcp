// Masking for what COR commits to a project (.cor/records/): a record must not carry account data from an
// authenticated page. Moved from the retired ~/.cor/fingerprints store (review, 2026-10-05).
// ── redaction ───────────────────────────────────────────────────────────────
// Masking, not hashing: cor_heal compares stored values with live ones as
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
 * Masking is deterministic: the same input always masks the same way.
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

