// P1 core — the one positional and structural check, shared by the entry builder (no entry is issued that fails it) and
// cor_check's scan (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md, P1). Fixed numbers are banned,
// worked-out ones are not: `.eq(i)` with `i` read from a header name passes, `.eq(0)` does not.

/** A literal positional pick in code: .first() .last() .nth(n) .eq(n) >> nth=n $$(…)[n]. */
export const POSITIONAL_TEXT = /\.(?:first|last)\(\s*\)|\.nth\(\s*-?\d+\s*\)|\.eq\(\s*\d+\s*\)|>>\s*nth=-?\d+|\$\$\([^)]*\)\s*\[\s*\d+\s*\]/;
// In a selector string: :nth-child(2) / :nth-of-type(2), an XPath step index (/td[3], (//x)[2]).
const INDEX_IN_SELECTOR = /:nth-(?:last-)?(?:child|of-type)\(\s*\d+\s*\)|\/[\w*:-]+\[\s*\d+\s*\]|\)\s*\[\s*\d+\s*\]/;
const BARE_TAG = /^[a-z][a-z0-9]*(?::nth-(?:last-)?(?:child|of-type)\([^)]*\))?$/;
const PLAIN_CLASS = /^[a-z0-9]*(?:\.[\w-]+)+$/i; // tag.class / .class — no id, attribute or pseudo-class
const MIN_BARE_CHAIN = 3;
// The first string argument of a selector call: what is a selector, not display text.
const SELECTOR_ARG = /(?:locator|get|find|closest|\$\$?)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TEXT_ANCHOR = /\.contains\(|findBy|getBy|filter\(\s*\{\s*has/;

const INDEX = 'picks by position (.first/.nth/.eq/[n]): a reorder silently changes the element';

/** Why a raw selector string (CSS or XPath) is banned for `framework`, or null. */
export function bannedSelector(selector, framework = null, { anchored = false } = {}) {
  const s = String(selector ?? '');
  if (INDEX_IN_SELECTOR.test(s)) return INDEX;
  if (/^\/|^\(\/\//.test(s)) return null; // the rest is CSS
  for (const part of s.split(',')) {
    const tokens = part.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    let run = 0;
    for (const t of tokens) {
      run = BARE_TAG.test(t) ? run + 1 : 0;
      if (run >= MIN_BARE_CHAIN) return `walks anonymous tag nesting (${MIN_BARE_CHAIN}+ bare tags in a row): any wrapper added or removed breaks it`;
    }
    if (framework === 'cypress' && !anchored && tokens.length >= 2 && tokens.every((t) => PLAIN_CLASS.test(t) || BARE_TAG.test(t)) && tokens.some((t) => t.includes('.'))) {
      return 'chains class names with no attribute, id or text anchoring it: a restyle breaks it';
    }
  }
  return null;
}

/** Why a locator in code is banned for `framework`, or null. Checks the code's own picks and every selector string it passes. */
export function bannedIn(code, framework = null) {
  const src = String(code ?? '');
  if (POSITIONAL_TEXT.test(src)) return INDEX;
  if (framework === 'cypress' && /\bcy\s*\.\s*xpath\s*\(/.test(src)) return 'cy.xpath needs the cypress-xpath plugin, which this project does not declare';
  const anchored = TEXT_ANCHOR.test(src);
  for (const m of src.matchAll(SELECTOR_ARG)) {
    const why = bannedSelector(m[2].replace(/^(?:css|xpath)=/, ''), framework, { anchored });
    if (why) return why;
  }
  return null;
}

/** True when a reason came from a positional pick (not a structural chain): cor_check words those as before. */
export const isIndexReason = (why) => why === INDEX;
