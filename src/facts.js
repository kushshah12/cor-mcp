// P1b: the `Facts:` block of a cor_inspect reply — one line of page knowledge per check COR ran,
// with the count behind it, the same in every framework (spec §7.1). No fact is written without
// a check behind it (F1); no API names (F4); the one framework-dependent line reads the engine's
// failure mode (F5).

const MAX_FACTS = 5;
const MAX_LEN = 140;

// What happens when a locator matches several elements, by the engine's `resolution.failureMode`.
const AMBIGUITY = {
  'strict-mode-error': 'the test fails at once',
  'silently-picks-first': 'the run acts on the first match and does not fail',
  'command-dependent': 'an action fails, an assertion runs on all of them',
};

/** What the framework does when a locator matches several elements, from the engine's failure mode; null when unknown. */
export const ambiguityConsequence = (failureMode) => AMBIGUITY[failureMode] ?? null;

const clip = (s) => (s.length <= MAX_LEN ? s : `${s.slice(0, MAX_LEN - 1)}…`);
const many = (n, one, other) => (n === 1 ? one : other);

/** Facts in severity order: hidden copies, collapsed content, variants, label-operated inputs, then the rest. */
export function factsFor(result) {
  const { params, viaLabel, lookalikes, stateOnly, collapsed, shadow, locators = [] } = result;
  const [best] = locators;
  const facts = [];

  if (params?.hidden) {
    const { count, scope } = params.hidden;
    facts.push({ type: 'hidden-copies', text: `hidden copies: ${count} ${many(count, 'copy', 'copies')} of these items in the page, not shown — ${scope ? `scope by ${scope}` : 'match the displayed ones only'}` });
  }
  if (shadow) {
    facts.push({ type: 'shadow-dom', text: `inside ${many(shadow.depth, 'a shadow root', `${shadow.depth} nested shadow roots`)} (host ${shadow.host}) — Playwright and WebdriverIO see in; Cypress needs its shadow setting on` });
  }
  if (collapsed) {
    facts.push({ type: 'collapsed-content', text: 'this text is clipped by a collapsed wrapper until opened — "displayed" is true while collapsed; assert its text or height' });
  }
  for (const v of params?.variants ?? []) {
    const shown = v.values.slice(0, 2).map((x) => `"${x}"`).join(', ');
    facts.push({ type: 'variant-behind-toggle', text: `${shown}${v.values.length > 2 ? ` and ${v.values.length - 2} more` : ''} ${many(v.values.length, 'is', 'are')} shown by the "${v.of}" item's toggle — click the toggle first` });
    break;
  }
  if (params?.act || params?.actReason || viaLabel) {
    facts.push({ type: 'label-operated-input', text: 'hidden inputs, operated by their labels — click the label, assert the input\'s state, not that it exists' });
  }
  if (params?.separateHeader) {
    facts.push({ type: 'separate-header-table', text: 'column headers are in a separate table above the rows' });
  }
  const changing = best?.signals?.find((s) => s.id === 'changing-value');
  if (changing) {
    facts.push({ type: 'changing-value', text: 'the locator\'s text holds a value that changes (a price or percentage) — use the stable part of the name' });
  }
  const loose = locators.find((l) => l.matchCount > 1 && AMBIGUITY[l.resolution?.failureMode]);
  if (loose) {
    facts.push({ type: 'ambiguity-consequence', text: `a locator matching ${loose.matchCount} elements: ${AMBIGUITY[loose.resolution.failureMode]}` });
  }
  if (stateOnly) {
    facts.push({ type: 'state-only-unique', text: `unique only in this state (${stateOnly.what} was removed by the last act)` });
  }
  if (lookalikes) {
    const others = lookalikes.items.length - 1;
    facts.push({ type: 'lookalikes', text: `${others} other visible ${lookalikes.role}${lookalikes.name ? ` "${lookalikes.name}"` : ''}${many(others, ' looks', 's look')} the same` });
  }
  return facts.slice(0, MAX_FACTS).map((f) => ({ ...f, text: clip(f.text) }));
}

/** The lines cor_inspect prints, or none. */
export function factsLines(result) {
  const facts = factsFor(result);
  return facts.length ? ['Facts:', ...facts.map((f) => `  • ${f.text}`)] : [];
}
