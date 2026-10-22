// U9: find every locator call in a file and the cor: id that belongs to it. Syntax finds the calls; identity comes only
// from the id — never from comparing locator text (R46). A call's id is on its own line or in the comment lines right
// above the statement it starts (an entry is placed as `// COR cor:7f3a2c · …` then the code).
import { ID_PATTERN } from './records.js';
import { bannedIn, bannedSelector } from './positional.js';

// A locator call: Playwright (page./this.page./any receiver .locator/.getBy*), Cypress (cy.get/cy.contains), WebdriverIO ($/$$).
// Review fix: also page.$ / browser.$ / el.$ (WebdriverIO, Puppeteer-style), cy.xpath and Testing Library's cy.findBy*.
const CALL = /(?:\b(?:this\.)?page\s*\.\s*(?:locator|getBy[A-Z]\w*)\s*\(|\.\s*(?:locator|getBy[A-Z]\w*)\s*\(|\bcy\s*\.\s*(?:get|contains|xpath|find(?:All)?By[A-Z]\w*)\s*\(|(?:^|[^\w$])\$\$?\s*\()/;
// Testing Library's screen.getBy* in a component test queries a rendered component, not the app page: not COR's.
const COMPONENT_QUERY = /\bscreen\s*\.\s*(?:get|query|find)(?:All)?By/;
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
const CONTINUES = /^\s*(?:[.)]|\|\||&&|\?\?)/; // a line that continues the statement above (a chain step, a closing paren, || / &&)
// A line that leaves its statement open: ends in `(`, `=>` or `=`. Not `,` or `{` — those end one member and start the
// next, and merging two members would let one's id cover the other.
const OPENS = /(?:\(|=>|[^=!<>]=|\|\||&&|\?\?)\s*$/; // P2a fix: `||` / `&&` too — WebdriverIO's either-name helper breaks there
// What starts a gradable expression on a line: a page / this.page / cy / $ receiver.
const ROOTED = /(?:this\.)?page\s*\.\s*(?:locator|getBy[A-Z]\w*)\s*\(|\bcy\s*\.\s*(?:get|contains)\s*\(|\$\$?\s*\(/;
const STEP = /^\s*\.\s*(locator|getBy[A-Z]\w*|filter|first|last|nth|or|and|find|eq)\s*\(/;

/** The line that opens the `{ … }` block holding line `at` (braces counted back, strings skipped), or -1 at top level. */
function enclosingBlock(lines, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0 && k >= at - 40; k--) {
    const code = lines[k].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (let j = code.length - 1; j >= 0; j--) {
      if (code[j] === '}') depth++;
      else if (code[j] === '{' && --depth < 0) return /=>\s*\{\s*$|\)\s*\{\s*$/.test(code) ? k : -1; // a function body, not a class or object
    }
  }
  return -1;
}

/** The balanced `( … )` at `i` (src[i] === '('): its end index, skipping strings. */
function closeParen(src, i) {
  let depth = 0;
  let quote = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j;
  }
  return -1;
}

/** The page-rooted locator expression in `src` (calls plus locator steps, not actions), or null. */
export function rootedExpression(src) {
  const m = ROOTED.exec(src);
  if (!m) return null;
  let end = closeParen(src, m.index + m[0].length - 1);
  if (end < 0) return null;
  for (;;) {
    const rest = src.slice(end + 1);
    const step = STEP.exec(rest);
    if (step) { end = closeParen(src, end + 1 + step[0].length - 1); if (end < 0) return null; continue; }
    const index = /^\s*\[\s*\d+\s*\]/.exec(rest); // $$(s)[n]
    if (index) { end += index[0].length; continue; }
    break;
  }
  return src.slice(m.index, end + 1).replace(/\s*\n\s*/g, '');
}

/**
 * Every locator call in `text`, one per statement: its line, the statement, its cor: id (or null) and whether it
 * fails the shared positional / structural check (P1: `positional` is the reason, or null). JSON is handled by the caller
 * (its ids are in the sidecar).
 * @returns {{ line: number, statement: string, id: string|null, positional: string|null, expression: string|null }[]}
 */
export function scanLocators(text, framework = null) {
  const lines = text.split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT.test(lines[i]) || !CALL.test(lines[i]) || (COMPONENT_QUERY.test(lines[i]) && !CALL.test(lines[i].replace(COMPONENT_QUERY, '')))) continue;
    // The statement: back up over continuation lines, then forward until it closes.
    let start = i;
    while (start > 0 && (CONTINUES.test(lines[start]) || OPENS.test(lines[start - 1])) && !COMMENT.test(lines[start - 1])) start--;
    if (seen.has(start)) continue;
    seen.add(start);
    let end = i;
    while (end + 1 < lines.length && (CONTINUES.test(lines[end + 1]) || OPENS.test(lines[end]))) end++;
    const statement = lines.slice(start, end + 1).join('\n');
    // The id: in the statement itself, or in the comment block right above it.
    let id = ID_PATTERN.exec(statement)?.[1] ?? null;
    let label = false; // P2a fix: an entry's `· label` member finds the hidden input's label, not the recorded input
    let helper = false; // an entry's helper (Cypress/WebdriverIO) carries its member's id: `// COR cor:… · helper, once per file`
    for (let k = start - 1; !id && k >= 0 && COMMENT.test(lines[k]); k--) {
      id = ID_PATTERN.exec(lines[k])?.[1] ?? null;
      if (id) { helper = /\bhelper\b/.test(lines[k]); label = /· label —/.test(lines[k]); }
    }
    // P5: a locator inside a block body (`cellAt = (order, column) => { … return this.page.locator(…); }`) carries the id of
    // the member or helper whose block holds it — the comment above the line that opens that block.
    if (!id) {
      const opener = enclosingBlock(lines, start);
      for (let k = opener - 1; !id && opener > 0 && k >= 0 && COMMENT.test(lines[k]); k--) {
        id = ID_PATTERN.exec(lines[k])?.[1] ?? null;
        if (id) { helper = /\bhelper\b/.test(lines[k]); label = /· label —/.test(lines[k]); }
      }
    }
    out.push({ line: start + 1, statement: statement.trim(), id, helper, label, positional: bannedIn(statement, framework), expression: rootedExpression(statement) });
  }
  return out;
}

/** YAML: each `key: value` line and its id, from the `# COR cor:…` comment above it. */
export function scanYaml(text, framework = null) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([\w$-]+)\s*:\s*\S/.exec(lines[i]);
    if (!m || COMMENT.test(lines[i])) continue;
    let id = null;
    for (let k = i - 1; !id && k >= 0 && COMMENT.test(lines[k]); k--) id = ID_PATTERN.exec(lines[k])?.[1] ?? null;
    out.push({ line: i + 1, key: m[1], id, statement: lines[i].trim(), positional: bannedIn(lines[i], framework) ?? bannedSelector(lines[i].slice(lines[i].indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, ''), framework) });
  }
  return out;
}
