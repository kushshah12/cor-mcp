// U18 — parameterised locators. Runs in the page.
//
// An SDET writes one locator per SHAPE: `addToCart(product)` for 25 product
// cards, not 25 locators. When the inspected element is one of several items
// of the same shape, this finds the part that tells the items apart, builds a
// template around it, and checks every item's value before offering it.
//
// Measured on bstackdemo.com (2026-09-25): `.filter({ hasText: 'iPhone 12' })`
// matches 4 cards (12, 12 Mini, 12 Pro, 12 Pro Max); an exact title match gives
// 25/25. Only trying every value catches that, so a template is offered only
// when every value passes — otherwise no template, and the reason.
import { isUnstableClass, isUnstableValue, cssEscape } from '@corlabs/engine/core';
import { HEADING, INTERACTIVE, deepQueryAll, isControl, isShown, isVisible, roleAndName, squash, visibleLabelOf } from './dom.js';

const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
const NOT_A_SLOT = /^(id|class|style|href|src|srcset|tabindex|aria-.*|on.*|data-(v-|reactid|react|ng-).*)$/;
// ponytail: a price or count names nothing and changes with the data. Add a
// currency here only if a real page shows one missing.
const NUMERIC = /^[\s$€£¥₹\d.,:%+\-/x]*$/i;
const LABEL_MAX = 80;
const PATH_LIKE = /[/\\]|\.(png|jpe?g|svg|gif|webp|ico|css|js)$/i;

