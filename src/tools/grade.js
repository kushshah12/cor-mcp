import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { renderGrade } from '../format.js';
import { parseGradable, NotGradable, SUPPORTED_FORMS } from '../grade-parse.js';
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
          selector: z.string().min(1).describe('The selector exactly as written in the test, e.g. page.getByRole(\'button\', { name: \'Save\' }) or cy.get(\'.btn\').'),
          framework: z.enum(FRAMEWORKS).optional().describe('Framework to render alternatives for. Defaults to the form of the selector (getBy* → playwright, cy.* → cypress), else playwright.'),
        },
      },
      handler: async ({ selector, framework }) => {
        if (!session.isOpen) throw new Error('No page is open — call cor_open with the page the selector targets first.');
        let parsed;
        try {
          parsed = parseGradable(selector);
        } catch (error) {
          if (!(error instanceof NotGradable)) throw error;
          throw new Error(
            `Not gradable as written: ${error.message}. Pass ${SUPPORTED_FORMS} — or call cor_snapshot and cor_inspect the element by ref.`,
          );
        }
        const fw = framework ?? parsed.framework ?? 'playwright';
        const page = await session.getPage();

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

        const { graded, candidates } = await callPage(page, 'grade', { element, value: parsed.scoreValue, framework: fw, matchCount });
        if (matchCount === 1) {
          const ids = numberedIds(parsed.scoreValue);
          const verdicts = await checkIds(page, ids, idCache);
          const regenerated = ids.map((id) => ({ id, ...verdicts.get(id) })).find((v) => v.status === 'regenerated');
          if (regenerated) graded.volatileId = { id: regenerated.id, seen: regenerated.seen };
          if (candidates) await verifyNumberedIds(page, candidates.locators, idCache);
        }
        return text(renderGrade({ input: selector, graded, candidates, note: parsed.note, uncountable }));
      },
    },
  ];
}
