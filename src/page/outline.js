// The outline snapshot (U13 + U14). Runs inside the page.
//
// Playwright MCP hands its agent the whole accessibility tree — 52,206
// characters on the BrowserStack pricing page, prose and anonymous wrappers
// included, test ids and hidden copies invisible. The old COR snapshot was a
// flat list whose only context was a hint, and on that page the hint named
// neither Team Ultimate "Choose" by its plan. This keeps what identifies an
// element and nothing else:
//
//   pass 1  leaves: visible interactive elements (open shadow roots included),
//           each with the signals only COR has — test attribute, hidden
//           lookalikes, state, a numbered id to check against U7's verdicts
//   pass 2  per leaf, the ancestors that identify it — landmarks, tables
//           (column by header, row by key cell), list items by their own
//           text, and the section headings that title it
//   pass 3  merge the paths into one tree; the renderer folds chains
import { DEFAULT_TEST_ID_ATTRIBUTES } from '@corlabs/engine/core';
import {
  HEADING, HINT_MAX, INTERACTIVE, clip, composedParent, deepQueryAll, isVisible, roleAndName, squash,
} from './dom.js';

const LABEL_MAX = 50;
export const label = (text) => {
  const s = squash(text);
  return s ? clip(s, LABEL_MAX) : null;
};

export const LANDMARKS = [
  ['dialog', 'dialog,[role="dialog"],[role="alertdialog"]'],
  ['navigation', 'nav,[role="navigation"]'],
  ['header', 'header,[role="banner"]'],
  ['footer', 'footer,[role="contentinfo"]'],
  ['sidebar', 'aside,[role="complementary"]'],
  ['form', 'form[aria-label],form[aria-labelledby]'],
  ['group', 'fieldset'],
  ['region', 'section[aria-label],section[aria-labelledby],[role="region"][aria-label],[role="region"][aria-labelledby]'],
];
export const TABLE = 'table,[role="table"],[role="grid"],[role="treegrid"]';
export const CELL = 'td,th,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
export const ITEM = 'li,[role="listitem"]';

export function ariaLabel(el) {
  const own = el.getAttribute('aria-label');
  if (own) return label(own);
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return null;
  return label(ids.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' '));
}

/** First short visible line of text in `el` that belongs to `el` — not to a control inside it, nor to a nested `own`. */
export function ownText(el, own = null) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const parent = t.parentElement;
    const control = parent?.closest(INTERACTIVE);
    if (!parent || (control && el.contains(control))) continue;
    if (own && parent.closest(own) !== el) continue;
    const raw = t.nodeValue.trim();
    if (!raw || raw.includes('\n') || raw.length > HINT_MAX || !isVisible(parent)) continue;
    return squash(raw);
  }
  return null;
}

// ── tables: a column by its header, a row by its key cell ───────────────────
const isHeaderCell = (cell) =>
  cell.matches('th,[role="columnheader"]') && cell.getAttribute('scope') !== 'row';

function cellName(cell) {
  const heading = cell.querySelector(HEADING);
  return (heading && label(heading.textContent)) || ariaLabel(cell) || label(ownText(cell));
}

export function rowKey(row) {
  for (const cell of row.children) {
    const text = ownText(cell) ?? label(cell.querySelector(HEADING)?.textContent);
    if (text) return text;
  }
  return null;
}

// ── headings: which ones title this element ─────────────────────────────────
export const headingLevel = (h) => Number(/^H([1-6])$/.exec(h.tagName)?.[1] ?? h.getAttribute('aria-level') ?? 2);

/**
 * `h` titles `leaf` if, where their ancestries meet, h's branch holds no
 * control of its own: a card's header block does; the previous card, which
 * has its own button, does not — so a heading-less card never borrows its
 * neighbour's title.
 */
function titles(h, leaf) {
  let meet = h.parentElement;
  while (meet && !meet.contains(leaf)) meet = meet.parentElement;
  if (!meet) return false;
  // A heading inside a table cell titles that cell only ("Feature List" in the
  // first header cell is not the title of the next column).
  const cell = h.closest(CELL);
  if (cell && !cell.contains(leaf)) return false;
  let branch = h;
  while (branch.parentElement !== meet) branch = branch.parentElement;
  return branch === h || !branch.querySelector(INTERACTIVE);
}

