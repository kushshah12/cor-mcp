// P3a: pieces every idiom table uses (spec §7.2.3 R2 — values are escaped for the context they land in).

/** A JS string literal. */
export const js = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A value that is safe to place inside a "…" CSS attribute selector or a template literal without escaping. */
export const plainValue = (v) => !/["'\\`$\n]/.test(String(v));

/** `div.simplification-card` → `simplificationCard`; the helper's name. */
export function helperName(css) {
  const word = /(?:\.([\w-]+))?$/.exec(css)?.[1] ?? /^[a-z0-9]+/i.exec(css)?.[0] ?? 'item';
  const name = word.replace(/[-_]+([a-z0-9])/gi, (_, c) => c.toUpperCase());
  return /^[a-z]/i.test(name) ? name[0].toLowerCase() + name.slice(1) : 'item';
}

export const MAX_LINE = 120;
export const MAX_LINES = 8;
export const withinBar = (lines) => lines.length <= MAX_LINES && lines.every((l) => l.length <= MAX_LINE);
