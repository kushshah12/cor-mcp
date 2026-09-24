// Renders page-side results as text for the agent. Leads with the verdict so
// a reader that truncates still gets the answer.

/** Tiers below this are declined as the answer: the fix is in the application. */
const SUB_FLOOR = new Set(['risky', 'unstable']);

const clause = (message) => String(message ?? '').split(' — ')[0];

function pointInTime(l) {
  const count = l.matchCount === null || l.matchCount === undefined ? 'match count unknown'
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
  const anchor = anchorOf(best);
  if (anchor) parts.push(`anchored on ${anchor.replace(/^(Anchored on|Targets the element by) /i, '')}`);
  const risk = best.primaryRisk;
  parts.push(risk ? `risk: ${clause(risk.message).toLowerCase()}` : 'no known risk');
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

export function renderInspect(result) {
  const out = [];
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

  if (alternatives.length) {
    out.push('', 'Alternatives:', ...alternatives.map((l, i) => locatorBlock(l, i + 2)));
  }
  return out.join('\n');
}

export function renderSnapshot(snapshot) {
  const head = `${snapshot.title ? `"${snapshot.title}" ` : ''}${snapshot.url} — ${snapshot.count} interactive element${snapshot.count === 1 ? '' : 's'}`;
  const legend = '✓id = carries a test attribute. Pass a ref to cor_inspect (or to an act tool as `ref`). Refs expire on navigation and after any act call.';
  return [head, legend, '', ...snapshot.lines].join('\n');
}
