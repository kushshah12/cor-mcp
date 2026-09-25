// Renders page-side results as text for the agent. Leads with the verdict so
// a reader that truncates still gets the answer.

/** Tiers below this are declined as the answer: the fix is in the application. */
const SUB_FLOOR = new Set(['risky', 'unstable']);

const clause = (message) => String(message ?? '').split(' — ')[0];

// Facts about this page at this moment, not about the locator string — they
// belong in the point-in-time half and never in the durable line.
const RESOLUTION_SIGNALS = new Set(['unique-match', 'no-match', 'multiple-matches', 'unverified-match', 'wrong-element', 'target-hidden-from-api']);

function pointInTime(l) {
  const count = l.matchCount === null || l.matchCount === undefined || l.matchCount < 0 ? 'match count unknown'
    : `${l.matchCount} match${l.matchCount === 1 ? '' : 'es'}`;
  return `${l.score} ${l.tierLabel ?? l.tier ?? 'unscored'} · ${count}`;
}

/** The strongest positive signal, i.e. what the locator is anchored on. */
function anchorOf(l) {
  const positive = l.signals.filter((s) => s.direction === 'positive' && s.points > 0);
  const best = positive.sort((a, b) => b.points - a.points)[0];
  return best ? clause(best.message) : null;
}

function demotionReason(best, rejected, framework) {
  if (rejected.volatileId) return 'its id changes on every page load';
  if (rejected.resolution?.usable === false) {
    const status = rejected.resolution.status;
    if (status === 'ambiguous') return 'it matches more than one element';
    if (status === 'broken') return 'it matches nothing';
    return 'it does not resolve to this element';
  }
  return `${framework} guidance prefers ${best.strategy} over ${rejected.strategy}`;
}

/**
 * The durable half of the verdict, as one placeable line: what the locator is
 * anchored on, what will break it, and what it was chosen over and why. These
 * stay true while the locator string is unchanged. No score and no match
 * count — both are measurements of one DOM at one moment and rot in a comment.
 */
export function durableLine(result) {
  const [best] = result.locators;
  const parts = [];
  // The engine's id signals call it "stable" from one DOM; a reload overruled that.
  const anchor = best.volatileId && /\bid\b/i.test(anchorOf(best) ?? '') ? 'an element id' : anchorOf(best);
  if (anchor) parts.push(`anchored on ${anchor.replace(/^(Anchored on|Targets the element by) /i, '')}`);
  const risk = RESOLUTION_SIGNALS.has(best.primaryRisk?.signalId)
    ? best.signals.filter((s) => s.direction === 'negative' && !RESOLUTION_SIGNALS.has(s.id)).sort((a, b) => a.points - b.points)[0]
    : best.primaryRisk;
  if (best.volatileId) parts.push('risk: its id changes on every page load');
  else parts.push(risk ? `risk: ${clause(risk.message).toLowerCase()}` : 'no known risk');
  const rejected = result.locators.reduce((a, b) => (b.score > a.score ? b : a));
  if (rejected !== best) {
    parts.push(`chosen over ${rejected.code || rejected.value} because ${demotionReason(best, rejected, result.framework)}`);
  }
  return `// COR: ${parts.join('; ')}`;
}

function addTestId(result) {
  for (const l of result.locators) {
    for (const rec of l.recommendations ?? []) {
      const alt = rec.alternatives?.find((a) => a.kind === 'add-testid' && a.snippet);
      if (alt) return alt;
    }
  }
  return null;
}

function locatorBlock(l, rank) {
  const lines = [`${rank}. ${l.code || l.value}`, `   ${pointInTime(l)}`];
  if (l.warnings?.length) lines.push(...l.warnings.map((w) => `   ! ${w}`));
  return lines.join('\n');
}

function profileLine(profile) {
  if (!profile) return null;
  return profile.applied
    ? `Framework convention applied: ${profile.framework} (${profile.source}).`
    : `No framework convention applied — ${profile.reason}.`;
}

const LOOKALIKES_SHOWN = 5;

/**
 * Leads the inspect response when the element has visible lookalikes, so a
 * wrong pick is caught before its (perfectly good) locator is used.
 * `refsLive` is false when no snapshot is current — its refs would mislead.
 */
