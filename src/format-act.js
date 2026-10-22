// Refactor (review): what an act changed (cor_click / cor_fill / cor_press), split from format.js.
// ── act results (U16 + U17) ─────────────────────────────────────────────────
const leafBrief = (l) => `${l.role}${l.name ? ` "${l.name}"` : ''}${l.value ? ` = "${l.value}"` : ''}${l.ref ? ` [ref=${l.ref}]` : ''}`;

/** What an act changed, and what happened to the refs. */
export function renderActResult(result, { quietIfUnchanged = false } = {}) {
  if (result.navigated) {
    const shown = result.headings ?? [];
    if (!shown.length) return 'The page navigated. Earlier refs expired — call cor_snapshot.';
    const lines = shown.map((h) => `  ${h.level} "${h.text}" [ref=${h.ref}]`);
    return ['The page navigated. Headings on the new page (cor_inspect one for the exact locator of text you assert on; cor_snapshot for its controls):', ...lines].join('\n');
  }
  const out = [];
  if (!result.changes?.length && !result.texts?.length && !result.shownGroups?.length) {
    // U11 (D5): a fill that changes nothing visible is the normal case — said only for clicks and key presses.
    if (!quietIfUnchanged) out.push('No visible change. If you expected one, the act may not have landed — check the target, or try cor_press.');
  } else if (result.changes?.length) {
    out.push('Changes:');
    for (const c of result.changes) {
      if (c.kind === 'appeared') {
        const leaves = c.leaves.slice(0, 6).map(leafBrief).join(', ');
        const more = c.leaves.length > 6 ? `, …${c.leaves.length - 6} more` : '';
        out.push(c.container ? `+ ${c.container}: ${leaves}${more}` : `+ ${leaves}${more}`);
      } else if (c.kind === 'disappeared') {
        out.push(`- ${c.role}${c.name ? ` "${c.name}"` : ''}`);
      } else if (c.kind === 'gone') {
        const shown = c.controls.slice(0, 6).map((g) => `${g.role}${g.name ? ` "${g.name}"` : ''}${g.count > 1 ? ` ×${g.count}` : ''}`);
        out.push(`- gone (${c.total}): ${shown.join(', ')}${c.controls.length > 6 ? `, …${c.controls.length - 6} more kinds` : ''}`);
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
  if (result.texts?.length || result.shownGroups?.length) {
    out.push('Text:');
    for (const t of result.texts) {
      const where = t.where ? ` in ${t.where}` : '';
      out.push(t.was === null ? `+ "${t.text}" [ref=${t.ref}]${where}` : `~ "${t.was}" → "${t.text}" [ref=${t.ref}]${where}`);
    }
    for (const g of result.shownGroups ?? []) {
      const eg = g.examples.map((e) => `"${e.text}" [ref=${e.ref}]`).join(', ');
      if (g.count === 1) out.push(`+ ${eg}${g.where ? ` in ${g.where}` : ''}`);
      else {
        out.push(g.where
          ? `+ ${g.count} new lines in ${g.where}, e.g. ${eg} — cor_snapshot within: "${g.label}" for all`
          : `+ ${g.count} new lines, e.g. ${eg}`);
      }
    }
    if (result.moreTexts) out.push(`…and ${result.moreTexts} more text changes — cor_snapshot within a region for all its text.`);
  }
  const { kept, rebound, dropped } = result.refs ?? { kept: 0, rebound: [], dropped: {} };
  const stale = Object.entries(dropped);
  const refParts = [`${kept} still valid`];
  if (rebound.length) refParts.push(`${rebound.join(', ')} re-bound to the re-rendered element`);
  if (stale.length) {
    // U21: grouped by reason — BrowserStack's For Individuals click listed ~65
    // refs, each with the same reason (about 3k characters).
    const byWhy = new Map();
    for (const [ref, why] of stale) byWhy.set(why, [...(byWhy.get(why) ?? []), ref]);
    const groups = [...byWhy].map(([why, refs]) => (refs.length > 3
      ? `${refs.slice(0, 3).join(', ')}, … ${refs.length} refs (${why})`
      : refs.map((r) => `${r} (${why})`).join(', ')));
    refParts.push(`stale: ${groups.join('; ')}`);
  }
  out.push(`Refs: ${refParts.join('; ')}.`);
  return out.join('\n');
}
