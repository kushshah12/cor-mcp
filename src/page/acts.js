// What an act did to the page (U16 + U17). Runs in the page.
//
// U16 — refs survive an act. Every act used to make every ref stale, forcing a
// full re-snapshot after each click. Now each ref carries the identity of the
// element it was issued for; after an act a ref is
//   kept      the same node, same identity
//   re-bound  its node was replaced, and exactly one element on the page now
//             has the same identity at the same structural position
//   stale     anything else — never guessed. Identical twins (three "Add"
//             buttons) share an identity, so a replaced twin is never re-bound.
// Identity = fingerprint without classes (a click toggles `active`) plus the
// outline context the element sits in ("item \"Red Hat\""), so a reused node
// now showing another row's data is not the same element.
//
// U17 — act responses report what changed: controls that appeared (with refs,
// so the agent can act on them without a snapshot), disappeared, or changed
// state, grouped under a container that appeared with them.
import { computeFingerprint } from '@corlabs/engine/core';
import { HEADING, clip, closestControl, deepQueryAll, isControl, isShown, isVisible, roleAndName, squash } from './dom.js';
import { containersFor, label, statesOf } from './outline.js';
import { rememberRemoved } from './removed.js';

const visibleHeadings = () => [...document.querySelectorAll(HEADING)].filter(isVisible);

const contextOf = (el, headings) =>
  containersFor(el, headings).map((c) => `${c.type}:${c.label ?? ''}`).join(' > ');

/** The identity a ref is issued against. */
export function identityOf(el, headings = visibleHeadings()) {
  const { tag, attrs, text } = computeFingerprint(el);
  return JSON.stringify([tag, attrs, text, contextOf(el, headings)]);
}

