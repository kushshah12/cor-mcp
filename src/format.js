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
  const anchor = best.volatileId && /\bid\b/i.test(anchorOf(best) ?? '') ? 'Anchored on an element id' : anchorOf(best);
  if (anchor) {
    // Signal messages read "Anchored on X" / "Targets the element by X" — or are
    // a clause of their own ("Scoped under a stable ancestor anchor").
    const m = /^(Anchored on|Targets the element by) (.*)$/i.exec(anchor);
    parts.push(m ? `anchored on ${m[2]}` : anchor.charAt(0).toLowerCase() + anchor.slice(1));
  }
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
const ALTERNATIVES_SHOWN = 3;

/** The kind of locator, for picking alternatives a codebase's conventions could prefer. */
function kindOf(l) {
  const s = String(l.strategy ?? '');
  if (/^role/i.test(s)) return 'role';
  if (/text/i.test(s)) return 'text';
  if (/label/i.test(s)) return 'label';
  if (/placeholder/i.test(s)) return 'placeholder';
  if (/test.?id/i.test(s)) return 'testid';
  if (/xpath/i.test(s)) return 'xpath';
  return 'css';
}

/**
 * The runner-up, then the best of each other kind (role, text, label, test
 * id, CSS, XPath) — so a codebase built on getByRole page objects still sees
 * its form — at most three. Position-only (Unstable) locators are never
 * worth choosing. The rest are one `all: true` away.
 */
function pickAlternatives(best, alternatives) {
  const usable = alternatives.filter((l) => l.tier !== 'unstable');
  if (!usable.length) return [];
  const [runnerUp, ...rest] = usable;
  const picked = [runnerUp];
  const kinds = new Set([kindOf(best), kindOf(runnerUp)]);
  for (const l of rest) {
    if (picked.length >= ALTERNATIVES_SHOWN) break;
    if (kinds.has(kindOf(l))) continue;
    kinds.add(kindOf(l));
    picked.push(l);
  }
  return picked;
}

/**
 * U18. When the element is one of several items and a template was checked
 * against every one, the template IS the answer: it leads the response. An
 * agent run on bstackdemo (2026-09-25) had to read past "change the
 * application", five weak single-item locators and a 25-line lookalike list
 * to reach it.
 */
function cellLead(p, framework) {
  const also = (list, v) => {
    const others = list.filter((x) => x !== v);
    const more = others.length > VALUES_SHOWN ? `, … ${others.length - VALUES_SHOWN} more` : '';
    return `(also: ${others.slice(0, VALUES_SHOWN).map((x) => `"${x}"`).join(', ')}${more})`;
  };
  const [rp, cp] = p.vars;
  return [
    `Recommended — parameterised by row and column: ${p.rows.length} rows × ${p.columns.length} columns; every row and column checked (${p.counted}/${p.counted}).`,
    `  ${rp} = "${p.row}"   ${also(p.rows, p.row)}`,
    `  ${cp} = "${p.column}"   ${also(p.columns, p.column)}`,
    framework === 'playwright' ? `  ${p.code}` : `  XPath: ${p.template.xpath.selectorTemplate}`,
    `  Registry template (xpath-literal): ${p.template.xpath.selectorTemplate}   (__${rp}__ / __${cp}__ are quoted XPath literals)`,
    `  When the test reads more than one cell, write one function taking ${rp} and ${cp}.`,
    '',
  ];
}

function paramLead(params, framework, lookalikes) {
  if (params.kind === 'cell') return cellLead(params, framework);
  const others = params.values.filter((v) => v !== params.value);
  const more = others.length > VALUES_SHOWN ? `, … ${others.length - VALUES_SHOWN} more` : '';
  const form = framework === 'playwright'
    ? [
      ...(params.act
        ? [`  change it: ${params.act}.click()   — the inputs are hidden; their labels are what a user clicks`,
          `  check it:  ${params.code}`]
        : [`  ${params.code}`]),
      `  Registry template (${params.template.playwright.syntax}): ${params.template.playwright.selectorTemplate}`,
    ]
    : [`  XPath: ${params.template.xpath.selectorTemplate}   (__${params.param}__ is the quoted XPath literal)`];
  const noun = params.kind === 'group' ? 'option' : 'item';
  const out = [
    params.kind === 'group'
      ? `Recommended — parameterised: ${params.count} options in this ${params.what}; every value checked, each finds exactly its own option (${params.count}/${params.count}).`
      : `Recommended — parameterised: ${params.count} items share this shape; every value checked, each finds exactly its own item (${params.count}/${params.count}).`,
    `  ${params.param} = "${params.value}"   (also: ${others.slice(0, VALUES_SHOWN).map((v) => `"${v}"`).join(', ')}${more})`,
    ...form,
    `  When the test touches more than one ${noun}, write one function taking ${params.param} instead of a locator per ${noun}.`,
  ];
  // Every lookalike is one of the items, so picking "the wrong one" is just a different value.
  if (lookalikes) out.push(`  The ${lookalikes.items.length - 1} lookalike ${lookalikes.role}${lookalikes.name ? ` "${lookalikes.name}"` : ''} elements are the other items — pass their ${params.param} instead.`);
  return [...out, ''];
}