function lookalikeWarning(lookalikes, refsLive) {
  const { role, name, items } = lookalikes;
  const others = items.filter((i) => !i.target);
  const target = items.find((i) => i.target);
  const what = `${role}${name ? ` "${name}"` : ''}`;
  const place = (i) => [refsLive && i.ref, i.hint || '(no heading or text nearby)'].filter(Boolean).join(' ');
  const n = others.length;
  const lines = [
    `⚠ Check this is the element you meant: ${n} other visible element${n === 1 ? ' looks' : 's look'} the same — ${what}.`,
    `  You inspected: ${place(target)}`,
    ...others.slice(0, LOOKALIKES_SHOWN).map((i) => `  Also:          ${place(i)}`),
  ];
  if (others.length > LOOKALIKES_SHOWN) lines.push(`  …and ${others.length - LOOKALIKES_SHOWN} more.`);
  lines.push(
    refsLive
      ? '  If you meant another one, cor_inspect its ref instead.'
      : '  If you meant another one, call cor_snapshot for current refs and cor_inspect it.',
    '',
  );
  return lines;
}

const VALUES_SHOWN = 4;

/**
 * U18. The template for an element that is one of several items, or why
 * there is none. Playwright gets code to write (a variable, so no escaping in
 * the test) plus the registry form; other frameworks get the XPath form.
 */
function paramBlock(params, framework) {
  if (!params) return [];
  if (!params.template) return ['', `Not parameterised — ${params.count} items share this shape, but ${params.reason}.`];
  const others = params.values.filter((v) => v !== params.value);
  const more = others.length > VALUES_SHOWN ? `, … ${others.length - VALUES_SHOWN} more` : '';
  const out = [
    '',
    `Parameterised — ${params.count} items share this shape; every value checked, each finds exactly its own item (${params.count}/${params.count}):`,
    `  ${params.param} = "${params.value}"   (also: ${others.slice(0, VALUES_SHOWN).map((v) => `"${v}"`).join(', ')}${more})`,
  ];
  if (framework === 'playwright') {
    out.push(`  ${params.code}`, `  Registry template (${params.template.playwright.syntax}): ${params.template.playwright.selectorTemplate}`);
  } else if (params.template.xpath) {
    out.push(`  XPath: ${params.template.xpath.selectorTemplate}   (__${params.param}__ is the quoted XPath literal)`);
  } else {
    return ['', `Not parameterised for ${framework} — the element has no text or attribute an XPath can match exactly.`];
  }
  out.push(`  When the test touches more than one item, write one function taking ${params.param} instead of a locator per item.`);
  return out;
}

export function renderInspect(result, { refsLive = false, framework = result.framework } = {}) {
  const out = result.lookalikes ? lookalikeWarning(result.lookalikes, refsLive) : [];
  const [best, ...alternatives] = result.locators;

  if (!best) {
    out.push('No locator could be generated for this element. What would make it locatable:');
    out.push(...(result.recommendations ?? []).map((r) => `- ${r}`));
    return out.join('\n');
  }

  if (SUB_FLOOR.has(best.tier)) {
    const fix = addTestId(result);
    out.push(`Recommendation: change the application — no durable locator exists for this element (best is ${best.tierLabel}).`);
    if (fix) {
      out.push(`Add a test attribute (this requires an application change):`, `  ${fix.snippet}`);
    } else {
      out.push(...(result.recommendations ?? []).map((r) => `- ${r}`));
    }
    out.push('', 'Declined as the answer — the most durable locator available today:', locatorBlock(best, 1));
  } else {
    out.push(`Best locator (${result.framework}):`, `  ${best.code || best.value}`);
    out.push(`  Point-in-time — true on this page now: ${pointInTime(best)}`);
    for (const s of best.signals) {
      if (s.points) out.push(`  ${s.direction === 'positive' ? '+' : '-'} ${clause(s.message)}`);
    }
  }

  if (result.rankingNote) out.push('', `Why this order: ${result.rankingNote}`);
  const profile = profileLine(result.profile);
  if (profile) out.push(profile);

  out.push(
    '',
    'Durable — stays true while the locator string is unchanged. Place it beside the locator only if the user wants locator annotations:',
    durableLine(result),
  );

  out.push(...paramBlock(result.params, framework));

  if (alternatives.length) {
    out.push('', 'Alternatives:', ...alternatives.map((l, i) => locatorBlock(l, i + 2)));
  }
  return out.join('\n');
}

const SNAPSHOT_LEGEND =
  'Pass a ref to cor_inspect or an act tool; refs expire on navigation and any act. "a › b": b inside a. ' +
  '✓id: test attribute. +N hidden: invisible elements with the same role and name. [unstable id]: id changed on reload.';

