// Runs inside the page. Built to dist/page.js (IIFE, engine inlined) and
// evaluated on demand — see src/page-runtime.js. Only JSON crosses back to
// Node; no DOM handle leaves the page.
import { LocatorEngine, computeFingerprint, extractElementInfo, scoreLocator } from '@corlabs/engine/core';
import { deepQueryAll, isControl, hintsFor, isShown, roleAndName, squash, visibleLabelOf } from './dom.js';
import { buildOutline } from './outline.js';
import { scopedSnapshot } from './scope.js';
import { beginAct, endAct, identityOf, revalidate, structuralPath } from './acts.js';
import { parameterise, stableScope, xpathLiteral } from './params.js';
import { stateBound } from './state.js';
import { removedMatch, saferScope } from './removed.js';

let refs = new Map(); // ref -> element, replaced on every full snapshot
const meta = new Map(); // ref -> { identity, path } — what the ref was issued for (U16)
let nextRef = 1; // per page load: refs are never renumbered

/**
 * Other visible elements an agent could have meant: same role, same name, so
 * the same snapshot line apart from the hint. The agent picks from those
 * lines, and a wrong pick gets a perfect locator for the wrong element — so
 * inspect says so up front (measured: BrowserStack pricing, two "Choose"
 * buttons for Team Ultimate, the agent inspected the comparison table's).
 * Interactive targets only: those are what the snapshot lists.
 */
function lookalikes(target) {
  if (!isControl(target)) return null;
  const { role, name } = roleAndName(target);
  const same = (el) => {
    const other = roleAndName(el);
    return other.role === role && other.name === name;
  };
  const group = deepQueryAll(isControl).filter((el) => el === target || (isShown(el) && same(el)));
  if (group.length < 2) return null;
  const hints = hintsFor(group.map((el) => ({ el, name })));
  const refOf = new Map([...refs].map(([r, el]) => [el, r]));
  return {
    role,
    name,
    items: group.map((el, i) => ({ ref: refOf.get(el) ?? null, hint: hints[i].trim(), target: el === target })),
  };
}

/** The outline snapshot (src/page/outline.js); refs issued here are what inspect and act tools resolve. */
function snapshot() {
  refs = new Map();
  meta.clear();
  const outline = buildOutline(issueRef);
  return { url: location.href, title: document.title, ...outline, live: [...refs.keys()] };
}

/**
 * One region in full (U15). Keeps the current refs when they are live (`keep`),
 * so the default snapshot's refs still resolve; otherwise starts a fresh set.
 */
function scoped({ ref, text, keep }) {
  if (!keep) {
    refs = new Map();
    meta.clear();
  }
  const result = scopedSnapshot({ ref, text, refs, issueRef });
  return { url: location.href, title: document.title, ...result, live: [...refs.keys()] };
}

/**
 * The element's ref: its current one if it has one, else the next number.
 * Numbers are never reused within a page load, so a ref the agent kept from
 * an earlier snapshot can only ever be unknown — never another element.
 */
function issueRef(el) {
  for (const [ref, known] of refs) if (known === el) return ref;
  const ref = `e${nextRef++}`;
  refs.set(ref, el);
  meta.set(ref, { identity: identityOf(el), path: structuralPath(el) });
  return ref;
}

/**
 * After an act (U16 + U17): re-check every live ref, then report what changed.
 * Controls that appeared get refs, so the agent can use them without a snapshot.
 */
function afterAct() {
  const refsResult = revalidate(refs, meta);
  const diff = endAct(issueRef);
  return { ...diff, refs: refsResult, live: [...refs.keys()] };
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

function inspect({ ref, selector, framework, max }) {
  const target = resolveTarget({ ref, selector });
  if (target.error) return target;
  const candidates = candidatesFor(target.el, framework, max);
  return {
    ...candidates,
    stateOnly: markStateOnly(candidates.locators, target.el),
    viaLabel: (() => { const l = visibleLabelOf(target.el); return l ? squash(l.textContent) : null; })(),
    lookalikes: lookalikes(target.el),
    params: parameterise(target.el),
    stateBound: stateBoundFor(target.el, framework),
    // For silent capture (src/fingerprints.js) — never rendered.
    capture: { fingerprint: computeFingerprint(target.el), elementKey: structuralPath(target.el) },
  };
}

/**
 * Candidates unique only because an act removed their other match (see
 * removed.js): each is warned; for the top pick, the safer scoped form.
 */
function markStateOnly(locators, el) {
  let top = null;
  locators.forEach((l, i) => {
    if (l.matchCount !== 1) return;
    const what = removedMatch(l.value);
    if (!what) return;
    l.warnings = [...(l.warnings ?? []), `Unique only in this state — it also matches ${what}, which an act on this page removed`];
    if (i === 0) top = { what, value: l.value, safer: saferScope(el, l.value) };
  });
  return top;
}

/** The state-bound warning with the twin's best locator (see state.js). */
function stateBoundFor(el, framework) {
  const bound = stateBound(el);
  if (!bound) return null;
  const [best] = candidatesFor(bound.twin, framework, 1).locators;
  return best ? { stateClass: bound.stateClass, twin: { code: best.code || best.value, value: best.value, score: best.score, tierLabel: best.tierLabel, matchCount: best.matchCount } } : null;
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

/** U19.2: for cor_grade — a stable scope that replaces `visible: true` over `css`, or null. */
function stableScopeFor({ css }) {
  let all;
  try {
    all = [...document.querySelectorAll(css)];
  } catch {
    return null;
  }
  const shown = all.filter(isShown);
  if (!shown.length || shown.length === all.length) return null;
  return stableScope(shown, css)?.css ?? null;
}

/** Score chain steps on their own (cor_grade on a chained locator). */
function scoreSteps({ values, framework, element: el, matchCount }) {
  // Same context as grade(), so the weakest step's score is the chain's score.
  const elementInfo = el ? extractElementInfo(el) : null;
  return values.map((value) => {
    const h = scoreLocator({ value, matchCount }, { element: el, elementInfo, framework, matchCount });
    return { score: h.score, tier: h.tier, tierLabel: h.tierLabel, risk: h.primaryRisk?.message ?? null };
  });
}

/** The element a ref or selector names, for act tools; null when it does not resolve. */
const element = (target) => resolveTarget(target).el ?? null;

/** Count an XPath template with each value filled in (U18's check for non-Playwright frameworks). */
function countXpath({ template, values }) {
  return values.map((v) => {
    const xp = template.replaceAll(/__\w+__/g, () => xpathLiteral(v));
    return document.evaluate(`count(${xp})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
  });
}

window.__corMcp = { snapshot, scoped, inspect, element, grade, scoreSteps, stableScopeFor, beginAct, afterAct, countXpath };
