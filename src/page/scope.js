// Scoped snapshot (U15): full detail for one region — prices, labels, every
// line of text — without enlarging the default snapshot. Runs in the page.
//
// `within` is a ref (the region that identifies that element) or a region's
// name: a heading, a landmark's label, a list item's or table row's text.
// A name that fits several regions is not guessed at — the candidates come
// back, each with a ref inside it, for the agent to choose.
import { DEFAULT_TEST_ID_ATTRIBUTES, isUnstableClass } from '@corlabs/engine/core';
import { columnNameOf } from './params.js';
import { HEADING, clip, deepQueryAll, hasControl, isControl, isShown, isVisible, roleAndName, squash, visibleLabelOf } from './dom.js';
import {
  CELL, ITEM, LANDMARKS, TABLE, ariaLabel, containersFor, headingLevel, label, ownText, rowKey, statesOf,
} from './outline.js';

const MAX_LINES = 80;
const TEXT_MAX = 120;
const LANDMARK_SELECTOR = LANDMARKS.map(([, s]) => s).join(',');

const visibleHeadings = () => [...document.querySelectorAll(HEADING)].filter(isVisible);

/**
 * A heading's region: the smallest ancestor that holds a control and no other
 * heading of the same or a higher level — a plan card for its <h3>, a table
 * header cell for the <h3> inside it. Where no ancestor fits (a page-level
 * <h2> among siblings), the heading's outline section: what follows it up to
 * the next heading of the same or a higher level.
 */
function headingRegion(h) {
  const level = headingLevel(h);
  const rivals = visibleHeadings().filter((o) => o !== h && headingLevel(o) <= level);
  for (let a = h.parentElement; a && a !== document.body; a = a.parentElement) {
    if (rivals.some((o) => a.contains(o))) break;
    if (hasControl(a)) return { root: a, contains: (el) => a.contains(el) };
  }
  const next = visibleHeadings().find((o) => o !== h && headingLevel(o) <= level && (h.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING));
  const root = h.parentElement ?? document.body;
  return {
    root,
    contains: (el) => el === h || h.contains(el) || (root.contains(el)
      && !!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (!next || !!(el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING))),
  };
}

/**
 * The nearest ancestor that is one of several like siblings — same tag and a
 * shared hand-written class: a card in a grid. The fallback when no section,
 * list, table, landmark or panel holds the element. BrowserStack's Team card
 * has no heading (its name is a toggle label), so scoping to it failed and
 * the agent read the card's price with DOM probes instead.
 */
function cardOf(el) {
  // A card shows more than the control: BrowserStack wraps the seats control
  // in a toggled pair (Team / Team Pro) whose wrapper has a like sibling but
  // holds nothing else, and that wrapper is not the card.
  const own = squash(el.innerText ?? el.textContent);
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const names = [...a.classList].filter((c) => !isUnstableClass(c));
    if (!names.length || !isVisible(a) || squash(a.innerText) === own) continue;
    const like = [...(a.parentElement?.children ?? [])].some((s) => s !== a && s.tagName === a.tagName && names.some((c) => s.classList.contains(c)));
    if (like) return a;
  }
  return null;
}

/** A card's name: its first visible heading, else its label, else its first short line of text. */
function cardLabel(card) {
  // A heading names the card only when it comes before the card's first
  // control; one further down titles a features list ("Desktop & Mobile, plus:").
  const first = deepQueryAll(isControl, card).find(isShown);
  const heading = [...card.querySelectorAll(HEADING)].find((h) => isVisible(h) && (!first || (h.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)));
  return label(heading?.textContent) ?? ariaLabel(card) ?? ownText(card) ?? null;
}

/** The nearest ancestor with `position: fixed` (not <body>). */
function fixedPanelOf(el) {
  for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (getComputedStyle(n).position === 'fixed') return n;
  }
  return null;
}

const panelLabel = (panel) => ariaLabel(panel) ?? label([...panel.querySelectorAll(HEADING)].find(isVisible)?.textContent) ?? null;

const nodeRegion = (root) => ({ root, contains: (el) => root.contains(el) });

/** The innermost region that identifies an element — the same containers the outline shows. */
function regionOfElement(el) {
  const kept = containersFor(el, visibleHeadings());
  const inner = kept.at(-1);
  // A fixed-position panel — a cart drawer, a modal without a dialog role —
  // is the region when it sits inside whatever else identifies the element.
  // bstackdemo's float cart had no section, list or landmark, so scoping to
  // it failed.
  const panel = fixedPanelOf(el);
  if (panel && (!inner || !panel.contains(inner.node))) return { ...nodeRegion(panel), kind: 'panel', label: panelLabel(panel) };
  if (!inner) {
    const card = cardOf(el);
    return card ? { ...nodeRegion(card), kind: 'card', label: cardLabel(card) } : null;
  }
  const region = inner.type === 'section' ? headingRegion(inner.node) : nodeRegion(inner.node);
  return { ...region, kind: inner.type, label: inner.label };
}

