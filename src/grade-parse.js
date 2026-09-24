// Turns a selector string lifted from a test file into something Playwright
// can count. Playwright itself then counts it, so getBy* match counts carry
// Playwright's real semantics instead of a re-implementation.
//
// Scope, per the plan: raw CSS / XPath / Playwright selector-engine strings,
// the Playwright getBy* family and locator(), and Cypress cy.get / cy.contains.
// Not a general parser for seven framework DSLs; everything else is refused.

const PLAYWRIGHT_METHODS = new Set([
  'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle', 'locator',
]);

export const SUPPORTED_FORMS =
  "a CSS selector, an XPath, page.getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/getByAltText/getByTitle(…), page.locator('…'), cy.get('…') or cy.contains(…)";

class NotGradable extends Error {}

// ── a tiny literal reader: strings, regexes, numbers, booleans, flat objects ──
function reader(src) {
  let i = 0;
  const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
  const fail = (what) => { throw new NotGradable(what); };

  function string() {
    const quote = src[i++];
    let out = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (quote === '`' && src[i] === '$' && src[i + 1] === '{') fail('a template literal with ${…} depends on runtime values');
      out += src[i++];
    }
    if (src[i] !== quote) fail('an unterminated string');
    i++;
    return out;
  }

  function regex() {
    let body = '';
    i++; // opening /
    let inClass = false;
    while (i < src.length && (src[i] !== '/' || inClass)) {
      if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
      if (src[i] === '[') inClass = true;
      if (src[i] === ']') inClass = false;
      body += src[i++];
    }
    if (src[i] !== '/') fail('an unterminated regular expression');
    i++;
    let flags = '';
    while (/[a-z]/.test(src[i] ?? '')) flags += src[i++];
    try {
      return new RegExp(body, flags);
    } catch {
      return fail('an invalid regular expression');
    }
  }

  function object() {
    i++; // {
    const out = {};
    for (;;) {
      ws();
      if (src[i] === '}') { i++; return out; }
      let key;
      if (src[i] === '"' || src[i] === "'") key = string();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        if (!m) fail('an object key that is not a plain name');
        key = m[0];
        i += key.length;
      }
      ws();
      if (src[i++] !== ':') fail('an object shorthand or spread (values must be literals)');
      out[key] = value();
      ws();
      if (src[i] === ',') i++;
    }
  }

  function value() {
    ws();
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') return string();
    if (ch === '/') return regex();
    if (ch === '{') return object();
    const m = /^(true|false|-?\d+(\.\d+)?)/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
    }
    return fail('an argument that is a variable or expression rather than a literal');
  }

  /** Parse `(arg, arg)` at the cursor; returns the args and what follows. */
  function args() {
    ws();
    if (src[i++] !== '(') fail('no argument list');
    const out = [];
    for (;;) {
      ws();
      if (src[i] === ')') { i++; break; }
      out.push(value());
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] !== ')') fail('an argument list it could not read');
    }
    return { out, rest: src.slice(i).trim() };
  }

  return { args };
}

/**
 * @returns {{ framework: string, scoreValue: string, build: (page) => import('playwright-core').Locator, note?: string }}
 * @throws {NotGradable}
 */
export function parseGradable(input) {
  const src = String(input ?? '').trim().replace(/;$/, '').replace(/^await\s+/, '').trim();
  if (!src) throw new NotGradable('it is empty');

  // Cypress
  const cy = /^cy\s*\.\s*(get|contains)\s*(?=\()/.exec(src);
  if (cy) {
    const { out, rest } = reader(src.slice(cy[0].length)).args();
    if (rest) throw new NotGradable(`chained calls (${rest.slice(0, 30)}) are not graded — grade the base selector`);
    if (cy[1] === 'get') {
      if (typeof out[0] !== 'string') throw new NotGradable('cy.get needs a selector string');
      // cy.get('@alias') refers to a runtime alias, not the page.
      if (out[0].startsWith('@')) throw new NotGradable('cy.get(\'@alias\') names a Cypress alias, not a selector');
      return { framework: 'cypress', scoreValue: out[0], build: (page) => page.locator(out[0]) };
    }
    // cy.contains(text) / cy.contains(selector, text)
    const [a, b] = out;
    const note = 'cy.contains acts on the first match; the count shows how many elements contain the text.';
    if (b === undefined) {
      if (typeof a !== 'string' && !(a instanceof RegExp)) throw new NotGradable('cy.contains needs text');
      return { framework: 'cypress', scoreValue: src, note, build: (page) => page.getByText(a) };
    }
    if (typeof a !== 'string') throw new NotGradable('cy.contains(selector, text) needs a selector string');
    return { framework: 'cypress', scoreValue: src, note, build: (page) => page.locator(a).filter({ hasText: b }) };
  }

  // Playwright: `page.getByRole(…)`, `this.page.locator(…)`, bare `getByText(…)`
  const pw = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*(getBy[A-Za-z]+|locator)\s*(?=\()/.exec(src);
  if (pw) {
    const method = pw[1];
    if (!PLAYWRIGHT_METHODS.has(method)) throw new NotGradable(`${method} is not a Playwright locator method`);
    const { out, rest } = reader(src.slice(pw[0].length)).args();
    if (rest) {
      throw new NotGradable(`chained calls (${rest.slice(0, 30)}) are not graded — grade the base locator, e.g. the part before .first() or .filter()`);
    }
    if (out.length === 0) throw new NotGradable(`${method}() has no argument`);
    const [first, options] = out;
    if (method === 'locator') {
      if (typeof first !== 'string') throw new NotGradable('locator() needs a selector string');
      return { framework: 'playwright', scoreValue: first, build: (page) => page.locator(first) };
    }
    return {
      framework: 'playwright',
      // The engine's scorer reads the call as written, with a `page.` receiver
      // (`this.page.getByRole(…)` would otherwise read as CSS).
      scoreValue: `page.${src.slice(pw[0].lastIndexOf(method))}`,
      build: (page) => page[method](first, options),
    };
  }

  if (/^[A-Za-z_$][\w$.]*\s*\(/.test(src)) {
    throw new NotGradable(`${src.split('(')[0]}(…) is not a form cor_grade reads`);
  }

  // A raw selector: CSS, XPath, or a Playwright selector-engine string (text=, role=, xpath=).
  return { framework: null, scoreValue: src.replace(/^xpath=/, ''), build: (page) => page.locator(src) };
}

export { NotGradable };
