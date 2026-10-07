import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { renderGrade } from '../format.js';
import { parseGradable, substituteParam, NotGradable, SUPPORTED_FORMS } from '../grade-parse.js';
import { FRAMEWORKS, verifyNumberedIds } from './inspect.js';
import { checkIds, numberedIds } from '../id-stability.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });

/** @param {ReturnType<import('../session.js').createSession>} session */
export function gradeTools(session, idCache = new Map()) {
  return [
    {
      name: 'cor_grade',
      config: {
        title: 'Grade an existing selector',
        description:
          'Diagnose a selector that already exists — from a test file, a failing test, or a pull request — against the open page. ' +
          'When a test fails on a locator, call this FIRST, before re-identifying the element. ' +
          'It says whether the locator is broken (matches nothing), ambiguous (matches several), fragile, or healthy. ' +
          'If it reports Healthy, STOP: the locator is not why the test failed — look at the product or the assertion instead of replacing it. ' +
          `Accepts ${SUPPORTED_FORMS}.`,
        inputSchema: {
          selector: z.string().min(1).optional().describe('The selector exactly as written in the test, e.g. page.getByRole(\'button\', { name: \'Save\' }) or cy.get(\'.btn\').'),
          // P3 (run 92a3c7e6): cor_heal takes `locator`, so agents pass it here too — the same thing.
          locator: z.string().min(1).optional().describe('Same as selector.'),
          framework: z.enum(FRAMEWORKS).optional().describe('Framework to render alternatives for. Default: the framework of the project as cor_open reported it, else the form of the selector (getBy* → playwright, cy.* → cypress), else playwright.'),
          param: z.string().optional().describe('For a parameterised helper: the variable in the selector (e.g. title in getByText(title, { exact: true })). COR runs the locator for every value and says which items no value reaches.'),
          values: z.array(z.string()).optional().describe('Values to run the parameterised locator with. Omit to let COR find each item\'s values on the page (needs the chain to start with page.locator(\'css\')).'),
        },
      },
      handler: async ({ selector: given, locator, framework: asked, param, values }) => {
        const selector = given ?? locator;
        if (!selector) throw new Error('Pass the locator to grade as selector.');
        // The argument wins; else the form of the selector (cy.* is Cypress whatever the project is); else the project's framework.
        const project = session.resolveFramework(asked) ?? undefined;
        const framework = asked ?? undefined;
        if (!session.isOpen) throw new Error('No page is open — call cor_open with the page the selector targets first.');
        const page = await session.getPage();
        const testId = session.testIdAttribute;
        const order = session.order;
        if (param) return text(await gradeAcross(page, selector, framework, param, values, idCache, project, testId, order));
        return text(await gradeOne(page, selector, framework, idCache, project, testId, order));
      },
    },
  ];
}

// P1c (V3): what the count on a graded selector rests on. Playwright forms and raw selectors are
// counted by Playwright itself; a Cypress or WebdriverIO form is read by COR and counted with
// Playwright, not run in that framework.
const RUNNERS = { cypress: 'Cypress', webdriverio: 'WebdriverIO' };
const proofFor = (form) => (RUNNERS[form] ? `Proof: emulated — not run in ${RUNNERS[form]}; counted with Playwright.` : 'Proof: counted by Playwright.');

/** The innermost element a containment locator matches (a visible one first): its tag, text and how many. */
const innermostMatch = (locator) =>
  locator
    .evaluateAll((els) => {
      const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inner = els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
      const pick = inner.find(shown) ?? inner[0];
      return pick ? { tag: pick.tagName.toLowerCase(), text: pick.textContent.replace(/\s+/g, ' ').trim(), visible: inner.filter(shown).length } : null;
    })
    .catch(() => null);

