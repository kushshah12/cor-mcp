// Runs inside the page. Built to dist/page.js (IIFE, engine inlined) and
// evaluated on demand — see src/page-runtime.js. Only JSON crosses back to
// Node; no DOM handle leaves the page.
import { LocatorEngine, computeFingerprint, extractElementInfo, findByFingerprint, scoreLocator, scoreSimilarity } from '@corlabs/engine/core';
import { deepQueryAll, isControl, hintsFor, isShown, isVisible, roleAndName, squash, visibleLabelOf } from './dom.js';
import { buildOutline } from './outline.js';
import { scopedSnapshot } from './scope.js';
import { beginAct, collapsedAway, endAct, identityOf, revalidate, structuralPath } from './acts.js';
import { itemTexts, parameterise, stableScope, xpathLiteral } from './params.js';
import { stateBound } from './state.js';
import { removedMatch, saferScope } from './removed.js';

let refs = new Map(); // ref -> element, replaced on every full snapshot
const meta = new Map(); // ref -> { identity, path } — what the ref was issued for (U16)
let nextRef = 1; // per page load: refs are never renumbered
let reusable = new Map(); // element -> ref, during a snapshot: the refs it may keep

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
function snapshot({ start = 1 } = {}) {
  // P2a: numbering continues past every ref the session issued, so a ref from another page is never reused here;
  // an element still on the page keeps its ref, so cor_open's outline and a later cor_snapshot agree.
  nextRef = Math.max(nextRef, start);
  reusable = new Map([...refs].map(([r, el]) => [el, r]));
  refs = new Map();
  const outline = buildOutline(issueRef);
  reusable = new Map();
  for (const r of [...meta.keys()]) if (!refs.has(r)) meta.delete(r);
  return { url: location.href, title: document.title, ...outline, frames: framesOf(), live: [...refs.keys()] };
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
  const kept = reusable.get(el);
  if (kept) { refs.set(kept, el); return kept; }
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
function resolveTarget({ ref, selector, element }) {
  if (element) return { el: element }; // resolved by Playwright (a selector that is not CSS)
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

// U3: the project's Playwright testIdAttribute (playwright.config), set by each call that builds candidates.
let pwTestId = null;
// U7: the project's ranking order — 'testid-first' from cor.config.js, else the framework's published order.
let rankOrder = null;

function inspect({ ref, selector, element, framework, max, testIdAttribute = null, order = null }) {
  pwTestId = testIdAttribute;
  rankOrder = order;
  const target = resolveTarget({ ref, selector, element });
  if (target.error) return target;
  const candidates = candidatesFor(target.el, framework, max);
  return {
    ...candidates,
    stateOnly: markStateOnly(candidates.locators, target.el),
    viaLabel: (() => { const l = visibleLabelOf(target.el); return l ? squash(l.textContent) : null; })(),
    lookalikes: lookalikes(target.el),
    collapsed: collapsedAway(target.el, new Map()),
    testAttrs: hasTestAttributes(),
    shadow: shadowOf(target.el),
    shadowFix: framework === 'cypress' ? cypressShadowFix(target.el, candidates.locators) : null,
    params: parameterise(target.el),
    stateBound: stateBoundFor(target.el, framework),
    // For the entry's record (src/records.js) — never rendered.
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
  const engine = new LocatorEngine({ framework, ...(pwTestId ? { playwrightTestIdAttribute: pwTestId } : {}), ...(rankOrder ? { order: rankOrder } : {}) });
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
function grade({ element: el, value, framework, matchCount, testIdAttribute = null, order = null }) {
  pwTestId = testIdAttribute;
  rankOrder = order;
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

/** U19.3: the visible items of `css` and each one's candidate values. */
function itemCandidates({ css }) {
  let all;
  try {
    all = [...document.querySelectorAll(css)];
  } catch {
    return null;
  }
  return all.filter(isShown).map((item) => itemTexts(item));
}

/** U19.3: which visible item of `css` holds `element` (-1 when none). */
function itemIndexOf({ css, element: el }) {
  const items = [...document.querySelectorAll(css)].filter(isShown);
  return items.findIndex((it) => it.contains(el));
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

/**
 * After a navigation (U22): the new page's first visible h1–h3 headings, each with a ref, so
 * the agent can cor_inspect the text it will assert on instead of typing a selector for it.
 * Starts a fresh ref set, like a snapshot.
 */
function headings({ start = 1 } = {}) {
  refs = new Map();
  meta.clear();
  nextRef = Math.max(nextRef, start); // a new document restarts at e1: never reuse a number the agent still holds
  const items = [...document.querySelectorAll('h1,h2,h3')]
    .filter((h) => h.getBoundingClientRect().height > 0 && squash(h.textContent))
    .slice(0, 5)
    .map((h) => ({ level: h.tagName.toLowerCase(), text: squash(h.textContent), ref: issueRef(h) }));
  return { items, live: [...refs.keys()] };
}

/** The element a ref or selector names, for act tools; null when it does not resolve. */
const element = (target) => resolveTarget(target).el ?? null;

/** P1c: count each XPath with the browser's own XPath engine (document.evaluate) — what WebdriverIO and Cypress hand it. */
function countXpaths({ xpaths }) {
  return xpaths.map((xp) => document.evaluate(`count(${xp})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue);
}

/** P1c: does the XPath template, filled with `value`, find exactly `element` and nothing else? */
function xpathFindsOnly({ element, template, value }) {
  const xp = template.replaceAll(/__\w+__/g, () => xpathLiteral(value));
  const hits = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return hits.snapshotLength === 1 && hits.snapshotItem(0) === element;
}

/** V2: how many open shadow roots deep the element sits, and its outermost host ("#host", "my-card.big"), or null in the light DOM. */
function shadowOf(el) {
  let depth = 0;
  let host = null;
  for (let root = el.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    depth++;
    host = root.host;
  }
  if (!depth) return null;
  const cls = [...host.classList][0];
  return { depth, host: host.id ? `#${host.id}` : `${host.tagName.toLowerCase()}${cls ? `.${cls}` : ''}` };
}

/** Every element matching `selector`, in the document and inside open shadow roots. */
function queryDeep(selector, root = document) {
  const out = [...root.querySelectorAll(selector)];
  for (const host of root.querySelectorAll('*')) if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
  return out;
}

/**
 * Cypress does not look inside a shadow root unless `includeShadowDom` is set. The first ranked CSS candidate that,
 * with that setting on (a piercing query), finds exactly this element — or null. Only for an element in a shadow root.
 */
function cypressShadowFix(el, locators) {
  if (!shadowOf(el)) return null; // only to skip a walk of the whole page: the renderer also requires a shadow root
  for (const l of locators) {
    if (/::shadow|^\/|^\(/.test(l.value)) continue; // not CSS: cy.get cannot take it
    let hits;
    try { hits = queryDeep(l.value); } catch { continue; }
    if (hits.length === 1 && hits[0] === el) return { selector: l.value };
  }
  return null;
}

/** Iframes a reader of the top document cannot see into: visible ones, with what names them. */
function framesOf() {
  return [...document.querySelectorAll('iframe,frame')].filter(isVisible).map((f) => {
    let sameOrigin = false;
    try { sameOrigin = Boolean(f.contentDocument); } catch { /* cross-origin */ }
    return { name: f.title || f.getAttribute('aria-label') || f.name || null, sameOrigin };
  });
}

/** P1c: does the page carry any test attribute (data-cy, data-test, data-testid, data-qa)? */
const hasTestAttributes = () => Boolean(document.querySelector('[data-cy],[data-test],[data-testid],[data-test-id],[data-qa]'));

/** U12 review fix: the live element's fingerprint, for the identity check in heal. */
function fingerprintOf({ element: el }) {
  return el ? computeFingerprint(el) : null;
}

/** U12: how closely a live element matches a stored fingerprint (0–1). */
function similarityTo({ element: el, fingerprint }) {
  return el ? scoreSimilarity(fingerprint, computeFingerprint(el)) : 0;
}

/** U12: the page's elements ranked by similarity to a stored fingerprint — the top two scores, for the evidence line. */
function healScores({ fingerprint }) {
  const [a, b] = findByFingerprint(fingerprint).filter((c) => isVisible(c.element));
  return { best: a?.similarity ?? 0, next: b?.similarity ?? 0 };
}

/**
 * U12: the best match — only when it clears `min` AND leads the runner-up by `margin`. Six "Add to cart" buttons score
 * alike; picking one of them would be a wrong-element heal, so a near tie returns null (decline).
 */
function healBest({ fingerprint, min, margin }) {
  const [a, b] = findByFingerprint(fingerprint).filter((c) => isVisible(c.element));
  if (!a || a.similarity < min || (b && a.similarity - b.similarity < margin)) return null;
  return a.element;
}

window.__corMcp = { snapshot, scoped, inspect, element, headings, grade, scoreSteps, stableScopeFor, itemCandidates, itemIndexOf, beginAct, afterAct, countXpaths, frames: framesOf, xpathFindsOnly, similarityTo, healScores, healBest, fingerprintOf };
