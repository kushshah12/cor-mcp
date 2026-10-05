import { frameHint } from '../frames.js';
import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { renderAmbiguousScope, renderInspect, renderScoped, renderSnapshot } from '../format.js';
import { REF, checkRef, goneError } from './refs.js';
import { applyIdVerdicts, checkIds, numberedIds } from '../id-stability.js';
import { parseGradable } from '../grade-parse.js';
import { entryFor } from '../entries.js';

export const FRAMEWORKS = ['playwright', 'cypress', 'selenium', 'webdriverio', 'nightwatch', 'testcafe', 'puppeteer'];

const text = (value) => ({ content: [{ type: 'text', text: value }] });
// With no record store (a library caller, tests), an entry still gets an id; nothing is written.
const newId = () => Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');

/**
 * Ids ending in a number are checked against a fresh load before they are
 * recommended (see id-stability.js); volatile ones are flagged and ranked last.
 */
export async function verifyNumberedIds(page, locators, cache) {
  const ids = [...new Set(locators.flatMap((l) => numberedIds(l.value)))];
  if (!ids.length) return;
  applyIdVerdicts(locators, await checkIds(page, ids, cache));
}

// Matches @corlabs/client's interpolateTemplate for syntax 'css-string'.
const cssStringValue = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const PLACEHOLDER = /__\w+__/g;
// ponytail: a list longer than this is counted on its first 100 values; the
// in-page check has already covered every one.
const COUNT_MAX = 100;

/**
 * U18. The page proposed a template after checking every value against the
 * DOM; here Playwright itself counts it with each value filled in, so the
 * string the agent gets is known to resolve, not assumed to.
 */
const xpathLiteralOf = (v) => (!v.includes("'") ? `'${v}'` : !v.includes('"') ? `"${v}"` : `concat(${v.split("'").map((p) => `'${p}'`).join(`, "'", `)})`);

/** Playwright's count of `code` with `param` set to each value, or null when the code is not a form cor_grade reads. */
async function countCode(page, code, param, values) {
  let parsed;
  try {
    parsed = parseGradable(code, { param });
  } catch {
    return null;
  }
  if (!parsed.usesParam) return null;
  return Promise.all(values.map((v) => parsed.build(page, v).count().catch(() => -1)));
}

export async function verifyTemplate(page, params) {
  if (!params?.template) return;
  if (params.kind === 'cell') {
    // The target's row with every column, and its column with every row.
    const [rv, cv] = params.vars;
    const combos = [...params.columns.map((c) => [params.row, c]), ...params.rows.map((r) => [r, params.column])];
    const fill = (r, c) => params.template.playwright.selectorTemplate.replace(`__${rv}__`, () => xpathLiteralOf(r)).replace(`__${cv}__`, () => xpathLiteralOf(c));
    const counts = await Promise.all(combos.map(([r, c]) => page.locator(fill(r, c)).count().catch(() => -1)));
    const bad = counts.findIndex((n) => n !== 1);
    if (bad !== -1) {
      params.reason = `the template matched ${counts[bad] < 0 ? 'nothing parseable' : counts[bad]} for ${combos[bad].join(' / ')} when Playwright counted it`;
      delete params.template;
      return;
    }
    params.counted = combos.length;
    // P1c: WebdriverIO and Cypress hand the XPath to the browser as it is, so it is also counted with the browser's own XPath engine.
    const browser = await callPage(page, 'countXpaths', { xpaths: combos.map(([r, c]) => params.template.xpath.selectorTemplate.replace(`__${rv}__`, () => xpathLiteralOf(r)).replace(`__${cv}__`, () => xpathLiteralOf(c))) });
    if (browser.some((n) => n !== 1)) params.template.xpath = null;
    return;
  }
  // A variant (Team Pro) must find its item too.
  const values = [...params.values, ...(params.variants ?? []).flatMap((v) => v.values)].slice(0, COUNT_MAX);
  const pw = params.template.playwright.selectorTemplate;
  const counts = await Promise.all(values.map((v) =>
    page.locator(pw.replace(PLACEHOLDER, () => cssStringValue(v))).count().catch(() => -1)));
  const bad = counts.findIndex((c) => c !== 1);
  if (bad !== -1) {
    params.reason = `the template matched ${counts[bad] < 0 ? 'nothing parseable' : counts[bad]} for "${values[bad]}" when Playwright counted it`;
    delete params.template;
    return;
  }
  params.counted = values.length;
  // U21: the code the agent copies, counted too — it is written differently
  // from the registry form (roles, .or()), so it is proven on its own.
  const codeCounts = await countCode(page, params.code, params.param, values);
  if (codeCounts) {
    const miss = codeCounts.findIndex((c) => c !== 1);
    if (miss !== -1) {
      params.reason = `the code form matched ${codeCounts[miss]} for "${values[miss]}" when Playwright counted it`;
      delete params.template;
      return;
    }
    params.codeCounted = values.length;
  }
  // A click that does not single out each option is not offered. There is no
  // wider fallback: a page-wide getByText matches at least what a scoped one does.
  if (params.act) {
    const acts = await countCode(page, params.act, params.param, params.values);
    const miss = acts ? acts.findIndex((c) => c !== 1) : -1;
    if (miss !== -1) {
      params.actReason = `the label text "${params.values[miss]}" matched ${acts[miss]} elements for the click`;
      delete params.act;
    }
  }
  // Equivalent mutant, kept on purpose: variantsOf already requires each
  // variant name to find only its own item, and no page shape tried breaks
  // this count. It stays as the proof step for an action copied verbatim.
  if (params.variantAct) {
    const shown = (params.variants ?? []).flatMap((v) => [v.of, ...v.values]);
    const acts = await countCode(page, params.variantAct, params.param, shown);
    if (!acts || acts.some((c) => c !== 1)) delete params.variantAct;
  }
  if (params.template.xpath) {
    // P1c (L1-standard): the browser's XPath engine must find, for every value, exactly the element Playwright's template found — not just one element.
    const template = params.template.xpath.selectorTemplate;
    const same = await Promise.all(values.map(async (v) => {
      const element = await page.locator(pw.replace(PLACEHOLDER, () => cssStringValue(v))).elementHandle().catch(() => null);
      if (!element) return false;
      return callPage(page, 'xpathFindsOnly', { element, template, value: v }).finally(() => element.dispose());
    }));
    if (same.some((ok) => !ok)) params.template.xpath = null;
  }
}

