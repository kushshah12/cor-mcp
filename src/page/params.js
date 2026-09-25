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
import { HEADING, INTERACTIVE, deepQueryAll, isControl, isVisible, roleAndName, squash } from './dom.js';

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

/**
 * U18. The target's parameterised template, or why there is none; null when
 * the target is not one of several items.
 */
export function parameterise(target) {
  const repeats = repeatsOf(target);
  if (repeats.length < 2) return null;
  const targetItem = itemOf(target, repeats);
  if (targetItem === target) return null; // the repeat IS the item: nothing contains it
  const items = repeats.map((r) => itemOf(r, repeats)).filter((i) => i.tagName === targetItem.tagName);
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
