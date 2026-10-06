// Refactor (review): the page outline (cor_snapshot) and one region in full (within), split from format.js.
const SNAPSHOT_LEGEND =
  'Pass a ref to cor_inspect or an act tool; refs expire on navigation and any act. "a › b": b inside a. ' +
  '✓id: test attribute. +N hidden: invisible elements with the same role and name. [unstable id]: id changed on reload. ' +
  'clickable: no role, only cursor: pointer (a script-handled <div>).';
const VIA_LABEL_LEGEND = '[via label]: a hidden input shown by its label — click the label, check state on the input.';

const GROUP_LEGEND = '"N items, each: …": every item has those controls; its line lists their refs in that order.';

function leafText(leaf, unstableIds) {
  let text = `${leaf.role}${leaf.name ? ` "${leaf.name}"` : ''}${leaf.cls ? ` (.${leaf.cls})` : ''}${leaf.value ? ` = "${leaf.value}"` : ''} [ref=${leaf.ref}]`;
  if (leaf.testId) text += ' ✓id';
  for (const state of leaf.states) text += ` [${state}]`;
  if (leaf.hidden) text += ` +${leaf.hidden} hidden`;
  if (leaf.id && unstableIds.has(leaf.id)) text += ' [unstable id]';
  if (leaf.viaLabel) text += ' [via label]';
  if (leaf.hint) text += ` ${leaf.hint}`;
  return text;
}

const containerText = (c) => `${c.type}${c.label ? ` "${c.label}"` : ''}`;

/** What sets one control apart beyond role and name: the per-item part of a group line. */
function markers(leaf, unstableIds) {
  const out = [];
  if (leaf.cls) out.push(`(.${leaf.cls})`);
  if (leaf.value) out.push(`= "${leaf.value}"`);
  if (leaf.testId) out.push('✓id');
  for (const state of leaf.states) out.push(`[${state}]`);
  if (leaf.hidden) out.push(`+${leaf.hidden} hidden`);
  if (leaf.id && unstableIds.has(leaf.id)) out.push('[unstable id]');
  if (leaf.viaLabel) out.push('[via label]');
  return out.join(' ');
}

const GROUP_MIN = 3;
const RUN_LEGEND = 'N× role "name": identical controls, one ref each in page order.';

// U20. A link list with this many controls folds to one line, unless it holds
// half the page or more (then there would be nothing left to see). Tables and
// rows never fold: the "each:" grouping already keeps them to one line a row,
// and they are what tests read. BrowserStack pricing's footer: 66 links.
const FOLD_MIN = 25;
const NO_FOLD = new Set(['table', 'row', 'column']);
const controlCount = (node) => (node.kind === 'leaf' ? 1 : node.children.reduce((n, c) => n + controlCount(c), 0));
const leavesOf = (node) => (node.kind === 'leaf' ? [node] : node.children.flatMap(leavesOf));

// The name cor_snapshot within takes: sections and items always have a label;
// an unlabelled landmark goes by its type ("footer"). Tables never fold.
const foldName = (node) => node.label ?? node.type;

function foldLine(node, total) {
  const count = controlCount(node);
  const name = foldName(node);
  if (NO_FOLD.has(node.type) || count < FOLD_MIN || count * 2 >= total) return null;
  const roles = new Map();
  for (const leaf of leavesOf(node)) roles.set(leaf.role, (roles.get(leaf.role) ?? 0) + 1);
  // Only link lists fold (footers, site menus): a section of fields, buttons
  // or a table is what tests act on. selectorshub's "iframe and table" folded without this.
  if ((roles.get('link') ?? 0) < count * 0.8) return null;
  const size = [...roles].map(([role, n]) => `${n} ${role}${n === 1 ? '' : /(s|x|ch)$/.test(role) ? 'es' : 's'}`).join(', ');
  // What is inside, by its named parts: `(sections "PRODUCTS", "RESOURCES", …)`.
  const named = node.children.filter((c) => c.kind === 'container' && c.label);
  const parts = named.length ? ` (${named[0].type}s ${named.slice(0, 6).map((c) => `"${c.label}"`).join(', ')}${named.length > 6 ? ', …' : ''})` : '';
  return `${containerText(node)}: ${size}, folded${parts} — cor_snapshot within: "${name}" lists them`;
}

