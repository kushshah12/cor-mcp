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

/** A selector naming every item and nothing between them: tag + a class all share. */
function itemSelector(items) {
  const [first] = items;
  const tag = first.tagName.toLowerCase();
  if (!items.every((i) => i.tagName === first.tagName)) return null;
  const shared = namingClasses(first).find((c) => items.every((i) => i.classList.contains(c)));
  if (shared) return { css: `${tag}.${cssEscape(shared)}`, xpath: `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${shared} ')]` };
  // Rows and list items do not nest in practice; anything else needs a class.
  if (['tr', 'li', 'article'].includes(tag)) return { css: tag, xpath: `//${tag}` };
  return null;
}

/** How to find the target inside its item: role + name, or its text. */
function innerOf(target, item) {
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
  return inner.count(item) === 1 ? inner : null;
}

/**
 * The ways an item's value can be read, best first: a test attribute on the
 * item, a visible label inside it, then another stable attribute on it.
 * Each returns the value for any item, or null when that item has none.
 */
function slotsFor(targetItem, target) {
  const attrs = [...targetItem.attributes].map((a) => a.name).filter((n) => !NOT_A_SLOT.test(n));
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
  const rank = (el) => (el.matches(HEADING) ? 0 : /title|name|heading|label/i.test(el.className) ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));
  const labelSlots = [];
  for (const label of candidates) {
    const tag = label.tagName.toLowerCase();
    const cls = namingClasses(label)[0];
    const sel = cls ? `${tag}.${cssEscape(cls)}` : tag;
    // Every item is read by its FIRST such element, so the target's label must be its first.
    if (targetItem.querySelector(sel) !== label) continue;
    const xpathSel = cls ? `${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : tag;
    labelSlots.push({
      kind: 'label', sel, xpathSel,
      param: label.matches(HEADING) || /title/i.test(label.className) ? 'title' : /name/i.test(label.className) ? 'name' : columnHeader(label) ?? 'value',
      valueOf: (item) => text(item.querySelector(sel)),
      matches: (item, v) => [...item.querySelectorAll(sel)].some((el) => text(el) === v),
    });
  }
  // The plan's order: a test attribute, then what a person reads, then any other stable attribute.
  return [
    ...attrs.filter((a) => TEST_ATTRS.includes(a)).map(attrSlot),
    ...labelSlots,
    ...attrs.filter((a) => !TEST_ATTRS.includes(a)).map(attrSlot),
  ];
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
  if (hidden) out.act = `page.getByText(${param}${opt})`;
  return out;
}

/**
 * U18. The target's parameterised template, or why there is none; null when
 * the target is not one of several items.
 */
export function parameterise(target) {
  const group = groupTemplate(target);
  if (group) return group;
  const repeats = repeatsOf(target);
  if (repeats.length < 2) return null;
  const targetItem = itemOf(target, repeats);
  if (targetItem === target) return null; // the repeat IS the item: nothing contains it
  const items = repeats.map((r) => itemOf(r, repeats)).filter((i) => i.tagName === targetItem.tagName);
  // Lookalikes of other shapes (a card's "Choose" and the comparison table's)
  // can leave the target the only item of its shape: nothing to parameterise.
  // BrowserStack pricing rendered "1 items share this shape (1/1)" without this.
  if (items.length < 2) return null;
  const itemSel = itemSelector(items);
  if (!itemSel) return { count: items.length, reason: 'the items share no class or tag that names them' };
  const inner = innerOf(target, targetItem);
  if (!inner) return { count: items.length, reason: 'the element is not the only one of its kind inside its item' };
  const all = [...document.querySelectorAll(itemSel.css)];

  // The reason reported is the BEST option's: it is what a person would try first.
  let blocked = null;
  for (const slot of slotsFor(targetItem, target)) {
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
    return render(slot, itemSel, inner, values, items.indexOf(targetItem));
  }
  return { count: items.length, reason: blocked ?? 'no attribute or label inside the item tells the items apart' };
}

function render(slot, itemSel, inner, values, self) {
  const p = slot.param;
  const ph = `__${p}__`;
  let code; let pw; let xpath;
  if (slot.kind === 'attribute') {
    code = `page.locator(\`${itemSel.css}[${slot.attr}="\${${p}}"]\`)${inner.code}`;
    pw = `${itemSel.css}[${slot.attr}="${ph}"] >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[@${slot.attr}=${ph}]${inner.xpath}`;
  } else {
    code = `page.locator(${q(itemSel.css)}).filter({ has: page.locator(${q(slot.sel)}).getByText(${p}, { exact: true }) })${inner.code}`;
    pw = `${itemSel.css}:has(${slot.sel}:text-is("${ph}")) >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[.//${slot.xpathSel}[normalize-space()=${ph}]]${inner.xpath}`;
  }
  return {
    count: values.length,
    param: p,
    value: values[self],
    values,
    code,
    // Registry form (@corlabs/client selectorTemplate): the placeholder sits
    // inside a CSS string in `pw` and IS the literal in `xpath`.
    template: { playwright: { selectorTemplate: pw, syntax: 'css-string' }, xpath: xpath ? { selectorTemplate: xpath, syntax: 'xpath-literal' } : null },
  };
}
