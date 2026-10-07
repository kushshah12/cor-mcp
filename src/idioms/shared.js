// P3a: pieces every idiom table uses (spec §7.2.3 R2 — values are escaped for the context they land in).

/** A JS string literal. */
export const js = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A value that is safe to place inside a "…" CSS attribute selector or a template literal without escaping. */
export const plainValue = (v) => !/["'\\`$\n]/.test(String(v));

/** `div.simplification-card` → `simplificationCard`; the helper's name. */
export function helperName(css) {
  // U6: `[data-test="inventory-item"]` → `inventoryItem` (the test id names the item).
  const word = /\[[\w-]+="([\w-]+)"\]$/.exec(css)?.[1] ?? /(?:\.([\w-]+))?$/.exec(css)?.[1] ?? /^[a-z0-9]+/i.exec(css)?.[0] ?? 'item';
  const name = word.replace(/[-_]+([a-z0-9])/gi, (_, c) => c.toUpperCase());
  return /^[a-z]/i.test(name) ? name[0].toLowerCase() + name.slice(1) : 'item';
}

export const MAX_LINE = 120;
export const MAX_LINES = 8;
/** R4: the helper is at most 8 lines; no line of it or of its uses is over 120 characters. */
export const withinBar = (define, uses = []) => define.length <= MAX_LINES && [...define, ...uses].every((l) => l.length <= MAX_LINE);

/** P3: the cell helper's name — `cell`, or `cellImg` when it reaches an element inside the cell (both may sit in one file). */
export const cellHelperName = (model) => { const tag = /^\/\/([a-z0-9]+)/.exec(model.inner ?? '')?.[1]; return tag ? `cell${tag[0].toUpperCase()}${tag.slice(1)}` : 'cell'; };