/** Up to two headings of decreasing level that title the leaf, outermost first. The page's <h1> names nothing in particular. */
function sectionHeadings(leaf, headings) {
  const chain = [];
  let limit = 7;
  for (let i = headings.length - 1; i >= 0 && chain.length < 2; i--) {
    const h = headings[i];
    if (h.contains(leaf) || !(h.compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const level = headingLevel(h);
    if (level >= limit) continue;
    if (level === 1) break;
    if (!titles(h, leaf)) continue;
    chain.unshift(h);
    limit = level;
  }
  return chain;
}

/** The containers that identify `leaf`, outermost first. */
export function containersFor(leaf, headings) {
  const ancestors = [];
  for (let n = composedParent(leaf); n && n !== document.body && n !== document.documentElement; n = composedParent(n)) {
    ancestors.unshift(n);
  }
  const kept = [];
  for (const n of ancestors) {
    const landmark = LANDMARKS.find(([, selector]) => n.matches(selector));
    if (landmark) {
      const [type] = landmark;
      const name = type === 'group'
        ? label(n.querySelector('legend')?.textContent)
        : ariaLabel(n) ?? (type === 'dialog' ? label(n.querySelector(HEADING)?.textContent) : null);
      kept.push({ node: n, type, label: name });
    } else if (n.matches(TABLE)) {
      kept.push({ node: n, type: 'table', label: label(n.querySelector('caption')?.textContent) ?? ariaLabel(n) });
    } else if (n.matches(CELL) && n.closest(TABLE)) {
      if (isHeaderCell(n)) {
        kept.push({ node: n, type: 'column', label: cellName(n) });
      } else {
        const row = n.closest('tr,[role="row"]');
        if (row) kept.push({ node: row, type: 'row', label: rowKey(row) });
      }
    } else if (n.matches(ITEM)) {
      const text = ownText(n, ITEM);
      if (text) kept.push({ node: n, type: 'item', label: text });
    }
  }

  // A heading goes just inside the deepest kept container that holds it, and
  // is dropped when that container already carries its text (a column header).
  let floor = 0;
  for (const h of sectionHeadings(leaf, headings)) {
    const text = label(h.textContent);
    if (!text || kept.some((k) => k.label === text)) continue;
    let at = 0;
    kept.forEach((k, i) => {
      if (k.type !== 'section' && k.node.contains(h)) at = i + 1;
    });
    at = Math.max(at, floor);
    kept.splice(at, 0, { node: h, type: 'section', label: text });
    floor = at + 1;
  }
  return kept;
}

// ── signals only COR has (U14) ──────────────────────────────────────────────
export function statesOf(el) {
  const states = [];
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  const checked = el.getAttribute('aria-checked')
    ?? (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : null);
  if (checked === 'true') states.push('checked');
  if (checked === 'mixed') states.push('mixed');
  if (el.getAttribute('aria-expanded') === 'true' || (el.tagName === 'SUMMARY' && el.parentElement?.open)) states.push('expanded');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  return states;
}

/** First short line of text in the element's first four ancestors (below <body>) that no control owns. */
function textNear(el) {
  let node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 4; depth++, node = node.parentElement) {
    const text = ownText(node);
    if (text) return text;
  }
  return null;
}

/**
 * Siblings in one container that still read the same get their own nearby
 * text when it tells them apart ("Red Hat"), else their position.
 */
function disambiguateSiblings(children) {
  const groups = new Map();
  for (const child of children) {
    if (child.kind !== 'leaf') continue;
    const key = `${child.role}|${child.name}`;
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Text from the element's own surroundings — never another control's label
    // ("Select Live" read "in \"Automate\"" from the neighbouring tab).
    const texts = group.map((leaf) => textNear(leaf.el));
    const distinct = texts.every(Boolean) && new Set(texts).size === group.length;
    group.forEach((leaf, i) => {
      leaf.hint = distinct ? `in "${texts[i]}"` : `(${i + 1} of ${group.length})`;
    });
  }
  for (const child of children) if (child.kind === 'container') disambiguateSiblings(child.children);
}

/**
 * @param {(el: Element) => string} issueRef  assigns and records a ref
 * @returns {{ count: number, tree: object[] }}
 */
export function buildOutline(issueRef) {
  const testIdSelector = DEFAULT_TEST_ID_ATTRIBUTES.map((a) => `[${a}]`).join(',');
  const all = deepQueryAll(INTERACTIVE);
  const visible = all.filter(isVisible);

  // Hidden lookalikes: invisible controls sharing a role and name with a
  // visible one. A locator that leans on visibility changes meaning when they
  // show — the trap that sent Playwright's agent to `:visible`.
  const hidden = new Map();
  for (const el of all) {
    if (isVisible(el)) continue;
    const { role, name } = roleAndName(el);
    hidden.set(`${role}|${name}`, (hidden.get(`${role}|${name}`) ?? 0) + 1);
  }

  const headingsByRoot = new Map();
  const headingsFor = (root) => {
    if (!headingsByRoot.has(root)) headingsByRoot.set(root, [...root.querySelectorAll(HEADING)].filter(isVisible));
    return headingsByRoot.get(root);
  };

  const root = { children: [], byNode: new Map() };
  for (const el of visible) {
    const { role, name } = roleAndName(el);
    const leaf = {
      kind: 'leaf',
      el,
      ref: issueRef(el),
      role,
      name,
      testId: el.matches(testIdSelector),
      states: statesOf(el),
      hidden: hidden.get(`${role}|${name}`) ?? 0,
      // Checked against U7's cached reload verdicts in Node; a snapshot never triggers a reload.
      id: /\d$/.test(el.id) ? el.id : null,
      // A <select>'s chosen option is what a person reads it by. Typed input
      // values are not shown: they are the user's data, not the page's.
      value: el.tagName === 'SELECT' ? label(el.selectedOptions[0]?.textContent) : null,
    };
    let parent = root;
    for (const c of containersFor(el, headingsFor(el.getRootNode()))) {
      let child = parent.byNode.get(c.node);
      if (!child) {
        child = { kind: 'container', type: c.type, label: c.label, children: [], byNode: new Map() };
        parent.byNode.set(c.node, child);
        parent.children.push(child);
      }
      parent = child;
    }
    parent.children.push(leaf);
  }
  disambiguateSiblings(root.children);

  // Only JSON crosses back to Node.
  const plain = (node) => (node.kind === 'leaf'
    ? { kind: 'leaf', ref: node.ref, role: node.role, name: node.name, value: node.value, testId: node.testId, states: node.states, hidden: node.hidden, id: node.id, hint: node.hint ?? null }
    : { kind: 'container', type: node.type, label: node.label, children: node.children.map(plain) });
  return { count: visible.length, tree: root.children.map(plain) };
}