function leafText(leaf, unstableIds) {
  let text = `${leaf.role}${leaf.name ? ` "${leaf.name}"` : ''}${leaf.value ? ` = "${leaf.value}"` : ''} [ref=${leaf.ref}]`;
  if (leaf.testId) text += ' ✓id';
  for (const state of leaf.states) text += ` [${state}]`;
  if (leaf.hidden) text += ` +${leaf.hidden} hidden`;
  if (leaf.id && unstableIds.has(leaf.id)) text += ' [unstable id]';
  if (leaf.hint) text += ` ${leaf.hint}`;
  return text;
}

const containerText = (c) => `${c.type}${c.label ? ` "${c.label}"` : ''}`;

/** Chains of single-child containers fold into one line: `section "Team Ultimate" › button "Choose"`. */
function renderNodes(nodes, depth, unstableIds, out) {
  for (let node of nodes) {
    const prefix = [];
    while (node.kind === 'container' && node.children.length === 1) {
      prefix.push(containerText(node));
      node = node.children[0];
    }
    const own = node.kind === 'leaf' ? leafText(node, unstableIds) : containerText(node);
    out.push(`${'  '.repeat(depth)}- ${[...prefix, own].join(' › ')}`);
    if (node.kind === 'container') renderNodes(node.children, depth + 1, unstableIds, out);
  }
  return out;
}

/**
 * @param {{ url: string, title: string, count: number, tree: object[] }} snapshot
 * @param {{ unstableIds?: Set<string> }} [options]  ids U7's reload check found regenerated
 */
export function renderSnapshot(snapshot, { unstableIds = new Set() } = {}) {
  const head = `${snapshot.title ? `"${snapshot.title}" ` : ''}${snapshot.url} — ${snapshot.count} interactive element${snapshot.count === 1 ? '' : 's'}`;
  return [head, SNAPSHOT_LEGEND, '', ...renderNodes(snapshot.tree, 0, unstableIds, [])].join('\n');
}

const REIDENTIFY = 'Re-identify the element: cor_snapshot, then cor_inspect its ref.';
const DURABILITY_ONLY = 'The score below rates how durable the string is; whether it resolves is the verdict above.';

function gradedBlock(graded, input) {
  const lines = [`Graded: ${input}`, `  Point-in-time — true on this page now: ${pointInTime(graded)}`];
  for (const s of graded.signals) {
    if (s.points) lines.push(`  ${s.direction === 'positive' ? '+' : '-'} ${clause(s.message)}`);
  }
  // The engine judged the id from one DOM; the reload overrules it.
  if (graded.volatileId) lines.push(`  ! Not stable: a fresh load gave this element id ${graded.volatileId.seen} — the score above assumes it was a name`);
  return lines;
}

/**
 * The grade verdict. The first line is the diagnosis, because in repair the
 * question is "is the locator why the test failed?" — and for a healthy
 * locator the answer is no, and the right move is to stop.
 */
export function renderGrade({ input, graded, candidates, note, uncountable }) {
  const out = [];
  const count = graded.matchCount;
  // Every candidate that resolves and scores higher, in the framework's ranked
  // order — not just rank 1, which under Playwright can be a role locator
  // scoring below a test id further down.
  const usable = (candidates?.locators ?? []).filter((l) => l.matchCount === 1 && !l.volatileId);
  const higher = usable.filter((l) => l.score > graded.score);
  const volatile = graded.volatileId && count === 1;
  // A volatile id breaks on the next load whatever it scores, so any durable
  // candidate is better than it.
  const better = (volatile ? usable : higher).find((l) => !SUB_FLOOR.has(l.tier)) ?? null;
  const replace = count === 1 && !uncountable && (volatile || SUB_FLOOR.has(graded.tier));

  if (uncountable) {
    out.push(`Match count unknown — the selector was understood but could not be counted on this page (${uncountable}). The score below reflects durability only.`);
  } else if (count === 0) {
    out.push('Broken — matches no element on this page. A test using it fails here because of the locator.', REIDENTIFY, DURABILITY_ONLY);
  } else if (count > 1) {
    out.push(
      `Ambiguous — matches ${count} elements, so it is not usable as written. Playwright throws a strict-mode error; other frameworks act on the first match, which may not be the intended element.`,
      REIDENTIFY,
      DURABILITY_ONLY,
    );
  } else if (volatile) {
    const { id, seen } = graded.volatileId;
    out.push(
      `Breaks on reload — resolves to exactly one element now, but its id changes on every page load (${id} was ${seen} on a fresh load). A test using it fails on the next load; this is the locator's fault.`,
    );
  } else if (SUB_FLOOR.has(graded.tier)) {
    const risk = graded.primaryRisk ? `: ${clause(graded.primaryRisk.message).toLowerCase()}` : '';
    out.push(
      `Resolves to exactly one element, but fragile (${graded.tierLabel})${risk}. It is not why a test fails today; it is likely to break on a future change.`,
    );
  } else {
    out.push(
      'Healthy — resolves to exactly one element. If a test using it failed, the cause is in the product or the assertion, not this locator. Stop repairing the locator.',
    );
  }

  out.push('', ...gradedBlock(graded, input));
  if (note) out.push(`  (${note})`);

  // An alternative is offered only where replacing is the point: a fragile
  // locator. A healthy one gets none (AE8), even if a higher score exists.
  if (replace) {
    if (better) {
      out.push('', `More durable alternative for the same element (${candidates.framework}):`, locatorBlock(better, 1).replace(/^1\. /, '  '));
    } else {
      const fix = addTestId(candidates ?? { locators: [] }) ?? addTestId({ locators: [graded] });
      out.push('', 'No durable locator exists for this element. Recommendation: change the application.');
      if (fix) out.push(`Add a test attribute (this requires an application change):`, `  ${fix.snippet}`);
    }
  } else if (count === 1 && !uncountable) {
    out.push('', higher.length ? 'Not a repair case: the locator works. A higher-scoring form exists — cor_inspect this element only if the user wants a durability upgrade.' : 'No generated candidate scores higher.');
  }

  out.push(
    '',
    'Durable — stays true while the locator string is unchanged. Place it beside the locator only if the user wants locator annotations:',
    durableLine({ framework: candidates?.framework, locators: [graded] }),
  );
  return out.join('\n');
}

