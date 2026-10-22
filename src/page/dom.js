// Page-side helpers shared by the outline snapshot, the lookalike guard and
// inspect. Runs inside the page (bundled into dist/page.js).
import { getAccessibleName, getImplicitRole } from '@corlabs/engine/core';

export const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[contenteditable=""]', '[contenteditable="true"]', '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  ...['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']
    .map((role) => `[role="${role}"]`),
].join(',');

export const NAME_MAX = 80;

/**
 * A click target with no semantics: a React-handled <div> or <span> whose only
 * sign of being clickable is `cursor: pointer`. bstackdemo's "Add to cart" is
 * one; Playwright MCP lists it (`generic [cursor=pointer]`) and COR's
 * snapshot did not, so an agent picking from COR never saw it.
 *
 * Counted only where the pointer starts (a parent with it passes it down to
 * every child), outside and around no real control (a card holding buttons
 * is a container), with a short name — a whole clickable panel is not one.
 */
function isClickable(el) {
  if (el.matches(INTERACTIVE) || el.tagName === 'LABEL' || el === document.body) return false;
  if (getComputedStyle(el).cursor !== 'pointer') return false;
  const parent = composedParent(el);
  if (parent && parent.nodeType === 1 && getComputedStyle(parent).cursor === 'pointer') return false;
  if (el.parentElement?.closest(INTERACTIVE) || el.querySelector(INTERACTIVE)) return false;
  const text = squash(el.textContent);
  return (text.length > 0 && text.length <= NAME_MAX) || Boolean(el.getAttribute('aria-label') || el.getAttribute('title'));
}

// ponytail: one pass over the page per page call. Every callPage is one
// synchronous evaluate, so the microtask clears it before the page changes.
let clickCache = null;
export function clickables() {
  if (!clickCache) {
    clickCache = new Set(deepQueryAll(isClickable));
    queueMicrotask(() => { clickCache = null; });
  }
  return clickCache;
}

/** A control: an interactive element, or a clickable one (above). */
export const isControl = (el) => el.matches(INTERACTIVE) || clickables().has(el);
/** Does `node` hold a control? */
export const hasControl = (node) => Boolean(node.querySelector(INTERACTIVE)) || [...clickables()].some((c) => node.contains(c));
/** The control `el` is, or sits inside. */
export function closestControl(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (isControl(n)) return n;
  return null;
}
export const HINT_MAX = 40;

/**
 * querySelectorAll that also searches open shadow roots — in page order, with
 * a shadow root's contents where its host sits, not appended at the end.
 */
export function deepQueryAll(selector, root = document) {
  const test = typeof selector === 'function' ? selector : (el) => el.matches(selector);
  const out = [];
  const visit = (node) => {
    for (const el of node.children) {
      if (test(el)) out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
      visit(el);
    }
  };
  visit(root);
  return out;
}

/** Parent across a shadow boundary: an element inside a shadow root belongs to its host. */
export const composedParent = (el) => el.parentElement ?? el.getRootNode()?.host ?? null;

export function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

/**
 * A hidden checkbox or radio that a user operates through its visible label —
 * a custom toggle. BrowserStack pricing's "For Teams / For Individuals" switch
 * is two such radios; the snapshot dropped them as invisible, and the agent
 * wrote six DOM probes to find them.
 */
export function visibleLabelOf(el) {
  if (el.tagName !== 'INPUT' || !/^(radio|checkbox)$/i.test(el.type) || isVisible(el)) return null;
  return [...(el.labels ?? [])].find(isVisible) ?? null;
}

/** On screen for a user: visible itself, or through its visible label. */
export const isShown = (el) => isVisible(el) || Boolean(visibleLabelOf(el));

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const squash = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

export const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
export const REGIONS = [
  ['table', 'table,[role="table"],[role="grid"],[role="treegrid"]'],
  ['dialog', 'dialog,[role="dialog"],[role="alertdialog"]'],
  ['navigation', 'nav,[role="navigation"]'],
  ['header', 'header,[role="banner"]'],
  ['footer', 'footer,[role="contentinfo"]'],
  ['sidebar', 'aside,[role="complementary"]'],
];

export function hintText(node) {
  const text = squash(node?.textContent);
  return text && text.length <= HINT_MAX ? text : null;
}