/** Why there is no template, or none for this framework. */
function paramNote(params, framework) {
  if (!params) return [];
  if (!params.template && params.kind === 'cell') return ['', `Not parameterised by row and column — ${params.reason}.`];
  if (!params.template) {
    const what = params.kind === 'group' ? `${params.count} options in this ${params.what}` : `${params.count} items share this shape`;
    return ['', `Not parameterised — ${what}, but ${params.reason}.`];
  }
  if (framework !== 'playwright' && !params.template.xpath) {
    return ['', params.kind === 'group'
      ? `Not parameterised for ${framework} yet — the ${params.what} template is written for Playwright only.`
      : `Not parameterised for ${framework} — the element has no text or attribute an XPath can match exactly.`];
  }
  return [];
}

/**
 * The element belongs to a UI state and may be removed when it changes; a
 * twin shows the same value without one (bstackdemo's cart badge, removed
 * when the cart opens, and the float cart's badge, present in both states).
 */
function stateBoundNote(bound) {
  if (!bound) return [];
  const t = bound.twin;
  return [
    '',
    `State-bound: this element carries the state class "${bound.stateClass}" (on it or a close ancestor), so it may be removed or replaced when the UI state changes — its locator then matches nothing.`,
    `  The same value is also shown by an element with no state class: ${t.code}   (${t.score} ${t.tierLabel} · ${t.matchCount} match${t.matchCount === 1 ? '' : 'es'})`,
    '  For an assertion that runs in more than one state, prefer that one.',
  ];
}

const cssCode = (framework, css) => {
  const q = `'${css.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (framework === 'playwright') return `page.locator(${q})`;
  if (framework === 'cypress') return `cy.get(${q})`;
  return `CSS ${css}`;
};

/**
 * The top pick is unique only because an act removed its other match (the
 * header cart badge, gone while the cart is open). When that element is back,
 * the locator matches two.
 */
function stateOnlyNote(stateOnly, framework) {
  if (!stateOnly) return [];
  const out = [
    '',
    `⚠ Unique only in this state: it also matches ${stateOnly.what}, which an act on this page removed — when that element is back, this locator matches more than one.`,
  ];
  out.push(stateOnly.safer
    ? `  Unique in both states: ${cssCode(framework, stateOnly.safer)}`
    : '  No ancestor tells the two apart; scope it by the region the element belongs to, or add a test attribute.');
  return out;
}

/**
 * The target is a hidden checkbox/radio operated through its label. Playwright
 * refuses to .check() or .click() a hidden input (the Playwright MCP agent's
 * first run failed on it), so the act goes to the label and the assertion to
 * the input, which getByLabel still reaches.
 */
function viaLabelNote(labelText, framework) {
  if (!labelText) return [];
  const q = `'${labelText.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return framework === 'playwright'
    ? ['', `Hidden input, operated through its visible label "${labelText}":`,
      `  change it: page.getByText(${q}, { exact: true }).click()   — .check() on the input fails: it is not visible`,
      `  check it:  await expect(page.getByLabel(${q}, { exact: true })).toBeChecked()`]
    : ['', `Hidden input, operated through its visible label "${labelText}": click the label to change it; read the state from the input.`];
}

/** A template usable in this framework, or null. */
const usableTemplate = (params, framework) =>
  (params?.template && (framework === 'playwright' || params.template.xpath) ? params : null);