/** Tags and positions only — where an element sits, whatever it shows. */
export function structuralPath(el) {
  const steps = [];
  for (let n = el; n && n.parentElement; n = n.parentElement) {
    const same = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
    steps.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})`);
  }
  return steps.join(' > ');
}

/**
 * U16. Re-check every live ref after an act. Mutates `refs` (ref → element)
 * and `meta` (ref → { identity, path }).
 */
export function revalidate(refs, meta) {
  const headings = visibleHeadings();
  const kept = [];
  const rebound = [];
  const dropped = {};
  let byIdentity = null; // built only if some ref lost its node
  const candidatesFor = (identity) => {
    if (!byIdentity) {
      byIdentity = new Map();
      for (const el of deepQueryAll(isControl)) {
        const id = identityOf(el, headings);
        byIdentity.set(id, [...(byIdentity.get(id) ?? []), el]);
      }
    }
    return byIdentity.get(identity) ?? [];
  };

  for (const [ref, el] of [...refs]) {
    const { identity, path } = meta.get(ref) ?? {};
    if (el.isConnected && identityOf(el, headings) === identity) {
      kept.push(ref);
      continue;
    }
    const candidates = candidatesFor(identity);
    if (candidates.length === 1 && structuralPath(candidates[0]) === path) {
      refs.set(ref, candidates[0]);
      rebound.push(ref);
      continue;
    }
    refs.delete(ref);
    meta.delete(ref);
    dropped[ref] = !el.isConnected && candidates.length === 0 ? 'was removed'
      : candidates.length > 1 ? 'was replaced and now has lookalikes, so it is not guessed'
        : 'changed what it shows or where it sits';
  }
  return { kept: kept.length, rebound, dropped };
}

// ── U17: before / after ────────────────────────────────────────────────────
let before = null; // Map<element, { role, name, states, value }> for this document

function describe(el) {
  const { role, name } = roleAndName(el);
  return {
    role,
    name,
    states: statesOf(el).join(' '),
    value: el.tagName === 'SELECT' ? label(el.selectedOptions[0]?.textContent) : null,
  };
}

// U20 — text too: a price after switching to Monthly, an FAQ answer that
// opened. Reporting only controls sent the plain-prompt run's agent to 13.6k
// characters of DOM probes to read them.
let textsBefore = null; // Map<element, text>
const MAX_TEXTS = 8;
const TEXT_MAX = 80;

/**
 * Is `el` clipped away by a collapsed ancestor — height or width 0 with
 * overflow hidden? BrowserStack's FAQ answer opens by growing such a wrapper:
 * its text always has a box of its own, so it read as visible before the click.
 */
function collapsedAway(el, cache) {
  const seen = [];
  let hit = false;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    if (cache.has(a)) { hit = cache.get(a); break; }
    seen.push(a);
    const r = a.getBoundingClientRect();
    if (r.height === 0 || r.width === 0) {
      const cs = getComputedStyle(a);
      if (/hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY)) { hit = true; break; }
    }
  }
  for (const a of seen) cache.set(a, hit);
  return hit;
}

/** Visible elements with their own text, outside any control (a control's name is in the control diff), in page order. */
function textLeaves() {
  const texts = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || !t.nodeValue.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    texts.set(el, (texts.get(el) ?? '') + t.nodeValue);
  }
  const collapsed = new Map();
  for (const [el, text] of texts) {
    if (closestControl(el) || !isVisible(el) || collapsedAway(el, collapsed)) texts.delete(el);
    else texts.set(el, squash(text));
  }
  return texts;
}

/** Called just before an act. */
export function beginAct() {
  before = new Map(deepQueryAll(isControl).filter(isShown).map((el) => [el, describe(el)]));
  textsBefore = textLeaves();
  return true;
}

/** Text that changed or appeared, each with a ref and its region. A re-render showing the same text is no change. */
function textChanges(issueRef, headings) {
  const now = textLeaves();
  const gone = new Map(); // text → how many nodes that showed it are gone or hidden
  for (const [el, text] of textsBefore) if (!now.has(el)) gone.set(text, (gone.get(text) ?? 0) + 1);
  const out = [];
  for (const [el, text] of now) {
    const was = textsBefore.get(el);
    if (was === text) continue;
    if (was === undefined && gone.get(text)) {
      gone.set(text, gone.get(text) - 1);
      continue;
    }
    const containers = containersFor(el, headings);
    const inner = containers.at(-1);
    // An item named by this very text says nothing more ("in item \"Live\"").
    const where = inner?.label === text ? containers.at(-2) ?? null : inner ?? null;
    const region = containers.find((c) => c.type !== 'item' && c.type !== 'row' && c.label) ?? null;
    out.push({ was: was === undefined ? null : clip(was, TEXT_MAX), text: clip(text, TEXT_MAX), el, region,
      where: where ? `${where.type}${where.label ? ` "${where.label}"` : ''}` : null });
  }
  textsBefore = null;
  // U21: a newly shown section (BrowserStack's individual plans) is summed up
  // per region with a within hint, not listed line by line.
  const shown = out.filter((t) => t.was === null);
  const changed = out.filter((t) => t.was !== null);
  let listed = out;
  let shownGroups = [];
  let unlisted = 0;
  if (shown.length > MAX_TEXTS) {
    const groups = new Map();
    for (const t of shown) {
      const key = t.region?.node ?? null;
      if (!groups.has(key)) groups.set(key, { region: t.region, items: [] });
      groups.get(key).items.push(t);
    }
    const all = [...groups.values()];
    listed = changed;
    unlisted = all.slice(4).reduce((n, g) => n + g.items.length, 0); // regions past the fourth: counted, not dropped
    shownGroups = all.slice(0, 4).map(({ region, items }) => ({
      where: region ? `${region.type} "${region.label}"` : null, label: region?.label ?? null, count: items.length,
      examples: items.slice(0, region ? 1 : 3).map((t) => ({ text: t.text, ref: issueRef(t.el) })),
    }));
  }
  return {
    texts: listed.slice(0, MAX_TEXTS).map(({ el, region, ...t }) => ({ ...t, ref: issueRef(el) })),
    moreTexts: Math.max(0, listed.length - MAX_TEXTS) + unlisted,
    shownGroups,
  };
}

const MAX_CHANGES = 15;

/**
 * Called after an act (and its settle). Appeared controls get refs via
 * `issueRef`, grouped under the outermost container that is new with them.
 */
export function endAct(issueRef) {
  if (!before) return { changes: null };
  const headings = visibleHeadings();
  const now = deepQueryAll(isControl).filter(isShown);
  const nowSet = new Set(now);
  const changes = [];

  // A re-render replaces nodes: an old control gone and an identical new one
  // in its place is no change. Pair them off by role and name first.
  let appeared = now.filter((el) => !before.has(el));
  const gone = [...before.keys()].filter((el) => !nowSet.has(el));
  const rerendered = new Set();
  for (const old of gone) {
    const was = before.get(old);
    const twin = appeared.find((el) => { const d = describe(el); return d.role === was.role && d.name === was.name; });
    if (twin) {
      rerendered.add(old);
      appeared = appeared.filter((el) => el !== twin);
    }
  }

  // Appeared, grouped by a container that did not exist before the act.
  const groups = new Map();
  for (const el of appeared) {
    const containers = containersFor(el, headings);
    // A section's node is its heading, which holds no control — only real
    // containers (dialog, table, row, item, landmark…) can be "new".
    const fresh = containers.find((c) => c.type !== 'section' && ![...before.keys()].some((b) => c.node.contains(b)));
    const key = fresh ? fresh.node : el;
    if (!groups.has(key)) groups.set(key, { container: fresh ? `${fresh.type}${fresh.label ? ` "${fresh.label}"` : ''}` : null, leaves: [] });
    const d = describe(el);
    groups.get(key).leaves.push({ ref: issueRef(el), ...d });
  }
  for (const { container, leaves } of groups.values()) changes.push({ kind: 'appeared', container, leaves });

  // U21: removed controls are counted by role and name, then reported as one
  // line — the plain-prompt run's For Individuals click listed each on its own
  // line, the same ones twice (4.4k characters).
  const goneByName = new Map();
  for (const [el, was] of before) {
    if (!nowSet.has(el)) {
      if (!rerendered.has(el)) {
        const key = `${was.role}|${was.name}`;
        goneByName.set(key, { role: was.role, name: was.name, count: (goneByName.get(key)?.count ?? 0) + 1 });
        // Removed, not hidden: a hidden element is still counted, a removed one never is.
        if (!el.isConnected) rememberRemoved(el, `${was.role}${was.name ? ` "${was.name}"` : ''}`);
      }
      continue;
    }
    const is = describe(el);
    if (is.states !== was.states || is.value !== was.value || is.name !== was.name) {
      changes.push({ kind: 'changed', role: is.role, name: is.name, was, is });
    }
  }
  const total = [...goneByName.values()].reduce((n, g) => n + g.count, 0);
  if (total === 1) changes.push({ kind: 'disappeared', ...[...goneByName.values()][0] });
  else if (total > 1) changes.push({ kind: 'gone', total, controls: [...goneByName.values()] });
  before = null;
  return { changes: changes.slice(0, MAX_CHANGES), more: Math.max(0, changes.length - MAX_CHANGES), ...textChanges(issueRef, headings) };
}