/**
 * The nearest heading before the element, inside one of its first eight
 * ancestors — what a person names a card or column by ("Team Ultimate").
 */
export function nearestHeading(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const before = [...node.querySelectorAll(HEADING)].filter(
      (h) => !h.contains(el) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && isVisible(h),
    );
    const text = hintText(before.at(-1));
    if (text) return text;
  }
  return null;
}

/**
 * Nearest short text in an ancestor that is not the element's own — the
 * fallback where there is no heading ("Red Hat" beside a cart row's Remove).
 * Bounded: four ancestors below <body>, one line, HINT_MAX chars; otherwise
 * omitted rather
 * than returning a whole list's concatenated text.
 */
export function nearbyText(el, ownName) {
  let node = el.parentElement;
  // Text found only at page level is not near anything — stop below <body>.
  for (let depth = 0; node && node !== document.body && depth < 4; depth++, node = node.parentElement) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (el.contains(t)) continue;
      const raw = t.nodeValue.trim();
      if (!raw || raw.includes('\n')) continue;
      const text = squash(raw);
      if (text.length > HINT_MAX || text === ownName) continue;
      if (!isVisible(t.parentElement)) continue;
      return text;
    }
  }
  return null;
}

export const regionOf = (el) => REGIONS.find(([, selector]) => el.closest(selector))?.[0] ?? null;

/**
 * Hints for elements sharing a role and name, built only as far as needed to
 * tell them apart, most meaningful signal first:
 *   1. the heading each sits under, when headings alone differ
 *   2. heading (else nearby text) plus region, when the regions differ
 *   3. nearby text, with the shared heading kept as "under …"
 *   4. position in page order
 * Measured on the BrowserStack pricing page: two visible "Choose" buttons for
 * Team Ultimate — the plan card and a comparison-table column — both sit under
 * an <h3> "Team Ultimate"; only the table tells them apart (step 2). The old
 * first-short-text hint named neither by its plan ("TESTING TOOLKIT PACK" /
 * "5 users | $75 per user") and the agent picked the table's. Rows under one
 * heading ("Users") still need their own text ("Alice") — step 3, not step 1.
 */
export function hintsFor(group) {
  const parts = group.map(({ el, name }) => {
    const h = nearestHeading(el);
    return { heading: h && h !== name ? h : null, text: nearbyText(el, name), region: regionOf(el) };
  });
  const distinct = (render) => new Set(group.map((_, i) => render(i))).size === group.length;
  const q = (s) => ` in "${s}"`;

  const byHeading = (i) => (parts[i].heading ? q(parts[i].heading) : '');
  if (parts.every((p) => p.heading) && distinct(byHeading)) return group.map((_, i) => byHeading(i));

  const label = (i) => parts[i].heading ?? parts[i].text;
  const byRegion = (i) => (label(i) ? q(label(i)) : '') + (parts[i].region ? ` (${parts[i].region})` : '');
  if (new Set(parts.map((p) => p.region)).size > 1 && distinct(byRegion)) return group.map((_, i) => byRegion(i));

  const byText = (i) => {
    const { heading, text } = parts[i];
    if (!text) return byHeading(i);
    return q(text) + (heading && heading !== text ? ` under "${heading}"` : '');
  };
  if (distinct(byText)) return group.map((_, i) => byText(i));

  // Nothing on the page tells them apart: say which one it is, in page order.
  // Text that failed to distinguish is dropped — the same add-on name printed
  // on every card reads as if it named one of them.
  const seen = new Map();
  return group.map((_, i) => {
    const key = byHeading(i);
    const total = group.filter((__, j) => byHeading(j) === key).length;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return total > 1 ? `${key} (${n} of ${total})` : key;
  });
}

/** What a snapshot line shows for an element — and so what makes two look alike. */
export function roleAndName(el) {
  if (!el.hasAttribute('role') && clickables().has(el)) {
    // No role, so no accessible name from content: name it by what it shows.
    const name = el.getAttribute('aria-label') || squash(el.textContent) || el.getAttribute('title');
    return { role: 'clickable', name: clip(squash(name), NAME_MAX) };
  }
  return {
    role: el.getAttribute('role') || getImplicitRole(el) || el.tagName.toLowerCase(),
    name: clip(squash(getAccessibleName(el)), NAME_MAX),
  };
}
