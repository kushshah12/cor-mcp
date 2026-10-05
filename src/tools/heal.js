// U12: cor_heal — a broken locator's replacement, proposed from its committed record (.cor/records/<id>.json), never
// applied (R35, R40). Evidence first: a stored strategy that still finds exactly one element whose fingerprint matches
// (recorded while the locator worked, R39); then fingerprint similarity, accepted only with a clear lead; else decline.
// The proposal goes through the same decision rules as any entry (R34) and keeps the entry's id.
import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { pageKey } from '../fingerprints.js';
import { parseGradable } from '../grade-parse.js';
import { callPage, handleFromPage } from '../page-runtime.js';
import { ID_PATTERN } from '../records.js';
import { rootedExpression } from '../check-scan.js';

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

// Calibrated on the mutation cases in tests/u12-heal.test.js (0 wrong-element heals): a stored strategy's element must
// still look like the recorded one; a similarity heal needs a high score AND a clear lead over the next element.
export const STORED_MIN = 0.6;
export const SIMILARITY_MIN = 0.7;
export const SIMILARITY_MARGIN = 0.15;
const MAX_LISTED = 5;

/** A stored `{ kind, value }` as a Playwright locator on `page`, or null when it cannot be run as stored. */
export function strategyLocator(page, { kind, value }) {
  if (kind === 'template') return null; // takes a parameter: not one element
  if (kind === 'role' || kind === 'roleExact') {
    const m = /^role=([\w-]+)(?:, name=(.*))?$/.exec(value);
    return m ? page.getByRole(m[1], m[2] !== undefined ? { name: m[2], exact: true } : {}) : null;
  }
  if (['text', 'textExact', 'linkText'].includes(kind)) return page.getByText(value, { exact: true });
  if (kind === 'label') return page.getByLabel(value, { exact: true });
  if (kind === 'placeholder') return page.getByPlaceholder(value, { exact: true });
  if (kind === 'title') return page.getByTitle(value, { exact: true });
  if (kind === 'alt') return page.getByAltText(value, { exact: true });
  return page.locator(value);
}