/** Same role, name and markers: controls an agent tells apart only by position. */
const runKey = (item, unstableIds) => {
  const [node] = item.nodes;
  return !item.hinted && item.nodes.length === 1 && node.kind === 'leaf' && !HINT_IN.test(node.hint ?? '')
    ? `${node.role}|${node.name}|${markers(node, unstableIds)}` : null;
};
const HINT_IN = /^in "(.*)"$/;

/**
 * Sibling nodes as items: a container whose children are all controls, or a
 * run of controls sharing one `in "…"` hint (bstackdemo's cards reach the
 * outline as leaves hinted with their product). `controls` is null when the
 * node cannot be an item.
 */
function itemsOf(nodes) {
  const items = [];
  for (const node of nodes) {
    if (node.kind === 'container') {
      items.push({ nodes: [node], type: node.type, label: node.label,
        controls: node.label && node.children.every((c) => c.kind === 'leaf') ? node.children : null });
      continue;
    }
    const label = HINT_IN.exec(node.hint ?? '')?.[1] ?? null;
    const last = items.at(-1);
    if (label !== null && last?.hinted && last.label === label) {
      last.nodes.push(node);
      last.controls.push(node);
      continue;
    }
    items.push({ nodes: [node], type: 'item', label, hinted: label !== null, controls: label !== null ? [node] : null });
  }
  return items;
}

const shapeOf = (item) => (item.controls ? `${item.type}|${item.controls.map((c) => `${c.role}|${c.name}`).join('||')}` : null);
const controlText = (c) => `${c.role}${c.name ? ` "${c.name}"` : ''}`;
const plural = (type, n) => `${n} ${type === 'item' ? 'item' : type}${n === 1 ? '' : 's'}`;

/**
 * Repeated items collapse to one "each:" line plus one line per item with its
 * own refs — never a range to count through, so picking "the Galaxy S20's
 * Add to cart" reads its ref straight off its line. Anything that sets one
 * item's control apart stays beside that ref; an item with other controls
 * breaks the run.
 */
function renderGroup(run, depth, unstableIds, out) {
  const pad = '  '.repeat(depth);
  out.push(`${pad}- ${plural(run[0].type, run.length)}, each: ${run[0].controls.map(controlText).join(', ')}`);
  for (const item of run) {
    const refs = item.controls.map((c) => [c.ref, markers(c, unstableIds)].filter(Boolean).join(' ')).join(', ');
    out.push(`${pad}  - "${item.label}": ${refs}`);
  }
}

/** Chains of single-child containers fold into one line: `section "Team Ultimate" › button "Choose"`. */
function renderNodes(nodes, depth, unstableIds, out, stats = { groups: 0, runs: 0, total: Infinity }) {
  const items = itemsOf(nodes);
  for (let i = 0; i < items.length;) {
    const key = runKey(items[i], unstableIds);
    let k = i + 1;
    while (key && k < items.length && runKey(items[k], unstableIds) === key) k++;
    if (key && k - i >= GROUP_MIN) {
      const [first] = items[i].nodes;
      const extra = markers(first, unstableIds);
      out.push(`${'  '.repeat(depth)}- ${k - i}× ${controlText(first)}: ${items.slice(i, k).map((it) => it.nodes[0].ref).join(', ')}${extra ? ` ${extra}` : ''}`);
      stats.runs += 1;
      i = k;
      continue;
    }
    const shape = shapeOf(items[i]);
    let j = i + 1;
    while (shape && j < items.length && shapeOf(items[j]) === shape) j++;
    if (shape && j - i >= GROUP_MIN) {
      renderGroup(items.slice(i, j), depth, unstableIds, out);
      stats.groups += 1;
      i = j;
      continue;
    }
    for (const item of items.slice(i, j)) {
      for (let node of item.nodes) {
        const folded = node.kind === 'container' ? foldLine(node, stats.total) : null;
        if (folded) {
          out.push(`${'  '.repeat(depth)}- ${folded}`);
          continue;
        }
        const prefix = [];
        while (node.kind === 'container' && node.children.length === 1) {
          prefix.push(containerText(node));
          node = node.children[0];
        }
        const own = node.kind === 'leaf' ? leafText(node, unstableIds) : containerText(node);
        out.push(`${'  '.repeat(depth)}- ${[...prefix, own].join(' › ')}`);
        if (node.kind === 'container') renderNodes(node.children, depth + 1, unstableIds, out, stats);
      }
    }
    i = j;
  }
  return out;
}