/** Every region whose name is `query`: exact matches, else those containing it. */
function regionsNamed(query) {
  const want = squash(query).toLowerCase();
  const named = [];
  for (const h of visibleHeadings()) named.push({ text: squash(h.textContent), make: () => ({ ...headingRegion(h), kind: 'section' }) });
  for (const n of document.querySelectorAll(LANDMARK_SELECTOR)) {
    if (isVisible(n)) named.push({ text: ariaLabel(n) ?? LANDMARKS.find(([, sel]) => n.matches(sel))[0], make: () => ({ ...nodeRegion(n), kind: LANDMARKS.find(([, s]) => n.matches(s))[0] }) });
  }
  for (const n of document.querySelectorAll(ITEM)) {
    if (isVisible(n)) named.push({ text: ownText(n, ITEM) ?? '', make: () => ({ ...nodeRegion(n), kind: 'item' }) });
  }
  for (const row of document.querySelectorAll('tr,[role="row"]')) {
    if (isVisible(row) && row.closest(TABLE)) named.push({ text: rowKey(row) ?? '', make: () => ({ ...nodeRegion(row), kind: 'row' }) });
  }
  const pick = (match) => named.filter((n) => n.text && match(n.text.toLowerCase()));
  const hits = pick((t) => t === want);
  // U21b: the name of a control (the FAQ question just clicked) names the
  // region around it, as its ref would. Only when exactly one control has it.
  if (!hits.length) {
    const controls = deepQueryAll(isControl).filter((el) => isShown(el) && squash(roleAndName(el).name).toLowerCase() === want);
    const region = controls.length === 1 ? regionOfElement(controls[0]) : null;
    if (region) return [{ ...region, label: region.label ?? clip(squash(query), 50) }];
  }
  const chosen = hits.length ? hits : pick((t) => t.includes(want));
  // Two names can resolve to one region (a column header cell's own heading).
  const regions = [];
  for (const n of chosen) {
    const region = { ...n.make(), label: clip(n.text, 50) };
    if (!regions.some((r) => r.root === region.root && r.kind === region.kind)) regions.push(region);
  }
  return regions;
}

const hiddenForText = (el) => {
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
};

/** The region's content in page order: headings, controls (with refs), images, and text. */
function contentOf(region, issueRef) {
  const testIdSelector = DEFAULT_TEST_ID_ATTRIBUTES.map((a) => `[${a}]`).join(',');
  const lines = [];
  let buffer = '';
  let pieces = []; // the text nodes in the buffer
  // U21: a text line's ref is the element holding all of it, so an answer or
  // a price can be inspected (the plain-prompt run's agent guessed selectors).
  const holder = () => {
    let a = pieces[0].parentElement;
    while (a && !pieces.every((t) => a.contains(t))) a = a.parentElement;
    return a;
  };
  const flush = () => {
    const text = squash(buffer);
    const el = pieces.length ? holder() : null;
    buffer = '';
    pieces = [];
    if (text && lines.at(-1)?.text !== text) lines.push({ kind: 'text', text: clip(text, TEXT_MAX), ref: el ? issueRef(el) : null });
  };
  const emitted = new Set();
  const emitLeaf = (el) => {
    flush();
    emitted.add(el);
    const { role, name } = roleAndName(el);
    lines.push({
      kind: 'leaf', ref: issueRef(el), role, name, testId: el.matches(testIdSelector), states: statesOf(el), hidden: 0,
      id: /\d$/.test(el.id) ? el.id : null,
      value: el.tagName === 'SELECT' ? label(el.selectedOptions[0]?.textContent) : null,
      viaLabel: Boolean(visibleLabelOf(el)) || undefined,
    });
  };
  const walk = (node) => {
    // Children of a horizontal flex row read as one line ("$ 375 / month"),
    // though the browser reports each as a block.
    const row = node.nodeType === 1 && (() => {
      const style = getComputedStyle(node);
      return style.display.includes('flex') && style.flexDirection.startsWith('row');
    })();
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (region.contains(child.parentElement) || region.contains(child)) {
          buffer += child.nodeValue;
          if (child.nodeValue.trim()) pieces.push(child);
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const inside = region.contains(child);
      // A hidden toggle shown by its label (#1) is a control even though the
      // text walk would skip it as hidden; its label's text is its name, so the
      // label is not repeated as a text line. A wrapping label stands in for it.
      const proxied = child.tagName === 'LABEL' && child.control && visibleLabelOf(child.control) === child ? child.control : null;
      if (inside && proxied) {
        if (!emitted.has(proxied)) emitLeaf(proxied);
        continue;
      }
      if (hiddenForText(child) && !(inside && visibleLabelOf(child))) continue;
      if (inside && isControl(child) && isShown(child)) {
        if (!emitted.has(child)) emitLeaf(child);
        continue;
      }
      if (inside && child.matches(HEADING)) {
        flush();
        lines.push({ kind: 'heading', text: clip(squash(child.textContent), TEXT_MAX), ref: issueRef(child) });
        continue;
      }
      if (inside && child.tagName === 'IMG' && child.getAttribute('alt')) {
        flush();
        lines.push({ kind: 'img', text: clip(squash(child.getAttribute('alt')), TEXT_MAX) });
        continue;
      }
      const block = !row && !getComputedStyle(child).display.startsWith('inline');
      if (block) flush();
      else if (row) buffer += ' '; // flex items are separate boxes; plain inline text runs on ("Hel<b>lo</b>")
      walk(child);
      if (block) flush();
      else if (row) buffer += ' ';
    }
  };
  walk(region.root);
  flush();
  return { lines: lines.slice(0, MAX_LINES), truncated: Math.max(0, lines.length - MAX_LINES) };
}

