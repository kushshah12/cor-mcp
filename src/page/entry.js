// Runs inside the page. Built to dist/page.js (IIFE, engine inlined) and
// evaluated on demand — see src/page-runtime.js. Only JSON crosses back to
// Node; no DOM handle leaves the page.
import {
  LocatorEngine,
  DEFAULT_TEST_ID_ATTRIBUTES,
  computeFingerprint,
  extractElementInfo,
  scoreLocator,
  getAccessibleName,
  getImplicitRole,
} from '@corlabs/engine/core';

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[contenteditable=""]', '[contenteditable="true"]', '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  ...['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']
    .map((role) => `[role="${role}"]`),
].join(',');

const NAME_MAX = 80;
const HINT_MAX = 40;

let refs = new Map(); // ref -> element, replaced on every snapshot

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const squash = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const REGIONS = [
  ['table', 'table,[role="table"],[role="grid"],[role="treegrid"]'],
  ['dialog', 'dialog,[role="dialog"],[role="alertdialog"]'],
  ['navigation', 'nav,[role="navigation"]'],
  ['header', 'header,[role="banner"]'],
  ['footer', 'footer,[role="contentinfo"]'],
  ['sidebar', 'aside,[role="complementary"]'],
];

function hintText(node) {
  const text = squash(node?.textContent);
  return text && text.length <= HINT_MAX ? text : null;
}

/**
 * The nearest heading before the element, inside one of its first eight
 * ancestors — what a person names a card or column by ("Team Ultimate").
 */
function nearestHeading(el) {
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
function nearbyText(el, ownName) {
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

const regionOf = (el) => REGIONS.find(([, selector]) => el.closest(selector))?.[0] ?? null;

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
function hintsFor(group) {
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

/** Flat, interactive-only, visible-only listing with refs. */
function snapshot() {
  refs = new Map();
  const testIdSelector = DEFAULT_TEST_ID_ATTRIBUTES.map((a) => `[${a}]`).join(',');
  const items = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!isVisible(el)) continue;
    const ref = `e${items.length + 1}`;
    refs.set(ref, el);
    const role = el.getAttribute('role') || getImplicitRole(el) || el.tagName.toLowerCase();
    const name = clip(squash(getAccessibleName(el)), NAME_MAX);
    items.push({ el, ref, role, name, testId: el.matches(testIdSelector) });
  }

  // A context hint only where role+name repeats: that is the case it exists
  // for, and adding it everywhere costs tokens on every line of every page.
  // ponytail: a unique name gets no hint; add one if agents mis-pick by page area.
  const groups = new Map();
  for (const item of items) {
    const key = `${item.role}|${item.name}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const hint = new Map();
  for (const group of groups.values()) {
    if (group.length > 1) hintsFor(group).forEach((h, i) => hint.set(group[i], h));
  }
  const lines = items.map((item) => {
    const { ref, role, name, testId } = item;
    let line = `- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]`;
    if (testId) line += ' ✓id';
    return line + (hint.get(item) ?? '');
  });
  return { url: location.href, title: document.title, count: items.length, lines };
}

/** Resolve a ref or a selector to exactly one element. */
function resolveTarget({ ref, selector }) {
  if (ref) {
    const el = refs.get(ref);
    if (!el) return { error: 'unknown-ref' };
    if (!el.isConnected) return { error: 'detached' };
    return { el };
  }
  let matches;
  try {
    matches = document.querySelectorAll(selector);
  } catch {
    return { error: 'invalid-selector' };
  }
  if (matches.length !== 1) return { error: 'match-count', count: matches.length };
  return { el: matches[0] };
}

/**
 * The element's place in the tree, tags and positions only — a record key for
 * fingerprints that no id or class can change between inspects.
 */
function structuralPath(el) {
  const steps = [];
  for (let n = el; n && n.parentElement; n = n.parentElement) {
    const same = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
    steps.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})`);
  }
  return steps.join(' > ');
}

function inspect({ ref, selector, framework, max }) {
  const target = resolveTarget({ ref, selector });
  if (target.error) return target;
  return {
    ...candidatesFor(target.el, framework, max),
    // For silent capture (src/fingerprints.js) — never rendered.
    capture: { fingerprint: computeFingerprint(target.el), elementKey: structuralPath(target.el) },
  };
}

function candidatesFor(el, framework, max) {
  const engine = new LocatorEngine({ framework });
  const result = engine.generateLocatorsForAI(el, { maxLocators: max });
  // Drop fields the renderer does not use; everything left is plain JSON.
  return {
    element: result.element_summary,
    framework: result.framework,
    profile: result.framework_profile,
    rankingNote: result.ranking_note,
    recommendations: result.recommendations,
    locators: result.locators.map((l) => ({
      value: l.value,
      code: l.code,
      strategy: l.strategy,
      type: l.type,
      score: l.score,
      tier: l.tier,
      tierLabel: l.tierLabel,
      matchCount: l.matchCount,
      resolution: l.resolution,
      primaryRisk: l.primaryRisk,
      signals: l.signals.map(({ id, direction, message, points }) => ({ id, direction, message, points })),
      warnings: l.warnings,
      recommendations: l.recommendations,
    })),
  };
}

/**
 * Score a selector someone else wrote. Node has already counted it with
 * Playwright and hands over the element when exactly one matched; the
 * candidates generated for that element are what "better" is measured against.
 */
function grade({ element: el, value, framework, matchCount }) {
  const health = scoreLocator(
    { value, matchCount },
    { element: el, elementInfo: el ? extractElementInfo(el) : null, framework, matchCount },
  );
  const negative = health.signals.filter((s) => s.direction === 'negative');
  return {
    graded: {
      value,
      code: value,
      score: health.score,
      tier: health.tier,
      tierLabel: health.tierLabel,
      matchCount,
      resolution: health.resolution,
      primaryRisk: health.primaryRisk,
      signals: health.signals.map(({ id, direction, message, points }) => ({ id, direction, message, points })),
      warnings: negative.map((s) => (s.evidence?.length ? `${s.message} (${s.evidence.join(', ')})` : s.message)),
      recommendations: health.recommendations,
    },
    candidates: el ? candidatesFor(el, framework, 6) : null,
  };
}

/** The element a ref or selector names, for act tools; null when it does not resolve. */
const element = (target) => resolveTarget(target).el ?? null;

window.__corMcp = { snapshot, inspect, element, grade };
