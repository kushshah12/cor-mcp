import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { renderInspect, renderSnapshot } from '../format.js';
import { checkRef, goneError } from './refs.js';
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
          'List the visible interactive elements on the current page, one per line, each with a ref (e1, e2…). ' +
          'Pick the element you need, then pass its ref to cor_inspect for ranked locators. ' +
          'Elements sharing a role and name carry a context hint (in "…"); ✓id marks elements with a test attribute. ' +
          'Take a new snapshot after any navigation or act call — earlier refs expire.',
        inputSchema: {},
      },
      handler: async () => {
        const page = await openPage();
        const snapshot = await callPage(page, 'snapshot');
        session.issueRefs(snapshot.count);
        return text(renderSnapshot(snapshot));
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
        },
      },
      handler: async ({ ref, selector, framework }) => {
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
        const top = result.locators.reduce((a, b) => (b.score > a.score ? b : a), result.locators[0]);
        if (top?.volatileId && top !== result.locators[0]) {
          const [best] = result.locators;
          result.rankingNote = `Demoted ${top.value} (score ${top.score}) — its id changes on every page load (${top.volatileId.id} was ${top.volatileId.seen} on a fresh load). Ranked ${best.value} first.`;
        }
        const refsLive = Boolean(session.refs && !session.refs.staleBecause);
        const response = text(renderInspect(result, { refsLive }));
        if (fingerprints && result.locators.length) {
          fingerprints.record({ url: page.url(), ...result.capture, locators: result.locators.map((l) => l.value) });
        }
        return response;
      },
    },
  ];
}
