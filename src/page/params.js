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
    const tag = label.tagName.toLowerCase();
    const cls = namingClasses(label)[0];
    const sel = cls ? `${tag}.${cssEscape(cls)}` : tag;
    // Every item is read by its FIRST such element, so the target's label must be its first.
    if (targetItem.querySelector(sel) !== label) continue;
    const xpathSel = cls ? `${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : tag;
    labelSlots.push({
      kind: 'label', sel, xpathSel, rank: rank(label),
      param: /question/i.test(label.className) ? 'question' : label.matches(HEADING) || /title/i.test(label.className) ? 'title' : /name/i.test(label.className) ? 'name' : columnHeader(label) ?? 'value',
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
  if (items.length < 2) return null;
  const itemSel = itemSelector(items);
  if (!itemSel) return { count: items.length, reason: 'the items share no class or tag that names them' };
  const inner = innerOf(target, targetItem);
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

/** U18b.4. Null when the target is not a table cell's content (a control keeps U18's row template). */
function cellTemplate(target) {
  const cell = target.closest('td, th');
  if (!cell || (target !== cell && isControl(target))) return null;
  const table = cell.closest('table');
  const all = [...table.rows];
  const header = all.find((r) => r.querySelector('th') && r.cells.length > 1);
  const row = cell.parentElement;
  if (!header || header === row) return null;
  // Checked before anything that counts cells: with a span, rows and header differ in length.
  if (all.some((r) => [...r.cells].some((c) => c.colSpan > 1))) {
    return { kind: 'cell', count: all.length - 1, reason: 'a header or cell spans more than one column, so positions do not line up' };
  }
  const body = all.filter((r) => r !== header && isVisible(r) && r.cells.length === header.cells.length);
  if (!body.includes(row)) return null;
  const no = (reason) => ({ kind: 'cell', count: body.length, reason });
  const headers = [...header.cells].map((c) => squash(c.textContent));
  const dup = (list) => list.find((v, i) => list.indexOf(v) !== i);
  // The key column: the first whose cells all name their row — text, unique,
  // not a price. A leading checkbox or actions column is skipped (selectorshub).
  const k = headers.findIndex((_, i) => {
    const keys = body.map((r) => squash(r.cells[i].textContent));
    return keys.every((v) => v && !PRICE.test(v)) && !dup(keys);
  });
  if (k === -1) {
    const first = body.map((r) => squash(r.cells[0].textContent));
    return no(dup(first) ? `two rows share the key "${dup(first)}"` : 'no column names every row with unique text');
  }
  const rows = body.map((r) => squash(r.cells[k].textContent));
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
  const xp = `${T}//tr[*[${k + 1}][normalize-space()=__${rp}__]]/*[count((${T}//tr[th])[1]/*[normalize-space()=__${cp}__]/preceding-sibling::*)+1]${inner}`;
  const code = `page.locator(\`xpath=${xp.replace(`__${rp}__`, `"\${${rp}}"`).replace(`__${cp}__`, `"\${${cp}}"`)}\`)`;
  return {
    kind: 'cell', count: body.length, vars: [rp, cp], rows, columns,
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

/** The target inside each item by its tag and class: exactly one per item, and the target in its own. */
function cssInner(target, targetItem, items) {
  const tag = target.tagName.toLowerCase();
  const cls = namingClasses(target)[0];
  const sel = cls ? `${tag}.${cssEscape(cls)}` : tag;
  const one = (it) => it.querySelectorAll(sel).length === 1;
  if (!items.every(one) || targetItem.querySelector(sel) !== target) return null;
  return {
    code: `.locator(${q(sel)})`, pw: sel,
    xpath: `//${tag}${cls ? `[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : ''}`,
    count: (it) => it.querySelectorAll(sel).length,
  };
}

/** U18b.2. A template over structural repeats, or null when the target has none. */
function structuralTemplate(target) {
  const found = structuralRepeats(target);
  if (!found) return null;
  const { item: targetItem, items } = found;
  const itemSel = itemSelector(items);
  if (!itemSel) return { count: items.length, reason: 'the items share no class or tag that names them' };
  const inner = cssInner(target, targetItem, items);
  if (!inner) return { count: items.length, reason: 'the element is not the only one of its kind inside its item' };
  return templateFor(target, targetItem, items, itemSel, inner, { allowSelf: true });
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
      const cls = namingClasses(el)[0];
      const sel = cls ? `${tag}.${cssEscape(cls)}` : tag;
      if (item.querySelector(sel) !== el || seen.has(sel)) continue;
      const first = [...item.querySelectorAll('*')].find((c) => isControl(c) && isVisible(c));
      const beforeControls = !first || Boolean(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
      const rank = (beforeControls ? 0 : 3) + (el.matches(HEADING) ? 0 : /title|name|heading|label/i.test(el.className) || tag === 'label' ? 1 : 2);
      seen.set(sel, { sel, xpathSel: cls ? `${tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${cls} ')]` : tag, rank, heading: el.matches(HEADING) });
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
function templateFor(target, targetItem, items, itemSel0, inner, { allowSelf = false } = {}) {
  let all = [...document.querySelectorAll(itemSel0.css)];
  // Hidden copies of the items (BrowserStack keeps every product's cards in
  // the page) make the plain item selector ambiguous; the template then names
  // visible items only — what both agents wrote by hand.
  const hiddenCopies = all.some((el) => !isVisible(el)) && items.every(isVisible);
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
  const slots = [...slotsFor(targetItem, target, { allowSelf }), ...eitherSlots(items)].sort((a, b) => a.rank - b.rank);
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
    const out = render(slot, itemSel, inner, values, items.indexOf(targetItem));
    out.variants = variantsOf(items, slot, values, all);
    return out;
  }
  return { count: items.length, reason: blocked ?? 'no attribute or label inside the item tells the items apart' };
}

function render(slot, itemSel, inner, values, self) {
  const p = slot.param;
  const ph = `__${p}__`;
  let code; let pw; let xpath;
  const vis = itemSel.visible ? '.filter({ visible: true })' : '';
  const css = itemSel.visible ? `${itemSel.css}:visible` : itemSel.css;
  if (slot.kind === 'attribute') {
    code = `page.locator(\`${itemSel.css}[${slot.attr}="\${${p}}"]\`)${vis}${inner.code}`;
    pw = `${css}[${slot.attr}="${ph}"] >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[@${slot.attr}=${ph}]${inner.xpath}`;
  } else if (slot.kind === 'either') {
    const [a, b] = slot.sels;
    code = `page.locator(${q(itemSel.css)})${vis}.filter({ has: page.locator(${q(a.sel)}).getByText(${p}, { exact: true }).or(page.locator(${q(b.sel)}).getByText(${p}, { exact: true })) })${inner.code}`;
    pw = `${css}:has(${a.sel}:text-is("${ph}"), ${b.sel}:text-is("${ph}")) >> ${inner.pw}`;
    xpath = inner.xpath && `${itemSel.xpath}[.//${a.xpathSel}[normalize-space()=${ph}] or .//${b.xpathSel}[normalize-space()=${ph}]]${inner.xpath}`;
  } else {
    code = `page.locator(${q(itemSel.css)})${vis}.filter({ has: page.locator(${q(slot.sel)}).getByText(${p}, { exact: true }) })${inner.code}`;
    pw = `${css}:has(${slot.sel}:text-is("${ph}")) >> ${inner.pw}`;
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
    // XPath cannot say "visible": when hidden copies matter there is no XPath form.
    template: { playwright: { selectorTemplate: pw, syntax: 'css-string' }, xpath: xpath && !itemSel.visible ? { selectorTemplate: xpath, syntax: 'xpath-literal' } : null },
  };
}