/**
 * @param {{ url: string, title: string, count: number, tree: object[] }} snapshot
 * @param {{ unstableIds?: Set<string> }} [options]  ids U7's reload check found regenerated
 */
export function renderSnapshot(snapshot, { unstableIds = new Set() } = {}) {
  const head = `${snapshot.title ? `"${snapshot.title}" ` : ''}${snapshot.url} — ${snapshot.count} interactive element${snapshot.count === 1 ? '' : 's'}`;
  const stats = { groups: 0, runs: 0, total: snapshot.count };
  const lines = renderNodes(snapshot.tree, 0, unstableIds, [], stats);
  const viaLabel = (nodes) => nodes.some((n) => (n.kind === 'leaf' ? n.viaLabel : viaLabel(n.children)));
  const legend = [SNAPSHOT_LEGEND, stats.groups && GROUP_LEGEND, stats.runs && RUN_LEGEND, viaLabel(snapshot.tree) && VIA_LABEL_LEGEND].filter(Boolean).join(' ');
  return [head, legend, ...framesNote(snapshot.frames), '', ...lines].join('\n');
}

// ── region index (P2a) ──────────────────────────────────────────────────────
// A large page's outline (BrowserStack pricing: 205 controls, 8.6k characters) is replaced by one line per region: its
// name, how many controls it holds, and the named controls to act on first — toggles and fields, then buttons, then links.
const INDEX_REGION_MAX = 40; // a labelled region with more controls than this is split into its own regions
const INDEX_LINES = 18;
const INDEX_NAMED = 4;
const ROLE_RANK = (role) => (/^(radio|checkbox|switch|tab|combobox|textbox|searchbox|spinbutton|slider|option)$/.test(role) ? 0 : role === 'button' ? 1 : role === 'link' ? 3 : 2);

function regionsOf(nodes, out, loose) {
  for (const node of nodes) {
    if (node.kind === 'leaf') { loose.push(node); continue; }
    const count = controlCount(node);
    const split = node.children.some((c) => c.kind === 'container' && c.label);
    if (node.label && (count <= INDEX_REGION_MAX || !split)) out.push(node);
    else regionsOf(node.children, out, loose);
  }
  return out;
}

const linkList = (node) => { const leaves = leavesOf(node); return leaves.length > 0 && leaves.filter((l) => l.role === 'link').length >= leaves.length * 0.8; };

function namedLine(leaves) {
  const seen = new Map();
  for (const leaf of leaves) {
    const key = `${leaf.role}|${leaf.name}`;
    if (seen.has(key)) seen.get(key).n += 1;
    else seen.set(key, { leaf, n: 1 });
  }
  const ranked = [...seen.values()].sort((a, b) => ROLE_RANK(a.leaf.role) - ROLE_RANK(b.leaf.role));
  const shown = ranked.slice(0, INDEX_NAMED).map(({ leaf, n }) => `${controlText(leaf)} [ref=${leaf.ref}]${n > 1 ? ` ×${n}` : ''}${leaf.states.length ? ` [${leaf.states.join('] [')}]` : ''}${leaf.viaLabel ? ' [via label]' : ''}`);
  return `${shown.join(', ')}${ranked.length > INDEX_NAMED ? `, … ${ranked.length - INDEX_NAMED} more` : ''}`;
}

/**
 * @param {{ url: string, title: string, count: number, tree: object[] }} snapshot
 * @param {{ file?: string|null }} [options]  where the full outline was written, if it was
 */
