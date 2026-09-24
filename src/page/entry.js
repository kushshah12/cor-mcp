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

/**
 * Nearest short text in an ancestor that is not the element's own — what a
 * person would say to tell two "Remove" buttons apart ("in Red Hat").
 * Bounded: four ancestors, one line, HINT_MAX chars; otherwise omitted rather
 * than returning a whole list's concatenated text.
 */
function contextHint(el, ownName) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
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
  const seen = new Map();
  for (const item of items) {
    const key = `${item.role}|${item.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const lines = items.map(({ el, ref, role, name, testId }) => {
    let line = `- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]`;
    if (testId) line += ' ✓id';
    if (seen.get(`${role}|${name}`) > 1) {
      const hint = contextHint(el, name);
      if (hint) line += ` in "${hint}"`;
    }
    return line;
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