/** @param {ReturnType<import('../session.js').createSession>} session */
export function inspectTools(session, idCache = new Map(), fingerprints = null, records = null) {
  const openPage = () => {
    if (!session.isOpen) throw new Error('No page is open — call cor_open with a URL first.');
    return session.getPage();
  };

  let dataCyNoted = false;

  return [
    {
      name: 'cor_snapshot',
      config: {
        title: 'List interactive elements',
        description:
          'Outline of the visible interactive elements on the current page, each with a ref (e1, e2…), nested only under what identifies it: ' +
          'landmarks, sections by heading, tables (column / row), list items. Pick the element you need, then pass its ref to cor_inspect. ' +
          'Markers: ✓id test attribute, +N hidden lookalikes, [disabled]/[checked]/[expanded]/[selected], [unstable id]; ' +
          '"clickable" is an element with no role that the page makes clickable (cursor: pointer). ' +
          'Take a new snapshot after any navigation or act call — earlier refs expire.',
        inputSchema: {
          within: z.string().optional().describe(
            'Show one region in full instead — every line of text, prices and labels included. ' +
            'A ref (its region: the card, row, column or section that identifies it) or a region\'s name ' +
            '(a heading, a landmark label, a list item or table row\'s text). A name matching several regions returns the choices.',
          ),
        },
      },
      handler: async ({ within }) => {
        const page = await openPage();
        // U14: mark ids U7's reload check already found regenerated — cached
        // verdicts only; a snapshot never triggers a reload.
        const unstableIds = new Set(
          [...idCache].filter(([key, v]) => v.status === 'regenerated' && key.startsWith(`${page.url()}#`)).map(([key]) => key.slice(page.url().length + 1)),
        );
        if (!within) {
          const snapshot = await callPage(page, 'snapshot');
          session.issueRefs(snapshot.live);
          return text(renderSnapshot(snapshot, { unstableIds }));
        }

        // U15. Current refs are kept, so the default snapshot's still resolve.
        const byRef = REF.test(within.trim());
        if (byRef) checkRef(session, within.trim());
        const keep = Boolean(session.refs && !session.refs.staleBecause);
        const scoped = await callPage(page, 'scoped', byRef ? { ref: within.trim(), keep } : { text: within, keep });
        session.issueRefs(scoped.live);
        if (scoped.error === 'gone') throw goneError(within.trim());
        if (scoped.error === 'no-region') {
          throw new Error(
            scoped.reason === 'element'
              ? `${within} is not inside any section, table, list or landmark — cor_snapshot without within shows it in the page outline.`
              : `No region is named "${within}". Headings on this page: ${scoped.headings.map((h) => `"${h}"`).join(', ') || 'none'}. ` +
                'Or pass a ref from inside the region you want.',
          );
        }
        if (scoped.error === 'ambiguous') return text(renderAmbiguousScope(scoped, within));
        return text(renderScoped(scoped, within, { unstableIds }));
      },
    },
    {
      name: 'cor_inspect',
      config: {
        title: 'Get ranked locators for an element',
        description:
          'Rank, score and match-count locators for one element, rendered for the chosen test framework. ' +
          'Pass a ref from cor_snapshot, or a CSS selector that matches exactly one element. ' +
          'The response leads with the recommendation; below the quality floor it recommends an application change ' +
          '(a test attribute) instead of a fragile locator. Use the locator as given; write the surrounding test code yourself.',
        inputSchema: {
          ref: z.string().optional().describe('Element ref from the latest cor_snapshot, e.g. "e4".'),
          selector: z.string().optional().describe('CSS or Playwright selector (:text-is, >>, text=) matching exactly one element — alternative to ref.'),
          framework: z.enum(FRAMEWORKS).optional().describe('Test framework to render and rank for. Default: the project\'s framework as cor_open reported it, else playwright.'),
          all: z.boolean().optional().describe('List every alternative. By default: the runner-up and the best of each other locator kind, up to 3.'),
        },
      },
      handler: async ({ ref, selector, framework: asked, all = false }) => {
        const framework = session.resolveFramework(asked) ?? 'playwright';
        if (Boolean(ref) === Boolean(selector)) throw new Error('Pass exactly one of ref (from cor_snapshot) or selector.');
        const page = await openPage();
        if (ref) checkRef(session, ref);
        let result = await callPage(page, 'inspect', { ref, selector, framework, max: 6, testIdAttribute: session.testIdAttribute, order: session.order });
        if (result.error === 'unknown-ref' || result.error === 'detached') throw goneError(ref);
        if (result.error === 'invalid-selector') {
          // U21: not CSS — a Playwright selector (:text-is, >>, text=)? Playwright resolves it.
          const matches = page.locator(selector);
          const count = await matches.count().catch(() => null);
          if (count === null) throw new Error(`"${selector}" is not a valid selector (CSS or Playwright).`);
          if (count === 1) {
            const element = await matches.elementHandle();
            result = await callPage(page, 'inspect', { element, framework, max: 6, testIdAttribute: session.testIdAttribute, order: session.order }).finally(() => element.dispose());
          } else result = { error: 'match-count', count };
        }
        if (result.error === 'match-count') {
          throw new Error(
            result.count === 0
              ? `No element matches "${selector}". Call cor_snapshot and pass a ref instead.${await frameHint(page)}`
              : `"${selector}" matches ${result.count} elements — narrow it to one, or call cor_snapshot and pass a ref.`,
          );
        }
        await verifyNumberedIds(page, result.locators, idCache);
        await verifyTemplate(page, result.params);
        const top = result.locators.reduce((a, b) => (b.score > a.score ? b : a), result.locators[0]);
        if (top?.volatileId && top !== result.locators[0]) {
          const [best] = result.locators;
          result.rankingNote = `Demoted ${top.value} (score ${top.score}) — its id changes on every page load (${top.volatileId.id} was ${top.volatileId.seen} on a fresh load). Ranked ${best.value} first.`;
        }
        const refsLive = Boolean(session.refs && !session.refs.staleBecause);
        // once per session: the note is about the page, not this element
        const dataCyNote = !dataCyNoted && framework === 'cypress' && result.testAttrs === false;
        if (dataCyNote) dataCyNoted = true;
        const detected = session.detection.candidates.find((c) => c.framework === framework);
        // U8: an entry with a cor: id; its record (fingerprint + ranked strategies) is written under .cor/records/.
        const typescript = Boolean(detected?.typescript);
        const makeEntry = ({ lead, helper }) => {
          const strategies = [
            ...(lead?.template?.playwright ? [{ kind: 'template', value: lead.template.playwright.selectorTemplate }] : []),
            ...result.locators.map((l) => ({ kind: l.strategy, value: l.value })),
          ];
          const id = records ? records.issue({ url: page.url(), fingerprint: result.capture.fingerprint, elementKey: result.capture.elementKey, strategies }) : newId();
          const entry = entryFor({ result, lead, helper, framework, conventions: session.conventions, typescript, url: page.url(), id });
          if (records && entry.store === 'json') records.link(`${entry.file}#${entry.member}`, id);
          return entry.lines;
        };
        const reply = renderInspect(result, { refsLive, framework, all, dataCyNote, typescript, major: detected?.version ?? null, testingLibrary: Boolean(detected?.testingLibrary), makeEntry });
        const response = text(reply);
        if (fingerprints && result.locators.length) {
          fingerprints.record({ url: page.url(), ...result.capture, locators: result.locators.map((l) => l.value) });
        }
        return response;
      },
    },
  ];
}
