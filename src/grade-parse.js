// Turns a selector string lifted from a test file into something Playwright
// can count. Playwright itself then counts it, so getBy* match counts carry
// Playwright's real semantics instead of a re-implementation.
//
// Scope, per the plan: raw CSS / XPath / Playwright selector-engine strings,
// the Playwright getBy* family and locator(), Cypress cy.get / cy.contains and WebdriverIO $ / $$ — each with its
// framework's traversal chain (P5).
// Not a general parser for seven framework DSLs; everything else is refused.

const PLAYWRIGHT_METHODS = new Set([
  'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle', 'locator',
]);

// Steps a chain may continue with after its first locator call.
const CHAIN_METHODS = new Set(['filter', 'first', 'last', 'nth', 'or', 'and']);
const POSITIONAL = new Set(['first', 'last', 'nth']);
/** Playwright's own positional pick on a locator: `first()`, `last()`, `nth(2)`, `eq(2)`, `[2]`, `nth=2`. */
const pick = (loc, method, n) => (method === 'first' ? loc.first() : method === 'last' ? loc.last() : loc.nth(Number(n)));
const LOCATOR_START = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*(getBy[A-Za-z]+|locator)\s*(?=\()/;

export const SUPPORTED_FORMS =
  "a CSS selector, an XPath, page.getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/getByAltText/getByTitle(…) or page.locator('…') — chained with .locator/.getBy*/.filter({ has, hasNot, hasText, hasNotText, visible })/.or()/.and()/.first()/.last()/.nth(n) — cy.get('…') or cy.contains(…), chained with .find/.filter/.not/.closest/.parent/.children/.contains/.eq/.first/.last — $('…') / $$('…') with a WebdriverIO selector (CSS, XPath, tag=text, tag.class=text, *=text), chained with .$/.$$/[n]/.parentElement() and .filter/.find((el) => el.isDisplayed() | (await el.getText()) === … | (await el.$(…).isExisting()))";

class NotGradable extends Error {}

// WebdriverIO text selectors (webdriver.io/docs/selectors): `tag=text` / `tag*=text` match an
// element's text exactly / partially, `=text` / `*=text` the rendered text of any element. The
// partial forms are loose: they find every element that merely contains the words (U22).
const WDIO_TEXT = /^([A-Za-z][A-Za-z0-9]*)?((?:[.#][\w-]+)*)(\*)?=(.+)$/s; // P5: tag.class=text / #id=text too (COR's own name leaves)
const NOT_TEXT_TAGS = /^(id|android|ios)$/i;

const xpathLit = (s) => (!s.includes('"') ? `"${s}"` : !s.includes("'") ? `'${s}'` : `concat(${s.split('"').map((p) => `"${p}"`).join(`, '"', `)})`);

/** `$('…')` / `$$('…')`: a WebdriverIO text selector, else CSS or XPath as WebdriverIO takes it. */
function wdioSelector(sel) {
  const m = WDIO_TEXT.exec(sel);
  if (m && !NOT_TEXT_TAGS.test(m[1] ?? '')) {
    const [, bare, attrs, star, raw] = m;
    const text = raw.trim();
    const partial = Boolean(star);
    const lit = xpathLit(text);
    const contains = partial ? `contains(normalize-space(.), ${lit})` : `normalize-space(.) = ${lit}`;
    // P5: .class / #id narrow the tag (or any element) as WebdriverIO does before comparing the text.
    const preds = (attrs.match(/[.#][\w-]+/g) ?? []).map((a) => (a[0] === '#' ? `[@id=${xpathLit(a.slice(1))}]` : `[contains(concat(' ', normalize-space(@class), ' '), ' ${a.slice(1)} ')]`)).join('');
    const tag = bare || preds ? `${bare || '*'}${preds}` : '';
    // What WebdriverIO builds for tag=text / tag*=text; for =text / *=text, the innermost rendered elements.
    const xpath = tag
      ? (partial
        ? `//${tag}[contains(., ${lit}) and not(.//${tag})]`
        : `//${tag}[normalize-space(text()) = ${lit}] | //${tag}[not(.//${tag}[normalize-space(text()) = ${lit}]) and normalize-space() = ${lit}]`)
      : `//*[${contains} and not(.//*[${contains}])]`;
    return {
      framework: 'webdriverio',
      scoreValue: xpath,
      note: 'WebdriverIO text selectors are counted here as the XPath they stand for, not run in WebdriverIO',
      build: tag ? (page) => page.locator(`xpath=${xpath}`) : (page) => page.locator(`xpath=${xpath}`).filter({ visible: true }),
      // P5: inside an element (a chain step, a filter's has): every branch of the union starts from that element.
      inside: tag ? (page) => page.locator(`xpath=${relativeXpath(xpath)}`) : (page) => page.locator(`xpath=${relativeXpath(xpath)}`).filter({ visible: true }),
      loose: partial ? { kind: 'partial-text', framework: 'webdriverio', selector: sel, text } : null,
    };
  }
  if (/^aria\//.test(sel)) throw new NotGradable('aria/ selectors are not graded yet — cor_inspect the element for its locator');
  const xp = /^(?:xpath=)?(\(*\.?\/)/.test(sel) ? sel.replace(/^xpath=/, '') : null;
  return { framework: 'webdriverio', scoreValue: sel.replace(/^xpath=/, ''), build: (page) => page.locator(sel), inside: (page) => page.locator(xp ? `xpath=${relativeXpath(xp)}` : sel) };
}

/** An XPath read from inside an element: Playwright makes only a leading // relative, so each branch of a union is. */
const relativeXpath = (xp) => xp.replace(/(^|\|\s*)(\(*)\/\//g, '$1$2.//');

const exactRegex = (re) => re.source.startsWith('^') && re.source.endsWith('$');

// ── a tiny literal reader: strings, regexes, numbers, booleans, flat objects ──
function reader(src, param = null) {
  let i = 0;
  let usedParam = false;
  const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
  const fail = (what) => { throw new NotGradable(what); };

  function string() {
    const quote = src[i++];
    let out = '';
    const parts = []; // P5: a template literal filled only with the parameter — text, null (the value), text, …
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
        const close = src.indexOf('}', i);
        const expr = close < 0 ? '' : src.slice(i + 2, close).trim();
        if (!param) fail(`a template literal with \${${expr || '…'}} depends on runtime values — pass param: "${expr || 'name'}" (and values) to grade it across them`);
        if (expr !== param) fail(`a template literal with \${${expr}} — only \${${param}} is filled in`);
        parts.push(out, null);
        out = '';
        usedParam = true;
        i = close + 1;
        continue;
      }
      out += src[i++];
    }
    if (src[i] !== quote) fail('an unterminated string');
    i++;
    return parts.length ? { kind: 'template', parts: [...parts, out] } : out;
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
      // `{ name, exact: true }` — shorthand is allowed only for the parameter itself.
      if (param && key === param && (src[i] === ',' || src[i] === '}')) {
        out[key] = { kind: 'param' };
        usedParam = true;
        if (src[i] === ',') i++;
        continue;
      }
      if (src[i++] !== ':') fail('an object shorthand or spread (values must be literals)');
      out[key] = value();
      ws();
      if (src[i] === ',') i++;
    }
  }

  function value() {
    ws();
    // A locator as an option value: filter({ has: page.getByText('…') }).
    if (LOCATOR_START.test(src.slice(i))) return chain();
    // U19.3: the helper's parameter, e.g. getByText(title, { exact: true }).
    if (param) {
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0];
      if (id === param && !/^\s*[.(]/.test(src.slice(i + id.length))) {
        i += id.length;
        usedParam = true;
        return { kind: 'param' };
      }
    }
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

  /** Parse `(arg, arg)` at the cursor, leaving the cursor after `)`. */
  function argList() {
    ws();
    if (src[i++] !== '(') fail('no argument list');
    const out = [];
    for (;;) {
      ws();
      if (src[i] === ')') { i++; return out; }
      out.push(value());
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] !== ')') fail('an argument list it could not read');
    }
  }

  /**
   * A Playwright locator expression at the cursor: `page.locator('…')` then
   * any `.locator / .getBy* / .filter / .first / .last / .nth` steps.
   * Returns { kind: 'locator', calls: [{ method, args, code }] }.
   */
  function chain() {
    const head = LOCATOR_START.exec(src.slice(i));
    const calls = [];
    let start = i + head[0].lastIndexOf(head[1]);
    i += head[0].length;
    let method = head[1];
    for (;;) {
      if (!PLAYWRIGHT_METHODS.has(method) && !CHAIN_METHODS.has(method)) fail(`.${method}() is not a locator step cor_grade reads (it reads ${[...PLAYWRIGHT_METHODS, ...CHAIN_METHODS].join(', ')})`);
      if (calls.length === 0 && !PLAYWRIGHT_METHODS.has(method)) fail(`a chain must start with a locator method, not .${method}()`);
      const callArgs = argList();
      calls.push({ method, args: callArgs, code: src.slice(start, i).replace(/\s+/g, ' ') });
      const save = i;
      ws();
      const next = /^\.\s*([A-Za-z]+)\s*(?=\()/.exec(src.slice(i));
      if (!next) { i = save; return { kind: 'locator', calls }; }
      start = i + 1;
      i += next[0].length;
      method = next[1];
    }
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

  return { args, chain, rest: () => src.slice(i).trim(), usedParam: () => usedParam };
}

/** Rebuild a parsed chain on a page, so Playwright counts exactly what was written. */
function buildChain(page, { calls }, value) {
  const resolve = (v) => {
    if (v && v.kind === 'param') return value;
    if (v && v.kind === 'template') return v.parts.map((x) => (x === null ? value : x)).join('');
    if (v && v.kind === 'locator') return buildChain(page, v, value);
    if (v && typeof v === 'object' && !(v instanceof RegExp)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  let loc = page;
  for (const { method, args } of calls) loc = loc[method](...args.map(resolve));
  return loc;
}

/**
 * What a chain's durability rests on: each step that names something, scored
 * on its own (a chain breaks when any step does), plus steps that pick by
 * state or position, which are noted rather than scored.
 */
function describeChain({ calls }, prefix = '') {
  const scored = [];
  const notes = [];
  for (const { method, args, code } of calls) {
    if (PLAYWRIGHT_METHODS.has(method)) {
      scored.push({ code: `${prefix}${code}`, scoreValue: method === 'locator' ? args[0] : `page.${code}` });
    } else if ((method === 'or' || method === 'and') && args[0]?.kind === 'locator') {
      // .or(): either branch may match, .and(): both must. Both branches are
      // scored and the weaker counts — conservative for .or(), exact for .and().
      const inner = describeChain(args[0], `${prefix}${method}: `);
      scored.push(...inner.scored);
      notes.push(...inner.notes);
      if (method === 'or') notes.push(`${prefix}.or() — matches if either branch does; the score is the weaker branch's`);
    } else if (method === 'filter') {
      const opts = args[0] ?? {};
      for (const key of ['has', 'hasNot']) {
        if (opts[key]?.kind === 'locator') {
          const inner = describeChain(opts[key], `${prefix}filter ${key}: `);
          scored.push(...inner.scored);
          notes.push(...inner.notes);
        }
      }
      for (const key of ['hasText', 'hasNotText']) {
        if (opts[key] !== undefined) {
          const t = opts[key] instanceof RegExp ? String(opts[key]) : `'${opts[key]}'`;
          scored.push({ code: `${prefix}filter ${key}: ${t}`, scoreValue: `page.getByText(${t})` });
        }
      }
      if (opts.visible === true) notes.push(`${prefix}.filter({ visible: true }) — unique only while the other matches stay hidden; if one shows, the chain matches more`);
    } else {
      notes.push(`${prefix}.${code} — picks by position: whatever is ${method === 'nth' ? `number ${args[0]}` : method} among the matches, which changes if their order does`);
    }
  }
  return { scored, notes };
}

/**
 * @returns {{ framework: string, scoreValue: string, build: (page) => import('playwright-core').Locator, note?: string, chain?: { scored: object[], notes: string[] } }}
 * @throws {NotGradable}
 */
export function parseGradable(input, { param = null, framework = null } = {}) {
  const src = String(input ?? '').trim().replace(/;$/, '').replace(/^await\s+/, '').trim();
  if (!src) throw new NotGradable('it is empty');

  // P5: Cypress and WebdriverIO across a parameter — each value is filled in (a bare name or `${param}` in a template
  // literal), then the literal form is read as usual. Values must be given: there is no first CSS step to find them by.
  if (param && /^(?:cy\s*\.|\$)/.test(src)) {
    const probe = substituteParam(src, param, '\u0001');
    const fw = src.startsWith('cy') ? 'cypress' : 'webdriverio';
    parseGradable(probe, { framework: fw }); // throws NotGradable for a form it cannot read
    return { framework: fw, usesParam: probe !== src, build: (page, v) => parseGradable(substituteParam(src, param, v), { framework: fw }).build(page), baseCss: null };
  }

  // Cypress
  const cy = /^cy\s*\.\s*(get|contains)\s*(?=\()/.exec(src);
  if (cy) {
    let { out, rest } = reader(src.slice(cy[0].length)).args();
    // cy.get(a).find(b)… is the descendant selector `a b`: grade that.
    while (cy[1] === 'get' && typeof out[0] === 'string' && !out[0].startsWith('@') && (rest.match(/^\.\s*find\s*(?=\()/))) {
      const step = reader(rest.replace(/^\.\s*find\s*/, '')).args();
      if (typeof step.out[0] !== 'string' || step.out.length !== 1) break;
      out = [`${out[0]} ${step.out[0]}`];
      rest = step.rest;
    }
    // U4 (D2): a trailing .eq(n) / .first() / .last() picks by position — graded, not refused.
    const cyPick = cy[1] === 'get' && /^\.\s*(eq|first|last)\s*\(\s*(\d*)\s*\)$/.exec(rest);
    // P5: any other chain is read step by step (cypressStep) on top of its base.
    if (rest && !cyPick) return chainOf(parseGradable(src.slice(0, src.length - rest.length)), rest, cypressStep);
    if (cy[1] === 'get') {
      if (typeof out[0] !== 'string') throw new NotGradable('cy.get needs a selector string');
      // cy.get('@alias') refers to a runtime alias, not the page.
      if (out[0].startsWith('@')) throw new NotGradable('cy.get(\'@alias\') names a Cypress alias, not a selector');
      const base = (page) => page.locator(out[0]);
      if (!cyPick) return { framework: 'cypress', scoreValue: out[0], build: base };
      const [, m, n] = cyPick;
      return { framework: 'cypress', scoreValue: out[0], build: (page) => pick(base(page), m === 'eq' ? 'nth' : m, n), positional: [{ code: `${m}(${n})`, prefix: base }] };
    }
    // cy.contains(text) / cy.contains(selector, text)
    const [a, b] = out;
    const note = 'cy.contains acts on the first match; the count shows how many elements contain the text.';
    if (b === undefined) {
      if (typeof a !== 'string' && !(a instanceof RegExp)) throw new NotGradable('cy.contains needs text');
      const loose = a instanceof RegExp ? !exactRegex(a) : true;
      return { framework: 'cypress', scoreValue: src, note, build: (page) => page.getByText(a), loose: loose ? { kind: 'substring', framework: 'cypress', selector: src, text: String(a instanceof RegExp ? a.source : a) } : null };
    }
    if (typeof a !== 'string') throw new NotGradable('cy.contains(selector, text) needs a selector string');
    const looseText = b instanceof RegExp ? !exactRegex(b) : true;
    return { framework: 'cypress', scoreValue: src, note, build: (page) => page.locator(a).filter({ hasText: b }), loose: looseText ? { kind: 'substring', framework: 'cypress', selector: src, text: String(b instanceof RegExp ? b.source : b) } : null };
  }

  // Playwright: `page.getByRole(…)`, `this.page.locator(…)`, bare `getByText(…)`, and chains of them
  const pw = LOCATOR_START.exec(src);
  if (pw) {
    const method = pw[1];
    if (!PLAYWRIGHT_METHODS.has(method)) throw new NotGradable(`${method} is not a Playwright locator method`);
    const r = reader(src, param);
    const parsed = r.chain();
    const rest = r.rest();
    if (rest) throw new NotGradable(`it has more after the locator (${rest.slice(0, 30)})`);
    const [base] = parsed.calls;
    if (base.args.length === 0) throw new NotGradable(`${method}() has no argument`);
    if (method === 'locator' && typeof base.args[0] !== 'string' && base.args[0]?.kind !== 'template') throw new NotGradable('locator() needs a selector string');
    const build = (page, value) => buildChain(page, parsed, value);
    if (param) {
      // Across every value: the caller counts each; durability is graded on a
      // literal copy (substituteParam), so the chain description is not needed.
      return { framework: 'playwright', usesParam: r.usedParam(), build, baseCss: method === 'locator' && typeof base.args[0] === 'string' ? base.args[0] : null };
    }
    if (parsed.calls.length === 1) {
      return {
        framework: 'playwright',
        // The engine's scorer reads the call as written, with a `page.` receiver
        // (`this.page.getByRole(…)` would otherwise read as CSS).
        scoreValue: method === 'locator' ? base.args[0] : `page.${base.code}`,
        build,
      };
    }
    const chain = describeChain(parsed);
    // U4 (D2): each first/last/nth, with the chain before it — counted to see whether it picks among several.
    const positional = parsed.calls.flatMap((c, k) => (POSITIONAL.has(c.method)
      ? [{ code: c.code, prefix: (page) => buildChain(page, { calls: parsed.calls.slice(0, k) }) }] : []));
    return { framework: 'playwright', scoreValue: chain.scored[0].scoreValue, build, chain, ...(positional.length ? { positional } : {}) };
  }

  const wdio = /^\$\$?\s*(?=\()/.exec(src);
  if (wdio) {
    const { out, rest } = reader(src.slice(wdio[0].length)).args();
    // U4 (D2): $$(s)[n] picks by position — graded, not refused.
    const index = wdio[0].startsWith('$$') && /^\[\s*(\d+)\s*\]$/.exec(rest);
    if (typeof out[0] !== 'string') throw new NotGradable('$() needs a selector string');
    // P5: a chain ($(a).$(b), .filter(…), .find(…), .parentElement()) is read step by step (wdioStep) on top of its base.
    if (rest && !index) return chainOf(wdioSelector(out[0]), rest, wdioStep);
    const sel = wdioSelector(out[0]);
    if (!index) return sel;
    return { ...sel, build: (page) => sel.build(page).nth(Number(index[1])), positional: [{ code: `[${index[1]}]`, prefix: sel.build }] };
  }

  if (/^[A-Za-z_$][\w$.]*\s*\(/.test(src)) {
    throw new NotGradable(`${src.split('(')[0]}(…) is not a form cor_grade reads`);
  }

  if (framework === 'webdriverio') return wdioSelector(src);

  // A raw selector: CSS, XPath, or a Playwright selector-engine string (text=, role=, xpath=).
  // U4 (D2): a trailing `>> nth=N` picks by position.
  const nth = /^(.+?)\s*>>\s*nth=(-?\d+)\s*$/.exec(src);
  if (nth) return { framework: null, scoreValue: nth[1].replace(/^xpath=/, ''), build: (page) => page.locator(src), positional: [{ code: `nth=${nth[2]}`, prefix: (page) => page.locator(nth[1]) }] };
  return { framework: null, scoreValue: src.replace(/^xpath=/, ''), build: (page) => page.locator(src) };
}

// ── P5: Cypress and WebdriverIO chains — each step read into the Playwright chain it stands for, so Playwright counts it ──

/** The index of the parenthesis closing the one at `open`, skipping strings. */
function closeParen(s, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  throw new NotGradable('a call is not closed');
}

/** `.name(args)` and `[n]` steps, raw. */
function stepsOf(rest) {
  const out = [];
  let r = rest.trim();
  while (r) {
    const index = /^\[\s*(\d+)\s*\]/.exec(r);
    if (index) { out.push({ name: '[]', n: index[1], code: index[0] }); r = r.slice(index[0].length).trim(); continue; }
    const m = /^\.\s*(\$\$|\$|[A-Za-z_]\w*)\s*\(/.exec(r);
    if (!m) throw new NotGradable(`it continues with ${r.slice(0, 30)}, which is not a call COR reads`);
    const close = closeParen(r, m[0].length - 1);
    out.push({ name: m[1], raw: r.slice(m[0].length, close).trim(), code: r.slice(1, close + 1) });
    r = r.slice(close + 1).trim();
  }
  return out;
}
const literals = (raw) => (raw ? reader(`(${raw})`).args().out : []);
const exactText = (t) => new RegExp(`^\\s*${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
const ACTION = 'is an action or an assertion, not part of the locator — grade the chain before it';

/**
 * The base locator with each step applied. A step returns `{ apply(loc, page), score?, note?, pick?, loose? }`: `score`
 * is a selector the step names (scored like any other), `pick` marks a step that takes one of several (counted on the
 * chain before it, as U4 does for .first()), `loose` a partial-text match.
 */
function chainOf(base, rest, readStep) {
  const builders = [base.build];
  const scored = [{ code: base.scoreValue, scoreValue: base.scoreValue }];
  const notes = base.note ? [base.note] : [];
  const positional = [];
  let loose = base.loose ?? null;
  for (const step of stepsOf(rest)) {
    const st = readStep(step);
    const before = builders[builders.length - 1];
    if (st.pick) positional.push({ code: step.code, prefix: st.filtered ? (page) => st.filtered(before(page), page) : before });
    builders.push((page) => st.apply(before(page), page));
    if (st.score) scored.push({ code: `.${step.code}`, scoreValue: st.score });
    if (st.note) notes.push(`.${step.code} — ${st.note}`);
    loose ??= st.loose ?? null;
  }
  const build = builders[builders.length - 1];
  return { framework: base.framework, scoreValue: base.scoreValue, build, chain: { scored, notes }, ...(positional.length ? { positional } : {}), ...(loose ? { loose } : {}) };
}

const SHOWN = 'keeps only the shown matches: unique only while the others stay hidden';

/** One Cypress step (docs.cypress.io): the traversal and filtering commands; actions and assertions end the locator. */
function cypressStep({ name, raw, n }) {
  const [a, b] = literals(raw);
  const sel = (what) => { if (typeof a !== 'string') throw new NotGradable(`.${name}() needs a selector string`); return what; };
  switch (name) {
    case 'find': return sel({ apply: (loc) => loc.locator(a), score: a });
    case 'filter': return sel(a === ':visible' ? { apply: (loc) => loc.filter({ visible: true }), note: SHOWN } : { apply: (loc, page) => loc.and(page.locator(a)), score: a });
    case 'not': return sel({ apply: (loc, page) => loc.and(page.locator(`:not(${a})`)), score: a });
    case 'closest': return sel({ apply: (loc, page) => loc.locator('xpath=ancestor-or-self::*').and(page.locator(a)), score: a, note: 'counted as every ancestor that matches (Cypress takes the nearest): more than one here means nested matches' });
    case 'parent': return { apply: (loc, page) => (a ? loc.locator('xpath=..').and(page.locator(a)) : loc.locator('xpath=..')), ...(a ? { score: a } : {}) };
    case 'children': return { apply: (loc) => loc.locator(`:scope > ${a ?? '*'}`), ...(a ? { score: a } : {}) };
    case 'contains': {
      if (b === undefined) {
        if (typeof a !== 'string' && !(a instanceof RegExp)) throw new NotGradable('.contains() needs text');
        const loose = a instanceof RegExp ? !exactRegex(a) : true;
        return { apply: (loc) => loc.getByText(a), ...(loose ? { loose: { kind: 'substring', framework: 'cypress', selector: `.contains(${raw})`, text: String(a instanceof RegExp ? a.source : a) } } : {}) };
      }
      const loose = b instanceof RegExp ? !exactRegex(b) : true;
      return sel({ apply: (loc) => loc.locator(a).filter({ hasText: b }), score: a, ...(loose ? { loose: { kind: 'substring', framework: 'cypress', selector: `.contains(${raw})`, text: String(b instanceof RegExp ? b.source : b) } } : {}) });
    }
    case 'eq': return { apply: (loc) => loc.nth(Number(a)), pick: true };
    case 'first': return { apply: (loc) => loc.first(), pick: true };
    case 'last': return { apply: (loc) => loc.last(), pick: true };
    default: throw new NotGradable(`.${name}() ${ACTION}`);
  }
  void n;
}

/** A WebdriverIO .filter / .find callback, in the forms COR's own entries use: shown, text equal, or a child that exists. */
function wdioCallback(raw) {
  const m = /^(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>\s*([\s\S]+)$/.exec(raw);
  if (!m) throw new NotGradable('its callback is not one COR reads — pass the element\'s locator instead');
  const [, el, rawBody] = m;
  const body = rawBody.trim().replace(/^\{\s*return\s+([\s\S]*?);?\s*\}$/, '$1');
  const unwrap = (x) => { let t = x.trim(); while (t.startsWith('(') && closeParen(t, 0) === t.length - 1) t = t.slice(1, -1).trim(); return t; };
  const parts = body.split(/\s*\|\|\s*/).map((x) => unwrap(x.replace(/await\s+/g, '')));
  const E = el.replace(/\$/g, '\\$');
  const shown = new RegExp(`^${E}\\.isDisplayed\\(\\s*\\)$`);
  const text = new RegExp(`^\\(?${E}\\.getText\\(\\s*\\)\\)?\\s*===\\s*([\\s\\S]+)$`);
  const child = new RegExp(`^${E}\\.\\$\\(([\\s\\S]+?)\\)\\.isExisting\\(\\s*\\)$`);
  if (parts.length === 1 && shown.test(parts[0])) return { apply: (loc) => loc.filter({ visible: true }), note: SHOWN };
  if (parts.length === 1 && text.test(parts[0])) {
    const [t] = literals(text.exec(parts[0])[1]);
    if (typeof t !== 'string') throw new NotGradable('it compares getText() with something other than a string');
    return { apply: (loc) => loc.filter({ hasText: exactText(t) }), score: `text=${JSON.stringify(t)}` };
  }
  const kids = parts.map((x) => child.exec(x)?.[1]);
  if (kids.every(Boolean)) {
    const sels = kids.map((k) => { const [v] = literals(k); if (typeof v !== 'string') throw new NotGradable('$() needs a selector string'); return wdioSelector(v); });
    return { apply: (loc, page) => loc.filter({ has: sels.map((x) => x.inside(page)).reduce((x, y) => x.or(y)) }), score: sels[0].scoreValue };
  }
  throw new NotGradable('its callback is not one COR reads (isDisplayed(), getText() === …, $(…).isExisting()) — pass the element\'s locator instead');
}

/** One WebdriverIO step: $ / $$ inside the element, [n], parentElement(), and .filter / .find with a callback COR reads. */
function wdioStep({ name, raw, n }) {
  if (name === '[]') return { apply: (loc) => loc.nth(Number(n)), pick: true };
  if (name === '$' || name === '$$') {
    const [a] = literals(raw);
    if (typeof a !== 'string') throw new NotGradable(`.${name}() needs a selector string`);
    const sel = wdioSelector(a);
    return { apply: (loc, page) => loc.locator(sel.inside(page)), score: sel.scoreValue };
  }
  if (name === 'parentElement') return { apply: (loc) => loc.locator('xpath=..') };
  if (name === 'filter') return wdioCallback(raw);
  if (name === 'find') {
    // find takes the first element that passes: one element, picked by position when several pass (flagged, as .first() is).
    const st = wdioCallback(raw);
    return { ...st, apply: (loc, page) => st.apply(loc, page).first(), pick: true, filtered: st.apply };
  }
  throw new NotGradable(`.${name}() ${ACTION}`);
}

/** `src` with the unquoted identifier `param` replaced by `value` as a string literal. */
export function substituteParam(src, param, value) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      // P5: `${param}` inside a template literal is filled with the value, escaped for that literal.
      if (quote === '`' && src.startsWith(`\${${param}}`, i)) {
        out += String(value).replace(/[\\`]/g, (c) => `\\${c}`).replace(/\$\{/g, '\\${');
        i += param.length + 2;
        continue;
      }
      out += ch;
      if (ch === '\\') { out += src[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (m) {
      const before = src[i - 1];
      const lit = `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      const after = src.slice(i + m[0].length).match(/^\s*(.)/)?.[1];
      const prevNonSpace = src.slice(0, i).trimEnd().slice(-1);
      const shorthand = m[0] === param && (prevNonSpace === '{' || prevNonSpace === ',') && (after === ',' || after === '}');
      // U4 (D6): `{ name: 'Add to cart' }` — an object key named like the parameter is not the parameter.
      const key = (prevNonSpace === '{' || prevNonSpace === ',') && after === ':';
      out += m[0] === param && before !== '.' && !key ? (shorthand ? `${param}: ${lit}` : lit) : m[0];
      i += m[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export { NotGradable };