/** Grade one literal selector (the original cor_grade). */
async function gradeOne(page, selector, framework, idCache, project, testId = null, order = null) {
  let parsed;
  try {
    parsed = parseGradable(selector, { framework: framework ?? project });
  } catch (error) {
    if (!(error instanceof NotGradable)) throw error;
    throw new Error(
      `Not gradable as written: ${error.message}. Pass ${SUPPORTED_FORMS} — or call cor_snapshot and cor_inspect the element by ref.`,
    );
  }
  const fw = framework ?? parsed.framework ?? project ?? 'playwright';

  let matchCount;
  let uncountable = null;
  let element = null;
  try {
    const locator = parsed.build(page);
    matchCount = await locator.count();
    if (matchCount === 1) element = await locator.elementHandle();
  } catch (error) {
    const reason = error.message.split('\n')[0];
    // A custom selector engine registered in the user's own Playwright
    // config is a real selector we simply cannot run here — unlike a typo.
    if (/Unknown engine/i.test(reason)) {
      matchCount = -1;
      uncountable = `it uses a selector engine registered in your test setup, not built into Playwright — ${reason}`;
    } else {
      throw new Error(`Not gradable as written: the page rejected it (${reason}). Pass ${SUPPORTED_FORMS}.`);
    }
  }

  // A chain breaks when any step does, so it is scored by its weakest
  // step; every step is listed with its own score.
  let scoreValue = parsed.scoreValue;
  let chain = null;
  if (parsed.chain) {
    const scores = await callPage(page, 'scoreSteps', { values: parsed.chain.scored.map((st) => st.scoreValue), framework: fw, element, matchCount });
    const steps = parsed.chain.scored.map((st, i) => ({ ...st, ...scores[i] }));
    const weakest = steps.reduce((a, b) => (b.score < a.score ? b : a));
    scoreValue = weakest.scoreValue;
    chain = { steps, weakest: steps.indexOf(weakest), notes: [...parsed.chain.notes] };
    // U19.2: a visible filter over a CSS step — offer the stable scope if the page has one.
    const base = parsed.chain.scored[0]?.scoreValue;
    if (chain.notes.some((n) => n.includes('visible: true')) && base && !base.startsWith('page.')) {
      const scope = await callPage(page, 'stableScopeFor', { css: base }).catch(() => null);
      if (scope) chain.notes.push(`prefer the scope ${scope} over filter({ visible: true }) — it names which copy, not whichever one is showing: page.locator('${scope} ${base}')`);
    }
  }
  // U22: text matched by containment finds every element that merely holds the words. Say which
  // element it lands on, and the exact form for it.
  const loose = parsed.loose && !uncountable
    ? { ...parsed.loose, count: matchCount, best: matchCount > 0 ? await innermostMatch(parsed.build(page)) : null }
    : null;
  // U4 (D2): a positional step whose chain matched several elements picks whichever comes first, second… — a failure.
  let positional = null;
  for (const p of parsed.positional ?? []) {
    const before = await p.prefix(page).count().catch(() => 0);
    if (before > 1) { positional = { code: p.code, count: before }; break; }
  }
  const { graded, candidates } = await callPage(page, 'grade', { element, value: scoreValue, framework: fw, matchCount, testIdAttribute: testId, order });
  if (chain) Object.assign(graded, { value: selector, code: selector, chain });
  if (matchCount === 1) {
    const ids = numberedIds(parsed.scoreValue);
    const verdicts = await checkIds(page, ids, idCache);
    const regenerated = ids.map((id) => ({ id, ...verdicts.get(id) })).find((v) => v.status === 'regenerated');
    if (regenerated) graded.volatileId = { id: regenerated.id, seen: regenerated.seen };
    if (candidates) await verifyNumberedIds(page, candidates.locators, idCache);
  }
  const out = renderGrade({ input: selector, graded, candidates, note: parsed.note, uncountable, loose, positional, proof: uncountable ? null : proofFor(parsed.framework) });
  const hint = matchCount === 0 ? await testIdHint(page, selector, testId) : null;
  return hint ? `${out}\n${hint}` : out;
}