export function renderInspect(result, { refsLive = false, framework = result.framework, all = false } = {}) {
  const lead = usableTemplate(result.params, framework);
  // The template covers the lookalikes only when they are all its items.
  const covered = lead && result.lookalikes && result.lookalikes.items.length === lead.count;
  const out = lead ? paramLead(lead, framework, covered ? result.lookalikes : null) : [];
  if (result.lookalikes && !covered) out.push(...lookalikeWarning(result.lookalikes, refsLive));
  const [best, ...alternatives] = result.locators;

  if (!best) {
    out.push('No locator could be generated for this element. What would make it locatable:');
    out.push(...(result.recommendations ?? []).map((r) => `- ${r}`));
    return out.join('\n');
  }

  if (SUB_FLOOR.has(best.tier)) {
    const fix = addTestId(result);
    if (lead) {
      out.push(`For this one item alone there is no durable locator (best is ${best.tierLabel})${fix ? ` — a test attribute would fix that: ${fix.snippet}` : ''}.`);
      out.push('Declined as the answer — the most durable single-item locator today:', locatorBlock(best, 1));
    } else {
      out.push(`Recommendation: change the application — no durable locator exists for this element (best is ${best.tierLabel}).`);
      if (fix) {
        out.push(`Add a test attribute (this requires an application change):`, `  ${fix.snippet}`);
      } else {
        out.push(...(result.recommendations ?? []).map((r) => `- ${r}`));
      }
      out.push('', 'Declined as the answer — the most durable locator available today:', locatorBlock(best, 1));
    }
  } else {
    out.push(`${lead ? 'For this one item alone' : 'Best locator'} (${result.framework}):`, `  ${best.code || best.value}`);
    out.push(`  Point-in-time — true on this page now: ${pointInTime(best)}`);
    for (const s of best.signals) {
      if (s.points) out.push(`  ${s.direction === 'positive' ? '+' : '-'} ${clause(s.message)}`);
    }
  }

  out.push(...stateOnlyNote(result.stateOnly, framework));
  out.push(...viaLabelNote(result.viaLabel, framework));

  if (result.rankingNote) out.push('', `Why this order: ${result.rankingNote}`);
  const profile = profileLine(result.profile);
  if (profile) out.push(profile);

  out.push(
    '',
    'Durable — stays true while the locator string is unchanged. Place it beside the locator only if the user wants locator annotations:',
    durableLine(result),
  );

  if (!lead) out.push(...paramNote(result.params, framework));
  out.push(...stateBoundNote(result.stateBound));

  const shown = all ? alternatives : pickAlternatives(best, alternatives);
  const omitted = alternatives.length - shown.length;
  if (shown.length) {
    out.push('', 'Alternatives:', ...shown.map((l) => locatorBlock(l, result.locators.indexOf(l) + 1)));
  }
  if (omitted) out.push(`${shown.length ? '' : '\n'}(${omitted} more alternative${omitted === 1 ? '' : 's'} not shown — cor_inspect with all: true lists every one.)`);
  return out.join('\n');
}

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
function renderNodes(nodes, depth, unstableIds, out, stats = { groups: 0 }) {
  const items = itemsOf(nodes);
  for (let i = 0; i < items.length;) {
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
  const stats = { groups: 0 };
  const lines = renderNodes(snapshot.tree, 0, unstableIds, [], stats);
  const viaLabel = (nodes) => nodes.some((n) => (n.kind === 'leaf' ? n.viaLabel : viaLabel(n.children)));
  const legend = [SNAPSHOT_LEGEND, stats.groups && GROUP_LEGEND, viaLabel(snapshot.tree) && VIA_LABEL_LEGEND].filter(Boolean).join(' ');
  return [head, legend, '', ...lines].join('\n');
}

const REIDENTIFY = 'Re-identify the element: cor_snapshot, then cor_inspect its ref.';
const DURABILITY_ONLY = 'The score below rates how durable the string is; whether it resolves is the verdict above.';

function gradedBlock(graded, input) {
  const lines = [`Graded: ${input}`, `  Point-in-time — true on this page now: ${pointInTime(graded)}`];
  for (const s of graded.signals) {
    if (s.points) lines.push(`  ${s.direction === 'positive' ? '+' : '-'} ${clause(s.message)}`);
  }
  if (graded.chain) {
    lines.push('  Chain — scored by its weakest step, since it breaks when any step does:');
    graded.chain.steps.forEach((st, i) => {
      lines.push(`    ${i + 1}. ${st.code}   ${st.score} ${st.tierLabel ?? st.tier}${st.risk ? ` — ${clause(st.risk).toLowerCase()}` : ''}${i === graded.chain.weakest ? '   ← weakest' : ''}`);
    });
    for (const n of graded.chain.notes) lines.push(`    ! ${n}`);
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