const text = (el) => squash(el?.textContent);
// A label is one piece of text: its children are inline markup or empty. A
// block holding several lines ("$ 150 / month (billed annually) Large team?")
// reads differently to Playwright's text match than to textContent.
const leafish = (el) => [...el.children].every((c) => !text(c) || getComputedStyle(c).display.startsWith('inline'));
const PRICE = /[$€£¥₹]\s?\d|\d\s?[$€£¥₹]/;
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; // JS string literal
const cssString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const xpathLiteral = (s) => {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
};
const camel = (s) => s.replace(/^data-/, '').replace(/[-_]+([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Classes that can name an element here: not generated, fewest page matches
 * first. Framework classes (Bootstrap's `card`) are allowed — the value check
 * decides whether a selector names exactly the items, not the class's origin.
 */
const namingClasses = (el) => [...el.classList].filter((c) => !isUnstableClass(c))
  .sort((a, b) => document.getElementsByClassName(a).length - document.getElementsByClassName(b).length);

/** The repeats: visible elements the target could be confused with, same shape. */
function repeatsOf(target) {
  if (isControl(target)) {
    const { role, name } = roleAndName(target);
    if (!name) return [];
    return deepQueryAll(isControl).filter((el) => {
      if (el === target) return true;
      if (!isVisible(el)) return false;
      const other = roleAndName(el);
      return other.role === role && other.name === name;
    });
  }
  // Not in the interactive list (a React-handled <div>): same tag and text.
  const own = text(target);
  if (!own || own.length > LABEL_MAX) return [];
  return [...document.getElementsByTagName(target.tagName)].filter((el) => el === target || (isVisible(el) && text(el) === own));
}

/** The item a repeat sits in: its highest ancestor holding no other repeat. */
function itemOf(el, repeats) {
  let item = el;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (repeats.some((r) => r !== el && p.contains(r))) break;
    item = p;
  }
  return item;
}

/**
 * A selector naming every item and nothing between them. U6 (D1): a test attribute all items share first
 * (saucedemo's `[data-test="inventory-item"]`), then tag + a class all share — the SDET order, since an item
 * scope has no role or name of its own.
 */
function itemSelector(items) {
  const sel = itemSelectorOf(items);
  // G1d/G1b: rows named by tag or class also take in the header row (all <th>), so "Every item" looped over it.
  // Data rows hold a <td>; when every item does and a matched non-item does not, say so in the selector.
  if (sel && items[0].tagName === 'TR' && items.every((r) => r.querySelector(':scope > td'))
    && [...document.querySelectorAll(sel.css)].some((r) => !items.includes(r) && !r.querySelector(':scope > td'))) {
    return { css: `${sel.css}:has(> td)`, xpath: `${sel.xpath}[td]` };
  }
  return sel;
}
function itemSelectorOf(items) {
  const [first] = items;
  const tag = first.tagName.toLowerCase();
  if (!items.every((i) => i.tagName === first.tagName)) return null;
  for (const a of TEST_ATTRS) {
    const v = first.getAttribute(a);
    if (v && !isUnstableValue(v, a) && items.every((i) => i.getAttribute(a) === v)) return { css: `[${a}=${cssString(v)}]`, xpath: `//*[@${a}=${xpathLiteral(v)}]` };
  }
  const shared = namingClasses(first).find((c) => items.every((i) => i.classList.contains(c)));
  if (shared) return { css: `${tag}.${cssEscape(shared)}`, xpath: `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${shared} ')]` };
  // Rows and list items do not nest in practice; anything else needs a class.
  if (['tr', 'li', 'article'].includes(tag)) return { css: tag, xpath: `//${tag}` };
  return null;
}

// P3a: the target inside its item, for the WebdriverIO and Cypress renderers — checked in EVERY item, not only the target's.
const LEAF_ATTRS = [...TEST_ATTRS, 'name', 'aria-label', 'value', 'title', 'alt'];
/**
 * U6 (D1): a per-item test id (`add-to-cart-sauce-labs-backpack`) shared up to a word boundary (`add-to-cart-`):
 * `[data-test^="add-to-cart-"]`, longest prefix first. Only offered by the callers when it matches exactly one
 * element in EVERY item, so a prefix that also names a sibling control is never used.
 */
function testIdPrefixes(target) {
  const tag = target.tagName.toLowerCase();
  return TEST_ATTRS.flatMap((a) => {
    const v = target.getAttribute(a);
    if (!v) return [];
    const cuts = [...v.matchAll(/[-_]/g)].map((m) => m.index + 1).filter((n) => n >= 3 && n < v.length).reverse();
    return cuts.map((n) => `${tag}[${a}^=${cssString(v.slice(0, n))}]`);
  });
}
function leafCss(target, item, items) {
  const tag = target.tagName.toLowerCase();
  const tries = [...LEAF_ATTRS.flatMap((a) => {
    const v = target.getAttribute(a);
    return v && !PATH_LIKE.test(v) && !isUnstableValue(v, a) ? [`${tag}[${a}=${cssString(v)}]`] : [];
  }), ...testIdPrefixes(target)];
  const names = namingClasses(target);
  const cls = names.find((c) => !c.includes('--')) ?? names[0];
  if (cls) tries.push(`${tag}.${cssEscape(cls)}`);
  tries.push(tag);
  // Hidden twins count: `$(css)` takes the first match, shown or not.
  return tries.find((sel) => items.every((it) => it.querySelectorAll(sel).length === 1) && item.querySelector(sel) === target) ?? null;
}

/**
 * P3b: the target inside each item as CSS for Cypress's `.find()`. Exactly one SHOWN match per item; when an item holds twins of
 * the target (a Choose per toggle state) the selector must match every twin — a class that names one state's button would break
 * when the toggle changes — and the helper filters `:visible`. `shown` says that filter is needed.
 */
function leafCssCy(target, item, items, named) {
  const tag = target.tagName.toLowerCase();
  const twinsIn = (it) => (named ? [...it.querySelectorAll('*')].filter((el) => isControl(el) && roleAndName(el).role === named.role && roleAndName(el).name === named.name).length : 1);
  const tries = [...LEAF_ATTRS.flatMap((a) => {
    const v = target.getAttribute(a);
    return v && !PATH_LIKE.test(v) && !isUnstableValue(v, a) ? [`${tag}[${a}=${cssString(v)}]`] : [];
  }), ...testIdPrefixes(target)];
  const names = namingClasses(target);
  const cls = names.find((c) => !c.includes('--')) ?? names[0];
  if (cls) tries.push(`${tag}.${cssEscape(cls)}`);
  tries.push(tag);
  for (const sel of tries) {
    let shown = false;
    const ok = items.every((it) => {
      const hits = [...it.querySelectorAll(sel)];
      const twins = twinsIn(it);
      if (hits.length !== twins || hits.filter(isVisible).length !== 1) return false;
      if (twins > 1) shown = true;
      return true;
    });
    if (ok && item.querySelector(sel) && [...item.querySelectorAll(sel)].filter(isVisible)[0] === target) return { css: sel, shown };
  }
  return null;
}

/**
 * The elements WebdriverIO's `aria/<name>` finds under `root` (measured on 9.32, scripts/conformance): controls answering to
 * the name — hidden ones too — and elements with a role of their own (a heading) or an aria-label / title / placeholder equal
 * to it. Plain text (<p>, <span>) is found only when no control answers, so it is not counted here.
 */
function ariaHits(root, name) {
  return [...root.querySelectorAll('*')].filter((el) => {
    if (isControl(el)) return squash(roleAndName(el).name) === name;
    const named = ['aria-label', 'title', 'placeholder'].some((a) => el.getAttribute(a) === name);
    return named || ((el.matches(HEADING) || el.hasAttribute('role')) && squash(roleAndName(el).name) === name);
  });
}

/**
 * What `aria/<name>` finds inside each item. `twins`: more than one control of the target's role and name in an item
 * (BrowserStack's Team card holds a hidden Choose per toggle state) — the shown one is the answer, so the helper filters.
 * `ok` is false when anything else answers to the name.
 */
function ariaOf(target, items, role, name) {
  if (!name || name.includes('"')) return { ok: false, twins: false };
  let twins = false;
  for (const item of items) {
    const hits = ariaHits(item, name);
    if (!hits.length || hits.some((el) => !isControl(el) || roleAndName(el).role !== role)) return { ok: false, twins: false };
    if (hits.length > 1) twins = true;
  }
  return { ok: true, twins };
}

/** How to find the target inside its item: role + name, or its text. */
function innerOf(target, item, items) {
  const { role, name } = roleAndName(target);
  const tag = target.tagName.toLowerCase();
  const own = text(target);
  const hasRole = target.matches(INTERACTIVE) && role && name;
  const xpathStep = own === name || (!hasRole && own)
    ? `//${tag}[normalize-space()=${xpathLiteral(own)}]`
    : target.getAttribute('aria-label') === name ? `//${tag}[@aria-label=${xpathLiteral(name)}]`
      : target.getAttribute('value') === name ? `//${tag}[@value=${xpathLiteral(name)}]` : null;
  const inner = hasRole
    ? { code: `.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, pw: `role=${role}[name=${cssString(name)}s]`, xpath: xpathStep,
      count: (it) => [...it.querySelectorAll('*')].filter((el) => el.matches(INTERACTIVE) && isVisible(el) && (({ role: r, name: n }) => r === role && n === name)(roleAndName(el))).length }
    : { code: `.getByText(${q(own)}, { exact: true })`, pw: `text=${cssString(own)}`, xpath: xpathStep,
      // Playwright's text match takes the smallest element with that text.
      count: (it) => [...it.querySelectorAll('*')].filter((el) => text(el) === own && ![...el.children].some((c) => text(c) === own)).length };
  if (inner.count(item) !== 1) return null;
  const aria = hasRole ? ariaOf(target, items, role, name) : { ok: false, twins: false };
  // A css leaf is state-bound when the item holds twins of the target: the shown one changes with the toggle.
  const twins = hasRole && [...item.querySelectorAll('*')].some((el) => el !== target && isControl(el) && roleAndName(el).role === role && roleAndName(el).name === name);
  inner.leaf = { role: hasRole ? role : null, name: hasRole ? name : own, css: twins ? null : leafCss(target, item, items), aria: aria.ok, twins: aria.twins,
    cy: leafCssCy(target, item, items, hasRole ? { role, name } : null) };
  return inner;
}

/**
 * The ways an item's value can be read, best first: a test attribute on the
 * item, a visible label inside it, then another stable attribute on it.
 * Each returns the value for any item, or null when that item has none.
 */
function slotsFor(targetItem, target, { allowSelf = false } = {}) {
  // A path or an image file names a resource, not the item (BrowserStack's
  // side-menu groups: data-open-icon="/images/…/ac….svg").
  const attrs = [...targetItem.attributes].filter((a) => !NOT_A_SLOT.test(a.name) && !PATH_LIKE.test(a.value)).map((a) => a.name);
  const attrSlot = (attr) => ({
    kind: 'attribute', attr, param: TEST_ATTRS.includes(attr) ? 'testId' : camel(attr),
    valueOf: (item) => item.getAttribute(attr),
    matches: (item, v) => item.getAttribute(attr) === v,
  });

  // Labels: text inside the item but not the target's own. Headings first,
  // then anything whose class says title/name, then document order.
  const candidates = [...targetItem.querySelectorAll('*')].filter((el) =>
    !el.contains(target) && !target.contains(el) && isVisible(el) && text(el) &&
    text(el).length <= LABEL_MAX && leafish(el));
  // A name comes before the item's controls; a heading or line after them
  // titles a features list ("Desktop & Mobile, plus:"), not the item.
  // Visible controls only: a hidden toggle comes before its own label, and that label is a name ("Team").
  const firstControl = [...targetItem.querySelectorAll('*')].find((el) => isControl(el) && isVisible(el));
  const before = (el) => !firstControl || Boolean(el.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING);
  const rank = (el) => (before(el) ? 0 : 3) + (el.matches(HEADING) ? 0 : /title|name|heading|label/i.test(el.className) ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));
  // U18b.2: when the target IS the item's identifying text (an FAQ question),
  // its own text is the last choice of parameter.
  // Only when the item holds more than the target (an FAQ item has its
  // answer): a menu <li> holding just its link would give a template that
  // says nothing getByRole('link', { name }) does not.
  const more = [...targetItem.querySelectorAll('*')].some((el) => el !== target && !el.contains(target) && !target.contains(el) && squash(el.textContent));
  if (allowSelf && more && isVisible(target) && text(target) && text(target).length <= LABEL_MAX && leafish(target)) candidates.push(target);
  const labelSlots = [];
  for (const label of candidates) {
    // U6 (D1): a test attribute on the label (`[data-test="inventory-item-name"]`) before its class.
    const { sel, xpathSel } = labelSelector(label);
    // Every item is read by its FIRST such element, so the target's label must be its first.
    if (targetItem.querySelector(sel) !== label) continue;
    labelSlots.push({
      kind: 'label', sel, xpathSel, rank: rank(label),
      // U6: the test id names it as well as a class does (`data-test="inventory-item-name"` → name).
      param: /question/i.test(`${label.className} ${sel}`) ? 'question' : label.matches(HEADING) || /title/i.test(`${label.className} ${sel}`) ? 'title' : /name/i.test(`${label.className} ${sel}`) ? 'name' : columnHeader(label) ?? 'value',
      valueOf: (item) => text(item.querySelector(sel)),
      matches: (item, v) => [...item.querySelectorAll(sel)].some((el) => text(el) === v),
    });
  }
  // The plan's order: a test attribute, then what a person reads, then any other stable attribute.
  return [
    ...attrs.filter((a) => TEST_ATTRS.includes(a)).map((a) => ({ ...attrSlot(a), rank: -1 })),
    ...labelSlots,
    ...attrs.filter((a) => !TEST_ATTRS.includes(a)).map((a) => ({ ...attrSlot(a), rank: 10 })),
  ];
}

/** U6 (D1): how a name element is selected inside its item — a test attribute (any value), else tag + class, else tag. */
function labelSelector(el) {
  const tag = el.tagName.toLowerCase();
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    if (v && !isUnstableValue(v, a)) return { sel: `[${a}=${cssString(v)}]`, xpathSel: `*[@${a}=${xpathLiteral(v)}]` };
  }
  const cls = namingClasses(el)[0];
  return cls
    ? { sel: `${tag}.${cssEscape(cls)}`, xpathSel: `${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` }
    : { sel: tag, xpathSel: tag };
}

/** A table cell's column header, camel-cased, as the parameter name ("Last name" → lastName). */
function columnHeader(cell) {
  const td = cell.closest('td');
  const table = td?.closest('table');
  const th = table?.querySelectorAll('thead th, tr:first-child th')[td.cellIndex];
  const h = text(th).toLowerCase();
  return h && /^[a-z][a-z ]{0,20}$/.test(h) ? camel(h.replace(/ /g, '-')) : null;
}

// ── U18b.1: control groups ──────────────────────────────────────────────────
// Siblings of one role told apart by their names: a radio group, a tablist, a
// hidden toggle pair. BrowserStack pricing: both agents hand-wrote annually() /
// monthly() and the Teams/Individuals pair as copies.

/** A name as a parameter: "plan_type_selector" → planTypeSelector, "Product" → product. */
const toParam = (s) => {
  const words = String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length ? words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('') : null;
};

// The engine's changingValueIn / stableNamePrefix, kept local so the page
// bundle does not depend on an unmerged engine release.
const CHANGING = /[$€£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%(?![0-9A-Fa-f]{2})|[$€£¥₹])/;
function stableName(name) {
  if (!CHANGING.test(name)) return name;
  const kept = [];
  for (const seg of name.split(/\s*(?:[(|·,]|\s-\s)\s*/)) {
    if (CHANGING.test(seg)) break;
    kept.push(seg);
  }
  const prefix = kept.join(' ').replace(/[)\s]+$/, '').trim();
  return prefix.length >= 3 && /[A-Za-z]/.test(prefix) ? prefix : null;
}

/** The group the target belongs to, or null. */
function groupOf(target) {
  if (target.matches('input[type="radio"], input[type="checkbox"]') && target.name) {
    const members = [...document.querySelectorAll(`input[type="${target.type}"][name="${CSS.escape(target.name)}"]`)].filter(isShown);
    return { members, role: target.type, param: toParam(target.name), what: `${target.type} group` };
  }
  const role = target.getAttribute('role');
  const holder = role === 'tab' ? target.closest('[role="tablist"]') : role === 'radio' ? target.closest('[role="radiogroup"]') : null;
  if (!holder) return null;
  const members = [...holder.querySelectorAll(`[role="${role}"]`)].filter(isShown);
  return { members, role, param: toParam(holder.getAttribute('aria-label')) ?? role, what: role === 'tab' ? 'tablist' : 'radio group' };
}

/** The nearest named container the labels share (a base class, not a BEM modifier), as a CSS selector; null when none names them. */
function labelScope(labels) {
  for (let a = labels[0].parentElement; a && a !== document.body; a = a.parentElement) {
    if (!labels.every((l) => a.contains(l))) continue;
    // A base class, not a BEM modifier: `card-toggle--medium` is a size; a restyle changes it.
    const names = namingClasses(a);
    const cls = names.find((c) => !c.includes('--')) ?? names[0];
    if (cls) return `${a.tagName.toLowerCase()}.${cssEscape(cls)}`;
  }
  return null;
}

/**
 * U18b.1. A template whose parameter is the option's name, checked for every
 * option; null when the target is not in a group of two or more.
 */
function groupTemplate(target) {
  const group = groupOf(target);
  if (!group || group.members.length < 2 || !group.members.includes(target)) return null;
  const { members, role, param, what } = group;
  const names = members.map((m) => squash(roleAndName(m).name));
  const values = names.map((n) => stableName(n));
  const count = members.length;
  if (values.some((v) => !v)) return { count, kind: 'group', what, reason: 'an option has no name to tell it by' };
  const dup = values.find((v, i) => values.indexOf(v) !== i);
  if (dup) return { count, kind: 'group', what, reason: `two options share the name "${dup}"` };
  const exact = values.every((v, i) => v === names[i]);

  // Hidden inputs shown by their labels are out of the accessibility tree:
  // Playwright reaches them by label, and a user changes them by clicking it.
  const viaLabel = members.map((m) => Boolean(visibleLabelOf(m)));
  if (viaLabel.some(Boolean) && !viaLabel.every(Boolean)) return { count, kind: 'group', what, reason: 'some options are hidden inputs and some are not' };
  const hidden = viaLabel[0];
  const lower = (s) => s.toLowerCase();
  // The check, in Playwright's terms: each value finds exactly its own option.
  const finds = (v) => (hidden
    ? members.filter((m) => [...(m.labels ?? [])].some((l) => (exact ? squash(l.textContent) === v : lower(squash(l.textContent)).includes(lower(v)))))
    : deepQueryAll(`[role="${role}"], input[type="${role}"]`).filter((el) => isVisible(el) && roleAndName(el).role === role
      && (exact ? squash(roleAndName(el).name) === v : lower(squash(roleAndName(el).name)).includes(lower(v)))));
  if (!values.every((v, i) => { const hit = finds(v); return hit.length === 1 && hit[0] === members[i]; })) {
    return { count, kind: 'group', what, reason: 'an option\'s name also names another element on the page' };
  }
  const opt = exact ? ', { exact: true }' : '';
  const out = {
    count, kind: 'group', what, param, value: values[members.indexOf(target)], values,
    code: hidden ? `page.getByLabel(${param}${opt})` : `page.getByRole(${q(role)}, { name: ${param}${exact ? ', exact: true' : ''} })`,
    template: {
      playwright: { selectorTemplate: hidden ? `internal:label="__${param}__"${exact ? 's' : 'i'}` : `internal:role=${role}[name="__${param}__"${exact ? 's' : 'i'}]`, syntax: 'css-string' },
      // What getByRole / getByLabel generate: `i` is part of the name,
      // case-insensitive; `s` is the exact name. The public `role=` engine
      // matches a quoted name exactly, so "Annually" would miss its radio.
      xpath: null,
    },
  };
  // P3a: what the WebdriverIO renderer reads. `aria/<name>` must find exactly this option page-wide (measured semantics: ariaHits).
  const model = {
    kind: 'group', param, role, hidden: Boolean(hidden), label: null,
    aria: exact && members.every((m, i) => { const hits = ariaHits(document.body, names[i]); return hits.length === 1 && hits[0] === m; }),
  };
  // P3b: what the Cypress renderer reads — the option's label (wrapping or `for`), or its own text when it has a role attribute.
  model.cy = (() => {
    if (!exact) return null;
    if (members.every((m) => m.tagName === 'INPUT')) {
      const labels = members.map((m) => (m.labels?.length === 1 ? m.labels[0] : null));
      if (labels.some((l) => !l)) return null;
      const scope = labelScope(labels);
      const root = scope && document.querySelectorAll(scope).length === 1 ? document.querySelector(scope) : document.body;
      const ok = labels.every((l, i) => { const hit = [...root.querySelectorAll('label')].filter((x) => text(x) === names[i]); return hit.length === 1 && hit[0] === l; });
      return ok ? { kind: 'label', scope: root === document.body ? null : scope } : null;
    }
    const sel = `[role="${role}"]`;
    const ok = members.every((m, i) => { const hit = [...document.querySelectorAll(sel)].filter((x) => text(x) === names[i]); return hit.length === 1 && hit[0] === m; });
    return ok ? { kind: 'role', selector: sel } : null;
  })();
  out.model = model;
  if (hidden) {
    // U21: scoped to the nearest named container the labels share, so the
    // same words elsewhere (marketing copy) do not break the click. Playwright
    // counts it in verifyTemplate; a scope that does not single the label out
    // falls back to the page-wide form.
    const labels = members.map(visibleLabelOf);
    const scope = labelScope(labels);
    out.act = scope ? `page.locator(${q(scope)}).getByText(${param}${opt})` : `page.getByText(${param}${opt})`;
    // P3a: WebdriverIO clicks `label=<name>` (exact text) inside the scope when that names exactly this option's label.
    const root = scope && document.querySelectorAll(scope).length === 1 ? document.querySelector(scope) : document.body;
    const clickable = exact && labels.every((l, i) => { const hit = [...root.querySelectorAll('label')].filter((x) => text(x) === values[i]); return hit.length === 1 && hit[0] === l; });
    model.label = clickable ? { scope: root === document.body ? null : scope } : null;
    // P2a fix: each option's label text names exactly one label on the whole page — WebdriverIO then finds the hidden
    // input through its label by XPath (aria/ misses a display: none input).
    model.labelUnique = exact && labels.every((l, i) => { const hit = [...document.querySelectorAll('label')].filter((x) => text(x) === values[i]); return hit.length === 1 && hit[0] === l; });
  }
  return out;
}

/**
 * U18. The target's parameterised template, or why there is none; null when
 * the target is not one of several items.
 */
export function parameterise(target) {
  const group = groupTemplate(target);
  if (group) return group;
  const cell = cellTemplate(target);
  if (cell) return cell;
  const repeats = repeatsOf(target);
  if (repeats.length < 2) return structuralTemplate(target);
  const targetItem = itemOf(target, repeats);
  if (targetItem === target) return null; // the repeat IS the item: nothing contains it
  const items = repeats.map((r) => itemOf(r, repeats)).filter((i) => i.tagName === targetItem.tagName);
  // Lookalikes of other shapes (a card's "Choose" and the comparison table's)
  // can leave the target the only item of its shape: nothing to parameterise.
  // BrowserStack pricing rendered "1 items share this shape (1/1)" without this.
  // P3 per-card entries: a text copied elsewhere (the sticky bar's compact "$ 375 / month") still sits in repeated cards.
  if (items.length < 2) return isControl(target) ? null : structuralTemplate(target);
  const itemSel = itemSelector(items);
  if (!itemSel) return { count: items.length, reason: 'the items share no class or tag that names them' };
  const inner = innerOf(target, targetItem, items);
  if (!inner) return { count: items.length, reason: 'the element is not the only one of its kind inside its item' };
  return templateFor(target, targetItem, items, itemSel, inner);
}

// ── U19.2: a stable scope before visible: true ──────────────────────────────
// Attributes that describe state are not scopes (BrowserStack's
// data-plan-type-visible="true" flips as tabs change).
const STATE_ATTR = /visible|hidden|active|open|expanded|selected|checked|state|current|show/i;

/**
 * The nearest ancestor attribute whose scope holds every item and matches no
 * hidden copy, as { css, xpath } — e.g. div[data-product-id="live"] — or null.
 */
export function stableScope(items, css) {
  for (let a = items[0].parentElement; a && a !== document.body; a = a.parentElement) {
    if (!items.every((it) => a.contains(it))) continue;
    const tag = a.tagName.toLowerCase();
    for (const { name, value } of a.attributes) {
      if (NOT_A_SLOT.test(name) || STATE_ATTR.test(name) || !value || /^(true|false)$/i.test(value)
        || PATH_LIKE.test(value) || isUnstableValue(value, name)) continue;
      const scopeCss = `${tag}[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      let hits;
      try {
        hits = [...document.querySelectorAll(`${scopeCss} ${css}`)];
      } catch {
        continue;
      }
      if (hits.every(isVisible) && items.every((it) => hits.includes(it))) {
        return { css: scopeCss, xpath: `//${tag}[@${name}=${xpathLiteral(value)}]` };
      }
    }
  }
  return null;
}

// ── U19.3: candidate values for cor_grade across every value ────────────────
/**
 * An item's naming texts, best first: text before its first visible control,
 * headings and title/name/label classes first; never numbers or prices.
 */
export function itemTexts(item) {
  const firstControl = [...item.querySelectorAll('*')].find((el) => isControl(el) && isVisible(el));
  const before = (el) => !firstControl || Boolean(el.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING);
  const rank = (el) => (before(el) ? 0 : 3) + (el.matches(HEADING) ? 0 : /title|name|heading|label|question/i.test(el.className) || el.tagName === 'LABEL' ? 1 : 2);
  const els = [...item.querySelectorAll('*')].filter((el) => isVisible(el) && text(el) && text(el).length <= LABEL_MAX && leafish(el)
    && !(el.matches(INTERACTIVE) && !el.matches('label')) && !NUMERIC.test(text(el)) && !PRICE.test(text(el)));
  els.sort((a, b) => rank(a) - rank(b));
  return [...new Set(els.map(text))].slice(0, 12);
}

// ── U18b.5: toggled variants ────────────────────────────────────────────────
// An item named by a toggle label holds other variants behind that toggle
// (BrowserStack's Team card: Team and Team Pro). The template finds the item
// by a variant's name, but shows the variant only after its label is clicked.
// The Playwright agent discovered this by hand; the COR agent never tested it.

/** For each item named by a toggle label: its other labels, each checked to pick exactly that item. */
function variantsOf(items, slot, values, all) {
  if (slot.kind !== 'either' && slot.kind !== 'label') return [];
  const sels = slot.kind === 'either' ? slot.sels.map((x) => x.sel) : [slot.sel];
  const out = [];
  items.forEach((item, i) => {
    const naming = sels.map((sel) => item.querySelector(sel)).find((el) => el && text(el) === values[i]);
    // The name may sit inside the label (BrowserStack: span.card-toggle__label).
    const input = naming?.closest('label')?.control ?? null;
    if (!input || !/^(radio|checkbox)$/i.test(input.type) || !input.name) return;
    const others = [...item.querySelectorAll(`input[type="${input.type}"][name="${CSS.escape(input.name)}"]`)]
      .filter((r) => r !== input)
      .map((r) => text([...(r.labels ?? [])].find(isVisible)))
      .filter((v) => v && !values.includes(v))
      .filter((v) => { const hit = all.filter((el) => slot.matches(el, v)); return hit.length === 1 && hit[0] === item; });
    if (others.length) out.push({ of: values[i], values: others });
  });
  return out;
}

// ── U18b.4: row × column cells ──────────────────────────────────────────────
// A cell addressed by its row's key and its column's header: one XPath with
// two parameters (XPath can compute the column's position; a Playwright
// locator cannot). From the BrowserStack comparison: both agents read one
// comparison cell inline with a hand-computed column index.

/** The table as an XPath step: by id, by a naming class, or alone on the page. */
function tableStep(table) {
  if (table.id && !/\d{3,}/.test(table.id)) return `//table[@id=${xpathLiteral(table.id)}]`;
  const cls = namingClasses(table)[0];
  if (cls) return `//table[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]`;
  return document.querySelectorAll('table').length === 1 ? '//table' : null;
}

const isSectionRow = (r) => r.cells.length === 1 && r.cells[0].colSpan > 1;
/** A header row: header cells only (a blank corner cell allowed), none of them a row header. */
const isHeaderRow = (r) => r.cells.length > 1 && Boolean(r.querySelector('th'))
  && ![...r.cells].some((c) => c.getAttribute('scope') === 'row' || (c.tagName === 'TD' && text(c)));

/**
 * U19.4. The header row for a table that has none of its own: the nearest
 * table before it, under a shared ancestor, whose header row is as wide.
 * BrowserStack's comparison puts the plan headers in their own table above
 * one table per feature group.
 */
function separateHeader(table, width) {
  for (let a = table.parentElement; a && a !== document.body; a = a.parentElement) {
    const before = [...a.querySelectorAll('table')].filter((t) => t !== table && isVisible(t)
      && (t.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING));
    const row = before.reverse().map((t) => [...t.rows].find((r) => isHeaderRow(r) && r.cells.length === width)).find(Boolean);
    if (row) return row;
  }
  return null;
}

/**
 * A cell's name: its text; or, when a visible heading names it ("Team Ultimate"
 * over "$ 375 / month"), that heading; or, when the cell also holds a price or
 * hidden text (a tooltip), its first visible line of text that is not a number
 * — BrowserStack's "Team" is a toggle label, and "Bug Capture" hides its
 * description in a tooltip.
 */
function cellName(c) {
  const heading = [...c.querySelectorAll(HEADING)].find(isVisible);
  if (heading) return { name: text(heading), part: true };
  const whole = squash(c.textContent);
  const hidden = [...c.querySelectorAll('*')].some((el) => text(el) && !isVisible(el));
  if (!PRICE.test(whole) && !hidden) return { name: whole, part: false };
  const leaf = [...c.querySelectorAll('*')].find((el) => isVisible(el) && text(el) && ![...el.children].some(text)
    && !NUMERIC.test(text(el)) && !PRICE.test(text(el)));
  return leaf ? { name: text(leaf), part: true } : null;
}

const xpathCount = (xp) => {
  try {
    return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  } catch {
    return null;
  }
};
const soleHit = (xp, el) => {
  const hits = xpathCount(xp);
  return hits?.snapshotLength === 1 && hits.snapshotItem(0) === el;
};

/** A cell's column name, from its table's header row or a separate header table; null when there is none. */
export function columnNameOf(cell) {
  const row = cell.parentElement;
  const table = cell.closest('table');
  if (!table || !row?.cells) return null;
  const header = [...table.rows].find(isHeaderRow) ?? separateHeader(table, row.cells.length);
  if (!header || header === row || header.cells.length !== row.cells.length) return null;
  return cellName(header.cells[cell.cellIndex])?.name || null;
}

/** U18b.4. Null when the target is not a table cell's content (a control keeps U18's row template). */
function cellTemplate(target) {
  const cell = target.closest('td, th');
  if (!cell || (target !== cell && isControl(target))) return null;
  const table = cell.closest('table');
  const row = cell.parentElement;
  // Full-width group rows ("TESTING TOOLKIT UTILITIES") title rows; they are not rows.
  const all = [...table.rows].filter((r) => !isSectionRow(r));
  if (!all.includes(row)) return null;
  const own = all.find(isHeaderRow);
  const header0 = own ?? separateHeader(table, row.cells.length);
  if (!header0 || header0 === row) return null;
  // Checked before anything that counts cells: with a span, rows and header differ in length.
  if ([...all, header0].some((r) => [...r.cells].some((c) => c.colSpan > 1))) {
    return { kind: 'cell', count: all.length - 1, reason: 'a header or cell spans more than one column, so positions do not line up' };
  }
  const body = all.filter((r) => r !== header0 && isVisible(r) && r.cells.length === header0.cells.length);
  if (!body.includes(row)) return null;
  const no = (reason) => ({ kind: 'cell', count: body.length, reason });
  const headerNames = [...header0.cells].map(cellName);
  const headers = headerNames.map((n) => n?.name ?? '');
  const dup = (list) => list.find((v, i) => list.indexOf(v) !== i);
  // The key column: a row header (scope="row") first, else the first whose
  // cells all name their row — text, unique, not a price. A leading checkbox
  // or actions column is skipped (selectorshub).
  const names = (i) => body.map((r) => cellName(r.cells[i]));
  const keys = (i) => names(i).map((n) => n?.name ?? '');
  const order = [...headers.keys()].sort((a, b) => Number(cell.parentElement.cells[b]?.getAttribute('scope') === 'row') - Number(cell.parentElement.cells[a]?.getAttribute('scope') === 'row'));
  const k = order.find((i) => {
    const ks = keys(i);
    return ks.every((v) => v && !PRICE.test(v)) && !dup(ks);
  }) ?? -1;
  if (k === -1) {
    const first = body.map((r) => squash(r.cells[0].textContent));
    return no(dup(first) ? `two rows share the key "${dup(first)}"` : 'no column names every row with unique text');
  }
  const rows = keys(k);
  // Columns without header text are left out as values; the target's must have one.
  const columns = headers.filter(Boolean);
  if (!headers[cell.cellIndex]) return no('the column has no header text');
  if (dup(columns)) return no(`two columns share the header "${dup(columns)}"`);
  const T = tableStep(table);
  if (!T) return no('the table has no id or class to name it by');
  let inner = '';
  if (target !== cell) {
    const tag = target.tagName.toLowerCase();
    const cls = namingClasses(target)[0];
    inner = `//${tag}${cls ? `[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : ''}`;
    const hits = document.evaluate(`.${inner}`, cell, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (hits.snapshotLength !== 1 || hits.snapshotItem(0) !== target) return no('the element is not the only one of its kind in its cell');
  }
  const rp = toParam(headers[k]) ?? 'row';
  const cp = rp === 'column' ? 'col' : 'column';
  // A name that is part of its cell is matched on the element holding it.
  const is = (part, v) => (part ? `descendant-or-self::*[normalize-space()=${v}]` : `normalize-space()=${v}`);
  const rowPart = names(k).some((n) => n.part);
  const colPart = headerNames.some((n) => n?.part);
  // U21: the header table's first row of several header cells — never its
  // width, so a plan column added later is fine. The header table comes
  // before the rows (separateHeader), so [1] never reaches a data row; a
  // title row above the header ("Compare plans", one spanning cell) is skipped.
  const HEADER_ROW = 'tr[count(th)>1]';
  const partsFor = (scope) => {
    const tables = `${scope}${T}`;
    let header = `(${tables}//tr[th])[1]`;
    if (!own) {
      const ht = tableStep(header0.closest('table'));
      if (!ht) return null;
      header = `(${scope}${ht}//${HEADER_ROW})[1]`;
    }
    return { tables, header, sameTable: own || tableStep(header0.closest('table')) === T };
  };
  const xpathOf = ({ tables, header }, rv, cv) =>
    `${tables}//tr[*[${k + 1}][${is(rowPart, rv)}]]/*[count(${header}/*[${is(colPart, cv)}]/preceding-sibling::*)+1]${inner}`;
  const fill = (parts) => xpathOf(parts, xpathLiteral(rows[body.indexOf(row)]), xpathLiteral(headers[cell.cellIndex]));
  // A hidden copy of the table (another product's tab) needs a stable scope.
  let parts = partsFor('');
  let scopeCss = '';
  // P3: with an element inside the cell, the cell itself must be singled out too — the target's own combination can be unique
  // across every product's table (one checkmark) while another row's is not (live BrowserStack: Geolocation counted 3).
  const cellOnly = (parts) => fill(parts).slice(0, fill(parts).length - inner.length);
  // …and every combination the template is checked on: Bug Capture × Volume was unique page-wide, Bug Capture × Feature List
  // was not (a hidden product's copy), so the unscoped template was refused for the whole Volume and Enterprise columns.
  const ambiguous = (p) => [...columns.map((cv) => [rows[body.indexOf(row)], cv]), ...rows.map((rv) => [rv, headers[cell.cellIndex]])]
    .some(([rv, cv]) => { const x = xpathOf(p, xpathLiteral(rv), xpathLiteral(cv)); return (xpathCount(inner ? x.slice(0, -inner.length) : x)?.snapshotLength ?? 0) > 1; });
  if (parts && (!soleHit(fill(parts), target) || (inner && !soleHit(cellOnly(parts), cell)) || ambiguous(parts))) {
    const scope = stableScope(own ? [table] : [table, header0.closest('table')], 'table');
    parts = scope ? partsFor(scope.xpath) : null;
    if (scope) scopeCss = `${scope.css} `;
  }
  if (!parts) return no('the row and column names do not single out the cell');
  const xp = xpathOf(parts, `__${rp}__`, `__${cp}__`);
  // What an SDET can review: the same XPath, built from named parts.
  const js = (x) => JSON.stringify(x);
  const headerCode = own ? `\`(\${tables}//tr[th])[1]\`` : parts.sameTable ? `\`(\${tables}//${HEADER_ROW})[1]\`` : js(parts.header);
  const code = [
    `(${rp}, ${cp}) => {`,
    `  const tables = ${js(parts.tables)};`,
    `  const header = ${headerCode};`,
    `  const row = \`\${tables}//tr[*[${k + 1}][${is(rowPart, `"\${${rp}}"`)}]]\`;`,
    `  const columnNo = \`count(\${header}/*[${is(colPart, `"\${${cp}}"`)}]/preceding-sibling::*) + 1\`;`,
    `  return page.locator(\`xpath=\${row}/*[\${columnNo}]${inner}\`);`,
    '}',
  ].join('\n');
  // P3b: Cypress has no XPath, so the same lookup in CSS — the header cell's position, then the row by its key cell. Only for plain
  // cell names (text is the name); each combination is emulated here and must reach the very cell the XPath form proved.
  const cyModel = (() => {
    if (!parts) return null;
    // P3: a name that is part of its cell (BrowserStack: the feature name in a span beside a tooltip; the plan name in an h3 above
    // the price) is found by the element holding it — tag and class, a list when the cells differ — then .closest() the cell.
    const holderSel = (cells, vals) => {
      const sels = new Set();
      cells.forEach((c, i) => {
        if (!vals[i]) return;
        // a cell whose whole text is its name ("Feature List") is its own holder: '' means the cell itself
        const el = text(c) === vals[i] ? null
          : [...c.querySelectorAll('*')].find((e) => isVisible(e) && text(e) === vals[i] && ![...e.children].some((ch) => text(ch) === vals[i]));
        sels.add(el ? `${el.tagName.toLowerCase()}${namingClasses(el)[0] ? `.${cssEscape(namingClasses(el)[0])}` : ''}` : text(c) === vals[i] ? '' : '?');
      });
      return sels.size && !sels.has('?') ? [...sels] : null;
    };
    const rowHolder = rowPart ? holderSel(body.map((r) => r.cells[k]), rows) : null;
    const colHolder = colPart ? holderSel([...header0.cells], headers) : null;
    if ((rowPart && !rowHolder) || (colPart && !colHolder)) return null;
    const tcss = (t) => {
      if (t.id && !/\d{3,}/.test(t.id)) return `table#${cssEscape(t.id)}`;
      const c = namingClasses(t)[0];
      return c ? `table.${cssEscape(c)}` : document.querySelectorAll('table').length === 1 ? 'table' : null;
    };
    const T = tcss(table);
    const HT = own ? T : tcss(header0.closest('table'));
    if (!T || !HT) return null;
    const under = (base, holder) => (holder ? holder.map((h) => (h ? `${base} ${h}` : base)).join(', ') : base);
    const headerSel = under(`${scopeCss}${HT} tr:has(th) th`, colHolder);
    const keySel = under(`${scopeCss}${T} tr > :nth-child(${k + 1})`, rowHolder);
    let innerCss = '';
    if (target !== cell) innerCss = `${target.tagName.toLowerCase()}${namingClasses(target)[0] ? `.${cssEscape(namingClasses(target)[0])}` : ''}`;
    let ok = true;
    try {
      const expectedFor = (rv, cv) => {
        const hits = xpathCount(xpathOf(parts, xpathLiteral(rv), xpathLiteral(cv)));
        return hits?.snapshotLength === 1 ? hits.snapshotItem(0) : null;
      };
      const emulate = (rv, cv) => {
        const th = [...document.querySelectorAll(headerSel)].find((x) => text(x) === cv)?.closest('th');
        const key = [...document.querySelectorAll(keySel)].find((x) => text(x) === rv);
        const c = th && key ? key.closest('tr')?.children[[...th.parentElement.children].indexOf(th)] : null;
        return innerCss && c ? c.querySelector(innerCss) : c;
      };
      const combos = [...columns.map((cv) => [rows[body.indexOf(row)], cv]), ...rows.map((rv) => [rv, headers[cell.cellIndex]])];
      // P3: with an element inside the cell, a cell lacking it is found as nothing by both (the XPath's count was checked).
      ok = combos.every(([rv, cv]) => { const want = expectedFor(rv, cv); return (want || innerCss) && emulate(rv, cv) === want; });
    } catch {
      ok = false;
    }
    return ok ? { headerSel, keySel, innerCss, headerInCell: Boolean(colHolder) } : null;
  })();
  return {
    // P3a: the same parts the Playwright helper is built from — WebdriverIO takes XPath natively.
    model: { kind: 'cell', vars: [rp, cp], tables: parts.tables, headerExpr: headerCode, k: k + 1, rowPart, colPart, inner, cy: cyModel },
    kind: 'cell', count: body.length, vars: [rp, cp], rows, columns, separateHeader: !own,
    row: rows[body.indexOf(row)], column: headers[cell.cellIndex], code,
    // The placeholders ARE the XPath literals: the client quotes and escapes them.
    template: { playwright: { selectorTemplate: `xpath=${xp}`, syntax: 'xpath-literal' }, xpath: { selectorTemplate: xp, syntax: 'xpath-literal' } },
  };
}

// ── U18b.2: structural repeats ──────────────────────────────────────────────
// Items that share a class rather than a name (FAQ items), and a target that
// may be a non-control inside each (the hidden answer). From the BrowserStack
// comparison: both agents built the FAQ locator inline for one question.

/** The target's nearest ancestor with like siblings (same tag, a shared class), and those siblings. */
function structuralRepeats(target) {
  for (let a = target.parentElement; a && a !== document.body; a = a.parentElement) {
    const names = namingClasses(a);
    if (!names.length || !isVisible(a)) continue;
    const likes = [...(a.parentElement?.children ?? [])].filter((sib) => sib.tagName === a.tagName && isVisible(sib) && names.some((c) => sib.classList.contains(c)));
    if (likes.length >= 2) return { item: a, items: likes };
  }
  return null;
}

/**
 * The target inside each item by its tag and class: exactly one SHOWN per item, and the target in its own. P3 per-card
 * entries: an item may hold hidden twins (BrowserStack's Team card keeps a price per toggle state) — the leaf then filters
 * to the shown one — and items without the element (Volume has no price) are left out of the template's values.
 */
function cssInner(target, targetItem, items) {
  const tag = target.tagName.toLowerCase();
  const cls = namingClasses(target)[0];
  const sel = cls ? `${tag}.${cssEscape(cls)}` : tag;
  // One match per item, shown or not (a closed FAQ's answers are all hidden); several only when exactly one is shown.
  const pick = (it) => { const all = [...it.querySelectorAll(sel)]; const shown = all.filter(isVisible); return all.length === 1 ? all : shown; };
  const holding = items.filter((it) => it.querySelector(sel));
  if (holding.length < 2 || !holding.every((it) => pick(it).length === 1) || pick(targetItem)[0] !== target) return null;
  const twins = holding.some((it) => it.querySelectorAll(sel).length > 1);
  // A per-item form by class alone is unsafe when the class names different repeated controls (Remove in one item, Add to cart
  // in five): one name everywhere (Choose) or a name per item (each FAQ question) is safe.
  const names = holding.map((it) => pick(it)[0]).map((el) => (isControl(el) ? roleAndName(el).name : text(el)));
  const own = names[holding.indexOf(targetItem)];
  const mixed = isControl(target) && new Set(names).size < names.length && names.some((n) => n !== own);
  return {
    items: holding,
    code: `.locator(${q(sel)})${twins ? '.filter({ visible: true })' : ''}`, pw: twins ? `${sel}:visible` : sel,
    // XPath cannot say "visible": with twins there is no XPath form.
    xpath: twins ? null : `//${tag}${cls ? `[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : ''}`,
    count: (it) => pick(it).length,
    // control: the class also names other controls in other items — no per-item form (see `mixed`)
    leaf: { role: null, name: text(target), css: twins ? null : sel, shownCss: twins ? sel : null, aria: false, cy: { css: sel, shown: twins }, control: mixed },
  };
}

/**
 * P3 (run b14ddae4): the target IS what names its item, and the items are named by one of two elements (BrowserStack: an h3 on
 * Team Ultimate, a toggle label on Team). The leaf is then the name, whichever element holds it — a title template built on the
 * h3 alone left the Team card out, and the agent composed and graded its own. The slot is fixed, so the name compares the param.
 */
function nameInner(target, targetItem, items) {
  const own = text(target);
  const slot = eitherSlots(items).find((sl) => sl.sels.some((x) => target.matches(x.sel)) && sl.matches(targetItem, own));
  if (!slot) return null;
  const sels = slot.sels.map((x) => x.sel).join(', ');
  return {
    slot,
    codeFor: (p) => `.locator(${q(sels)}).getByText(${p}, { exact: true })`,
    pwFor: (ph) => `:is(${sels}):text-is("${ph}")`,
    xpath: null,
    leaf: { role: null, name: own, css: null, aria: false, nameSels: sels, cy: null },
  };
}

/**
 * P3 (run f1380230): a text element with no class of its own that is its wrapper's only child stands for that wrapper — the
 * same text, and a class every item has. BrowserStack's first FAQ answer is a bare <p> (it holds a link) inside
 * div.…__answer, where the others put their text in the div itself; the <p> got no template and the agent invented an id.
 */
function wrapperOf(target) {
  let t = target;
  while (!namingClasses(t).length && t.parentElement && t.parentElement !== document.body && t.parentElement.children.length === 1
    && squash(t.parentElement.innerText) === squash(t.innerText)) t = t.parentElement;
  return namingClasses(t).length ? t : target;
}

/** U18b.2. A template over structural repeats, or null when the target has none. */
function structuralTemplate(target0) {
  const target = isControl(target0) ? target0 : wrapperOf(target0);
  // G1c: a form's labelled field is named by its own label — rows that share a class are fields, not items
  // (a list whose labels are its data, a todo list, is not a form and keeps its template)
  if (isControl(target) && target.closest('form') && [...(target.labels ?? [])].some(isVisible)) return null;
  const found = structuralRepeats(target);
  if (!found) return null;
  const { item: targetItem, items } = found;
  const itemSel = itemSelector(items);
  if (!itemSel) return { count: items.length, reason: 'the items share no class or tag that names them' };
  const named = nameInner(target, targetItem, items);
  // (a slot that reads prices or numbers names nothing — the plain leaf below is the answer then)
  const byName = named && templateFor(target, targetItem, items, itemSel, named, { allowSelf: true, only: named.slot });
  if (byName?.template) return byName;
  const inner = cssInner(target, targetItem, items);
  if (!inner) return { count: items.length, reason: 'the element is not the only one of its kind inside its item' };
  return templateFor(target, targetItem, inner.items, itemSel, inner, { allowSelf: true });
}

// ── U18b.3: mixed naming ────────────────────────────────────────────────────
// Items named by a heading on some and a label on others (BrowserStack's Team
// card is named by its toggle label; Team Ultimate by an h3).

/** Naming candidates from EVERY item — the heading-less item has none of its own. */
function namingSelectors(items) {
  const seen = new Map();
  for (const item of items) {
    const els = [...item.querySelectorAll('*')].filter((el) => !el.matches(INTERACTIVE) && !el.querySelector(INTERACTIVE)
      && isVisible(el) && text(el) && text(el).length <= LABEL_MAX && leafish(el));
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const { sel, xpathSel } = labelSelector(el);
      if (item.querySelector(sel) !== el || seen.has(sel)) continue;
      const first = [...item.querySelectorAll('*')].find((c) => isControl(c) && isVisible(c));
      const beforeControls = !first || Boolean(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
      const rank = (beforeControls ? 0 : 3) + (el.matches(HEADING) ? 0 : /title|name|heading|label/i.test(el.className) || tag === 'label' ? 1 : 2);
      seen.set(sel, { sel, xpathSel, rank, heading: el.matches(HEADING) });
    }
  }
  return [...seen.values()].sort((a, b) => a.rank - b.rank);
}

/** Pairs of selectors that together name every item: the first one present wins. */
function eitherSlots(items) {
  const cands = namingSelectors(items).slice(0, 6);
  const slots = [];
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const [a, b] = [cands[i], cands[j]];
      const read = (item) => text(item.querySelector(a.sel)) || text(item.querySelector(b.sel));
      if (items.every((it) => hasIn(it, a.sel)) || items.every((it) => hasIn(it, b.sel))) continue; // one alone covers them: a plain slot
      slots.push({
        // Just after a single name of the same rank, before any weaker one.
        kind: 'either', sel: `${a.sel} or ${b.sel}`, sels: [a, b], rank: Math.max(a.rank, b.rank) + 0.5,
        param: a.heading || /title/i.test(a.sel) ? 'title' : /name/i.test(a.sel) ? 'name' : 'value',
        valueOf: read,
        matches: (item, v) => [a.sel, b.sel].some((sel) => [...item.querySelectorAll(sel)].some((el) => text(el) === v)),
      });
    }
  }
  return slots;
}
const hasIn = (item, sel) => Boolean(item.querySelector(sel));

/**
 * The check shared by U18 and U18b.2: try each slot, best first, and return
 * the first whose every value picks exactly its own item; else the reason the
 * best option failed.
 */
function templateFor(target, targetItem, items, itemSel0, inner, { allowSelf = false, only = null } = {}) {
  let all = [...document.querySelectorAll(itemSel0.css)];
  // Hidden copies of the items (BrowserStack keeps every product's cards in
  // the page) make the plain item selector ambiguous; the template then names
  // visible items only — what both agents wrote by hand.
  const hiddenCopies = all.some((el) => !isVisible(el)) && items.every(isVisible);
  const hiddenCount = all.filter((el) => !isVisible(el)).length; // P1b: the count behind the hidden-copies fact
  // U19.2: a stable ancestor attribute that holds every item and no hidden
  // copy names WHICH copy (the Live product's cards); `visible: true` only
  // means whichever is showing. It is the fallback.
  const scope = hiddenCopies ? stableScope(items, itemSel0.css) : null;
  let itemSel = itemSel0;
  if (scope) {
    itemSel = { css: `${scope.css} ${itemSel0.css}`, xpath: `${scope.xpath}${itemSel0.xpath}` };
    all = [...document.querySelectorAll(itemSel.css)];
  } else if (hiddenCopies) {
    all = all.filter(isVisible);
    itemSel = { ...itemSel0, visible: true };
  }

  // The reason reported is the BEST option's: it is what a person would try first.
  let blocked = null;
  // Every way of naming the items, best first: a test attribute, a name
  // before the controls (on its own, or a heading-or-label pair), then text
  // after the controls, then other attributes.
  const slots = only ? [only] : [...slotsFor(targetItem, target, { allowSelf }), ...eitherSlots(items)].sort((a, b) => a.rank - b.rank);
  for (const slot of slots) {
    const what = slot.kind === 'attribute' ? slot.attr : `${slot.sel} "${slot.valueOf(targetItem)}"`;
    const values = items.map((i) => slot.valueOf(i));
    const missing = values.filter((v) => !v).length;
    if (missing) { blocked ??= `${missing} of the other items ha${missing === 1 ? 's' : 've'} no ${slot.kind === 'attribute' ? `${what} attribute` : slot.sel}`; continue; }
    if (slot.kind === 'attribute' && values.some((v) => isUnstableValue(v, slot.attr))) { blocked ??= `${what} values look generated`; continue; }
    // Never a value that only counts or prices: 1, 2, 3 … is a row number, not a name.
    if (values.some((v) => NUMERIC.test(v) || PRICE.test(v))) { blocked ??= `${what} holds numbers or prices, not names`; continue; }
    if (new Set(values).size < values.length) {
      const dup = values.find((v, i) => values.indexOf(v) !== i);
      blocked ??= `two items share ${slot.kind === 'attribute' ? `${slot.attr}="${dup}"` : `the label "${dup}"`}`;
      continue;
    }
    // The check: each value picks exactly its own item among everything the
    // item selector names — so a looser match (a substring) fails here.
    if (!items.every((item, i) => { const hit = all.filter((el) => slot.matches(el, values[i])); return hit.length === 1 && hit[0] === item; })) {
      blocked ??= `${what} does not pick each item on its own`;
      continue;
    }
    const out = render(slot, itemSel, inner, values, items.indexOf(targetItem), items);
    out.hidden = hiddenCopies ? { count: hiddenCount, scope: scope?.css ?? null } : null;
    out.variants = variantsOf(items, slot, values, all);
    // U21: one action taking the name shows any variant (the agent wrote
    // selectTeamPro() with the name typed in, from a literal click).
    if (out.variants.length) {
      const sels = slot.kind === 'either' ? slot.sels.map((x) => x.sel) : [slot.sel];
      const labelSel = sels.find((sel) => items.some((it) => it.querySelector(sel)?.closest('label')));
      if (labelSel) { out.variantAct = `${out.every}.locator(${q(labelSel)}).getByText(${slot.param}, { exact: true })`; out.model.toggle = labelSel; }
    }
    return out;
  }
  return { count: items.length, reason: blocked ?? 'no attribute or label inside the item tells the items apart' };
}

/**
 * U21: how the code names an item by `sel` — the heading role where every
 * such element is a heading whose accessible name is its text (an SDET reads
 * getByRole('heading') as intent; a class is layout), else the class.
 */
function namedBy(sel, p, items) {
  const els = items.map((it) => it.querySelector(sel)).filter(Boolean);
  const heading = els.length && els.every((el) => el.matches(HEADING) && !el.closest('[aria-hidden="true"]')
    && roleAndName(el).role === 'heading' && squash(roleAndName(el).name) === text(el));
  return heading ? `page.getByRole('heading', { name: ${p}, exact: true })` : `page.locator(${q(sel)}).getByText(${p}, { exact: true })`;
}

const nameSels = (slot) => (slot.kind === 'either' ? slot.sels.map((x) => x.sel) : [slot.sel]);

function render(slot, itemSel, inner0, values, self, items) {
  const p = slot.param;
  const ph = `__${p}__`;
  // P3: a name leaf compares the parameter, so its code is built for it
  const inner = inner0.codeFor ? { ...inner0, code: inner0.codeFor(p), pw: inner0.pwFor(ph) } : inner0;
  let code; let pw; let xpath; let nameCode = null;
  const vis = itemSel.visible ? '.filter({ visible: true })' : '';
  const css = itemSel.visible ? `${itemSel.css}:visible` : itemSel.css;
  if (slot.kind === 'attribute') {
    code = `page.locator(\`${itemSel.css}[${slot.attr}="\${${p}}"]\`)${vis}${inner.code}`;
    pw = `${css}[${slot.attr}="${ph}"] >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[@${slot.attr}=${ph}]${inner.xpath}`;
  } else if (slot.kind === 'either') {
    const [a, b] = slot.sels;
    code = `page.locator(${q(itemSel.css)})${vis}.filter({ has: ${namedBy(a.sel, p, items)}.or(${namedBy(b.sel, p, items)}) })${inner.code}`;
    // P3 (runs 92a3c7e6, 8cf9312a): the item's name, whichever element holds it — both agents composed it for "each card shows
    // its name" because it came only from inspecting the name itself.
    if (!inner0.codeFor) nameCode = `${code.slice(0, code.length - inner.code.length)}.locator(${q(`${a.sel}, ${b.sel}`)}).getByText(${p}, { exact: true })`;
    pw = `${css}:has(${a.sel}:text-is("${ph}"), ${b.sel}:text-is("${ph}")) >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[.//${a.xpathSel}[normalize-space()=${ph}] or .//${b.xpathSel}[normalize-space()=${ph}]]${inner.xpath}`;
  } else {
    code = `page.locator(${q(itemSel.css)})${vis}.filter({ has: ${namedBy(slot.sel, p, items)} })${inner.code}`;
    pw = `${css}:has(${slot.sel}:text-is("${ph}")) >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[.//${slot.xpathSel}[normalize-space()=${ph}]]${inner.xpath}`;
  }
  return {
    count: values.length,
    param: p,
    value: inner0.codeFor ? inner0.leaf.name : values[self], // P3: a name leaf's value is its own text (the "Team Pro" label, not its card's "Team")
    values,
    code,
    // Every item, to loop over when the test covers them all (plain-prompt run: the FAQ questions were typed in).
    every: `page.locator(${q(itemSel.css)})${vis}`,
    // P3 (run b14ddae4): the element inside one item of that loop — the agent appended it to the every-item locator by hand.
    // a name leaf needs the value, and a control found by class can reach another control: no per-item form for either
    leafCode: inner0.codeFor || inner0.leaf?.control ? null : inner.code,
    nameCode,
    // P1c: the same item selector as a plain CSS string, for the WebdriverIO and Cypress lines.
    everyCss: itemSel.css,
    // P3a: what the WebdriverIO and Cypress renderers read (src/idioms/) — the same item, name slot and leaf that were just checked.
    model: {
      kind: 'item', param: p, item: { css: itemSel.css, visible: Boolean(itemSel.visible) }, leaf: inner.leaf ?? null,
      slot: slot.kind === 'attribute' ? { kind: 'attribute', attr: slot.attr }
        : { kind: slot.kind, sels: nameSels(slot),
          // getText() reports the text as displayed, so a text-transform changes what it returns.
          transformed: items.some((it) => nameSels(slot).some((sel) => { const el = it.querySelector(sel); return el && getComputedStyle(el).textTransform !== 'none'; })) },
    },
    // Registry form (@corlabs/client selectorTemplate): the placeholder sits
    // inside a CSS string in `pw` and IS the literal in `xpath`.
    // XPath cannot say "visible": when hidden copies matter there is no XPath form.
    template: { playwright: { selectorTemplate: pw, syntax: 'css-string' }, xpath: xpath && !itemSel.visible ? { selectorTemplate: xpath, syntax: 'xpath-literal' } : null },
  };
}