export function healTools(session, inspector, records = null) {
  async function propose(page, record) {
    // 1. A stored strategy that still finds exactly one element that still looks like the recorded one.
    for (const s of record.strategies) {
      const loc = strategyLocator(page, s);
      if (!loc) continue;
      let handle = null;
      try { if (await loc.count() === 1) handle = await loc.elementHandle(); } catch { continue; }
      if (!handle) continue;
      const sim = await callPage(page, 'similarityTo', { element: handle, fingerprint: record.fingerprint });
      if (sim >= STORED_MIN) return { handle, evidence: `stored ${s.kind} locator ${s.value} still finds exactly one element, and it matches the recorded fingerprint (${sim.toFixed(2)})` };
      await handle.dispose();
    }
    // 2. Fingerprint similarity, with a clear lead.
    const { best, next } = await callPage(page, 'healScores', { fingerprint: record.fingerprint });
    const found = await handleFromPage(page, 'healBest', { fingerprint: record.fingerprint, min: SIMILARITY_MIN, margin: SIMILARITY_MARGIN });
    const handle = found.asElement();
    if (handle) return { handle, evidence: `no stored locator finds it; fingerprint similarity ${best.toFixed(2)} (next element ${next.toFixed(2)})` };
    await found.dispose();
    return { handle: null, evidence: `no stored locator finds it, and no element is close enough — best similarity ${best.toFixed(2)}, next ${next.toFixed(2)}; a heal needs ≥ ${SIMILARITY_MIN} and a lead of ${SIMILARITY_MARGIN}` };
  }

  async function proposalLines(page, record) {
    const { handle, evidence } = await propose(page, record);
    if (!handle) return { ok: false, lines: [`Declined — ${evidence}. The element may be gone or changed beyond recognition: cor_snapshot the page and cor_inspect it if it still exists.`] };
    const { entry } = await inspector({ element: handle, quiet: true, reuseId: record.id }).finally(() => handle.dispose());
    if (!entry) return { ok: false, lines: [`Found the element (${evidence}), but COR has no durable locator for it — cor_inspect it for the recommendation.`] };
    return { ok: true, lines: [`Evidence: ${evidence}.`, 'Proposed — not applied. Replace the entry with (same id):', ...entry.filter(Boolean).map((l) => `  ${l}`)] };
  }

  return [{
    name: 'cor_heal',
    config: {
      title: 'Propose a replacement for a broken locator',
      description:
        'When a test fails because a locator no longer finds its element. Pass the locator line as it is in the file (its // COR cor:… comment ' +
        'included) or its id, with the page open where the element should be. COR opens the committed record for that id, tries the locators it ' +
        'recorded while this one worked, then the element\'s fingerprint, and proposes a graded replacement — or declines. It never edits a file. ' +
        'With no id, it lists the elements on this page whose recorded locators all fail.',
      inputSchema: {
        locator: z.string().optional().describe('The broken locator line, its cor: comment included.'),
        id: z.string().regex(/^[0-9a-f]{6}$/).optional().describe('The entry\'s id (the 6 characters after cor:).'),
      },
    },
    handler: async ({ locator, id: given }) => {
      if (!session.isOpen) throw new Error('No page is open — cor_open the page where the element should be, then run cor_heal.');
      const page = await session.getPage();
      const id = given ?? (locator ? ID_PATTERN.exec(locator)?.[1] : null);

      // The locator still works: not a heal case (C1).
      const expr = locator ? rootedExpression(locator) : null;
      if (expr) {
        try {
          if (await parseGradable(expr).build(page).count() === 1) {
            return text('Healthy — it still finds exactly one element on this page. The failure is in the product or the assertion, not this locator. No heal.');
          }
        } catch { /* not runnable here: carry on */ }
      }

      if (!id) {
        // R45: no id — COR cannot tell which element this locator meant. List what lost its locators, claim no pairing.
        if (!records) return text('No cor: id, and records are off — COR has nothing to heal from. cor_inspect the element and place its entry.', true);
        let ids = [];
        try { ids = readdirSync(records.dir()).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { /* none */ }
        const here = pageKey(page.url());
        const lost = [];
        for (const rid of ids) {
          const r = records.read(rid);
          if (!r || r.page !== here) continue;
          let works = false;
          for (const s of r.strategies) {
            const loc = strategyLocator(page, s);
            if (loc && await loc.count().catch(() => 0) === 1) { works = true; break; }
          }
          if (!works) lost.push(r);
        }
        if (!lost.length) return text('No cor: id on this locator, and every recorded element on this page is still found. cor_inspect the element and place its entry.', true);
        const out = [`No cor: id on this locator, so COR cannot tell which element it meant. ${lost.length} recorded element${lost.length === 1 ? '' : 's'} on this page lost every recorded locator — match by hand:`, ''];
        for (const r of lost.slice(0, MAX_LISTED)) {
          out.push(`cor:${r.id} — was ${r.strategies[0]?.value ?? r.fingerprint.tag}:`, ...(await proposalLines(page, r)).lines.map((l) => `  ${l}`), '');
        }
        return text(out.join('\n').trimEnd(), true);
      }

      const record = records?.read(id);
      if (!record) return text(`No record for cor:${id} in .cor/records/ — the id was not issued in this project, or records are off. cor_inspect the element for a new entry.`, true);
      if (record.page !== pageKey(page.url())) return text(`cor:${id} was recorded on ${record.page}; this page is ${pageKey(page.url())}. cor_open that page and run cor_heal again.`, true);
      const { lines } = await proposalLines(page, record);
      return text([`Heal for cor:${id} (recorded ${record.created}).`, ...lines].join('\n'));
    },
  }];
}
