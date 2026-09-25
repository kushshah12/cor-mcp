import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { renderAmbiguousScope, renderInspect, renderScoped, renderSnapshot } from '../format.js';
import { REF, checkRef, goneError } from './refs.js';
import { applyIdVerdicts, checkIds, numberedIds } from '../id-stability.js';

export const FRAMEWORKS = ['playwright', 'cypress', 'selenium', 'webdriverio', 'nightwatch', 'testcafe', 'puppeteer'];

const text = (value) => ({ content: [{ type: 'text', text: value }] });

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
export async function verifyTemplate(page, params) {
  if (!params?.template) return;
  const values = params.values.slice(0, COUNT_MAX);
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
  if (params.template.xpath) {
    const xcounts = await callPage(page, 'countXpath', { template: params.template.xpath.selectorTemplate, values });
    if (xcounts.some((c) => c !== 1)) params.template.xpath = null;
  }
}

/** @param {ReturnType<import('../session.js').createSession>} session */
export function inspectTools(session, idCache = new Map(), fingerprints = null) {
  const openPage = () => {
    if (!session.isOpen) throw new Error('No page is open — call cor_open with a URL first.');
    return session.getPage();
  };

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
          selector: z.string().optional().describe('CSS selector matching exactly one element — alternative to ref.'),
          framework: z.enum(FRAMEWORKS).default('playwright').describe('Test framework to render and rank for.'),
          all: z.boolean().optional().describe('List every alternative. By default: the runner-up and the best of each other locator kind, up to 3.'),
        },
      },
      handler: async ({ ref, selector, framework, all = false }) => {
        if (Boolean(ref) === Boolean(selector)) throw new Error('Pass exactly one of ref (from cor_snapshot) or selector.');
        const page = await openPage();
        if (ref) checkRef(session, ref);
        const result = await callPage(page, 'inspect', { ref, selector, framework, max: 6 });
        if (result.error === 'unknown-ref' || result.error === 'detached') throw goneError(ref);
        if (result.error === 'invalid-selector') throw new Error(`"${selector}" is not a valid CSS selector.`);
        if (result.error === 'match-count') {
          throw new Error(
            result.count === 0
              ? `No element matches "${selector}". Call cor_snapshot and pass a ref instead.`
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
        const response = text(renderInspect(result, { refsLive, framework, all }));
        if (fingerprints && result.locators.length) {
          fingerprints.record({ url: page.url(), ...result.capture, locators: result.locators.map((l) => l.value) });
        }
        return response;
      },
    },
  ];
}