/**
 * A table row's cells by column, each with a ref: the route to a cell's
 * row × column template (U19.4). The plain-prompt run's agent never inspected
 * a comparison cell — nothing in a row had a ref — and computed the column by
 * header index instead.
 */
function cellsOf(row, issueRef) {
  return [...row.cells].filter(isVisible).map((cell, i) => {
    const text = squash(cell.innerText);
    const control = deepQueryAll(isControl, cell).find(isShown);
    const img = [...cell.querySelectorAll('img[alt]')].find((el) => isVisible(el) && el.alt.trim());
    let content = '(empty)';
    if (control && (!text || squash(control.innerText) === text)) {
      const { role, name } = roleAndName(control);
      content = `${role}${name ? ` "${name}"` : ''}`;
    } else if (text) content = `"${clip(text, TEXT_MAX)}"`;
    // P3 (run b14ddae4): an image that is the cell's content gets a ref of its own — the agent asserted on it and had to compose
    // cellAt(…).getByRole('img') because only the cell had one; its entry is the cell template with the image inside.
    let contentRef = null;
    if (content === '(empty)' && img) { contentRef = issueRef(img); content = `img "${clip(squash(img.alt), TEXT_MAX)}" [ref=${contentRef}]`; }
    return { kind: 'cell', column: columnNameOf(cell) ?? `${i + 1}`, ref: issueRef(cell), content, contentRef };
  });
}

/** The first visible control inside a region — a ref the agent can pass back as `within`. */
function sampleIn(region) {
  return deepQueryAll(isControl, region.root).find((el) => region.contains(el) && isShown(el)) ?? null;
}

/**
 * @param {{ ref?: string, text?: string, refs: Map, issueRef: Function }} args
 */
export function scopedSnapshot({ ref, text, refs, issueRef }) {
  let regions;
  if (ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return { error: 'gone' };
    const region = regionOfElement(el);
    if (!region) return { error: 'no-region', reason: 'element' };
    regions = [region];
  } else {
    regions = regionsNamed(text);
    if (!regions.length) {
      return { error: 'no-region', reason: 'name', headings: [...new Set(visibleHeadings().map((h) => clip(squash(h.textContent), 50)))].slice(0, 12) };
    }
  }
  if (regions.length > 1) {
    return {
      error: 'ambiguous',
      candidates: regions.slice(0, 8).map((r) => {
        const sample = sampleIn(r);
        const where = sample ? containersFor(sample, visibleHeadings()).map((c) => `${c.type}${c.label ? ` "${c.label}"` : ''}`).join(' › ') : null;
        const leaf = sample ? { ref: issueRef(sample), ...roleAndName(sample) } : null;
        return { kind: r.kind, label: r.label, where, sample: leaf };
      }),
      more: Math.max(0, regions.length - 8),
    };
  }
  const [region] = regions;
  if (region.kind === 'row' && region.root.cells) return { region: { kind: region.kind, label: region.label }, lines: cellsOf(region.root, issueRef), truncated: 0 };
  return { region: { kind: region.kind, label: region.label }, ...contentOf(region, issueRef) };
}