// U3 (D7): getByTestId finds nothing because the page carries the value on another attribute than the one Playwright reads.
const OTHER_TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];
async function testIdHint(page, selector, testId) {
  const value = /getByTestId\(\s*(['"])(.+?)\1/.exec(selector)?.[2];
  if (!value) return null;
  const reads = testId ?? 'data-testid';
  const found = await page.evaluate(({ attrs, v }) => attrs.find((a) => document.querySelector(`[${a}="${CSS.escape(v)}"]`)) ?? null, { attrs: OTHER_TEST_ATTRS.filter((a) => a !== reads), v: value }).catch(() => null);
  return found ? `getByTestId reads ${reads}; this page carries "${value}" on ${found}. Set testIdAttribute: '${found}' in playwright.config, or use page.locator('[${found}="${value}"]').` : null;
}

/**
 * U19.3. Run a parameterised locator for every value — given, or found on the
 * page per item of its first CSS step — then grade durability on a value that
 * works. The agent writes the helper; COR proves it.
 */
async function gradeAcross(page, selector, framework, param, given, idCache, project, testId = null, order = null) {
  let parsed;
  try {
    parsed = parseGradable(selector, { param });
  } catch (error) {
    if (!(error instanceof NotGradable)) throw error;
    throw new Error(`Not gradable as written: ${error.message}. Pass ${SUPPORTED_FORMS} — or call cor_snapshot and cor_inspect the element by ref.`);
  }
  if (!parsed.usesParam) throw new Error(`The selector does not use the parameter "${param}" — write it as the helper does, e.g. getByText(${param}, { exact: true }).`);
  const countOf = async (v) => {
    try {
      const loc = parsed.build(page, v);
      const n = await loc.count();
      return { n, el: n === 1 ? await loc.elementHandle() : null };
    } catch {
      return { n: -1, el: null };
    }
  };
  const lines = [];
  let working = null;
  if (given?.length) {
    lines.push(`Across the given values (${param}):`);
    let ok = 0;
    for (const v of given) {
      const { n } = await countOf(v);
      if (n === 1) { ok += 1; working ??= v; }
      lines.push(`  "${v}": ${n === 1 ? '✓ 1 match' : `✗ ${n < 0 ? 'could not be counted' : `${n} matches`}`}`);
    }
    lines.push(`Works for ${ok} of ${given.length} values.`);
  } else {
    if (!parsed.baseCss) throw new Error(`To find the values on the page the chain must start with page.locator('css'); otherwise pass values.`);
    const perItem = await callPage(page, 'itemCandidates', { css: parsed.baseCss });
    if (!perItem?.length) throw new Error(`No visible element matches ${parsed.baseCss}.`);
    lines.push(`Across every item (${param}, ${perItem.length} visible items of ${parsed.baseCss}):`);
    let ok = 0;
    for (const [i, cands] of perItem.entries()) {
      let found = null;
      for (const v of cands) {
        const { n, el } = await countOf(v);
        if (n === 1 && (await callPage(page, 'itemIndexOf', { css: parsed.baseCss, element: el })) === i) { found = v; break; }
      }
      const label = cands[0] ? `"${cands[0]}"` : '(no text)';
      if (found) { ok += 1; working ??= found; }
      lines.push(found
        ? `  item ${i + 1} ${label}: ✓ 1 match with ${param} = "${found}"`
        : `  item ${i + 1} ${label}: ✗ no value finds it — none of its texts makes the chain find exactly one element inside it`);
    }
    lines.push(`Works for ${ok} of ${perItem.length} items.`);
  }
  if (!working) return [...lines, '', 'No value works, so there is no durability grade.'].join('\n');
  const graded = await gradeOne(page, substituteParam(selector, param, working), framework, idCache, project, testId, order);
  return [...lines, '', `Durability, graded on ${param} = "${working}":`, graded].join('\n');
}