// ── scoped snapshot (U15) ───────────────────────────────────────────────────
const regionText = (r) => `${r.kind}${r.label ? ` "${r.label}"` : ''}`;

/** One region in full: headings, text, images and controls, in page order. */
export function renderScoped(scoped, within, { unstableIds = new Set() } = {}) {
  const head = `${scoped.title ? `"${scoped.title}" ` : ''}${scoped.url} — ${regionText(scoped.region)} in full (within: ${within})`;
  const note = 'All text in this region, in page order. Its refs are added to the current snapshot\'s; refs expire on navigation and any act.';
  const lines = scoped.lines.map((line) => {
    if (line.kind === 'leaf') return `- ${leafText(line, unstableIds)}`;
    return `- ${line.kind} "${line.text}"`;
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

// ── act results (U16 + U17) ─────────────────────────────────────────────────
const leafBrief = (l) => `${l.role}${l.name ? ` "${l.name}"` : ''}${l.value ? ` = "${l.value}"` : ''}${l.ref ? ` [ref=${l.ref}]` : ''}`;

/** What an act changed, and what happened to the refs. */
export function renderActResult(result) {
  if (result.navigated) return 'The page navigated: earlier refs expired — call cor_snapshot.';
  const out = [];
  if (!result.changes?.length) {
    out.push('No visible change. If you expected one, the act may not have landed — check the target, or try cor_press.');
  } else {
    out.push('Changes:');
    for (const c of result.changes) {
      if (c.kind === 'appeared') {
        const leaves = c.leaves.slice(0, 6).map(leafBrief).join(', ');
        const more = c.leaves.length > 6 ? `, …${c.leaves.length - 6} more` : '';
        out.push(c.container ? `+ ${c.container}: ${leaves}${more}` : `+ ${leaves}${more}`);
      } else if (c.kind === 'disappeared') {
        out.push(`- ${c.role}${c.name ? ` "${c.name}"` : ''}`);
      } else {
        const parts = [];
        if (c.was.name !== c.is.name) parts.push(`"${c.was.name}" → "${c.is.name}"`);
        if (c.was.states !== c.is.states) parts.push(c.is.states ? `now ${c.is.states}` : `no longer ${c.was.states}`);
        if (c.was.value !== c.is.value) parts.push(`"${c.was.value ?? ''}" → "${c.is.value ?? ''}"`);
        out.push(`~ ${c.role}${c.name ? ` "${c.name}"` : ''}: ${parts.join('; ')}`);
      }
    }
    if (result.more) out.push(`…and ${result.more} more changes — cor_snapshot for the whole page.`);
  }
  const { kept, rebound, dropped } = result.refs ?? { kept: 0, rebound: [], dropped: {} };
  const stale = Object.entries(dropped);
  const refParts = [`${kept} still valid`];
  if (rebound.length) refParts.push(`${rebound.join(', ')} re-bound to the re-rendered element`);
  if (stale.length) refParts.push(`stale: ${stale.map(([ref, why]) => `${ref} (${why})`).join(', ')}`);
  out.push(`Refs: ${refParts.join('; ')}.`);
  return out.join('\n');
}