export function renderIndex(snapshot, { file = null } = {}) {
  const loose = [];
  const regions = regionsOf(snapshot.tree, [], loose);
  const head = `${snapshot.title ? `"${snapshot.title}" ` : ''}${snapshot.url} — ${snapshot.count} interactive elements in ${regions.length} region${regions.length === 1 ? '' : 's'} (index)`;
  const where = file ? `the full outline is in ${file} (refs and text only)` : 'cor_snapshot full: true lists every control';
  const lines = [];
  for (let i = 0; i < regions.length && lines.length < INDEX_LINES; i++) {
    // A run of link lists (footer columns, menus) is one line: tests rarely act there.
    let j = i;
    while (j < regions.length && linkList(regions[j])) j++;
    if (j - i >= 2) {
      const links = regions.slice(i, j).reduce((n, x) => n + controlCount(x), 0);
      lines.push(`- ${j - i} link lists (${links} links): ${regions.slice(i, j).slice(0, 6).map((x) => `"${foldName(x)}"`).join(', ')}${j - i > 6 ? ', …' : ''}`);
      i = j - 1;
      continue;
    }
    const leaves = leavesOf(regions[i]);
    // Its items: labelled sub-regions (a card per plan) or controls hinted with their item (`in "Team"`).
    const named = regions[i].children.filter((c) => c.kind === 'container' && c.label).map((c) => c.label);
    const items = [...new Set([...named, ...leaves.map((l) => HINT_IN.exec(l.hint ?? '')?.[1]).filter(Boolean)])];
    const itemPart = items.length >= 2 ? `; ${items.length} items: ${items.slice(0, 5).map((x) => `"${x}"`).join(', ')}${items.length > 5 ? ', …' : ''}` : '';
    lines.push(`- ${containerText(regions[i])} (${controlCount(regions[i])}): ${namedLine(leaves)}${itemPart}`);
    regions[i].shown = true;
  }
  if (loose.length) lines.push(`- outside any region (${loose.length}): ${namedLine(loose)}`);
  const unshown = regions.filter((x) => !x.shown && !linkList(x));
  if (lines.length >= INDEX_LINES && unshown.length) lines.push(`… ${unshown.length} more regions: ${unshown.slice(0, 12).map((x) => `"${foldName(x)}"`).join(', ')}`);
  return [head,
    `One line per region: its controls, the named ones first. Refs are live. Pass a region's name to cor_snapshot within for its controls, text and entries; ${where}.`,
    ...framesNote(snapshot.frames), '', ...lines].join('\n');
}

/**
 * The iframes COR cannot read: it lists and inspects the top document only, so the controls
 * inside a frame are missing from the snapshot and cannot be reached — said, not silently left out.
 */
export function framesNote(frames) {
  if (!frames?.length) return [];
  const named = frames.slice(0, 3).map((f) => `${f.name ? `"${f.name}"` : 'unnamed'} (${f.sameOrigin ? 'same origin' : 'another site'})`).join(', ');
  const more = frames.length > 3 ? ` and ${frames.length - 3} more` : '';
  return [`Not listed: ${frames.length} iframe${frames.length === 1 ? '' : 's'} — ${named}${more}. COR reads the top document only; controls inside a frame are not in this list and cannot be inspected or acted on yet.`];
}

// ── scoped snapshot (U15) ───────────────────────────────────────────────────
const regionText = (r) => `${r.kind}${r.label ? ` "${r.label}"` : ''}`;

/** One region in full: headings, text, images and controls, in page order. */
export function renderScoped(scoped, within, { unstableIds = new Set() } = {}) {
  const head = `${scoped.title ? `"${scoped.title}" ` : ''}${scoped.url} — ${regionText(scoped.region)} in full (within: ${within})`;
  const note = 'All text in this region, in page order. Its refs are added to the current snapshot\'s; refs expire on navigation and any act.';
  const lines = scoped.lines.map((line) => {
    if (line.kind === 'leaf') return `- ${leafText(line, unstableIds)}`;
    if (line.kind === 'cell') return `- cell "${line.column}" [ref=${line.ref}]: ${line.content}`;
    return `- ${line.kind} "${line.text}"${line.ref ? ` [ref=${line.ref}]` : ''}`;
  });
  if (scoped.truncated) lines.push(`… ${scoped.truncated} more lines — pass a narrower region as within.`);
  return [head, note, '', ...lines].join('\n');
}

/** A name that fits several regions: the candidates, each with a ref to pass back. */
export function renderAmbiguousScope(scoped, within) {
  const lines = scoped.candidates.map((c, i) => {
    const sample = c.sample ? `${c.sample.role}${c.sample.name ? ` "${c.sample.name}"` : ''} [ref=${c.sample.ref}]` : 'no control inside';
    return `${i + 1}. ${c.where || regionText(c)} — e.g. ${sample}`;
  });
  if (scoped.more) lines.push(`…and ${scoped.more} more.`);
  return [
    `"${within}" names ${scoped.candidates.length + (scoped.more ?? 0)} regions. Pick one and pass a ref from inside it as within:`,
    ...lines,
  ].join('\n');
}
