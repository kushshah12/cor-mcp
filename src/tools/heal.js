// U12: cor_heal — a broken locator's replacement, proposed from its committed record (.cor/records/<id>.json), never
// applied (R35, R40). Evidence first: a stored strategy that still finds exactly one element whose fingerprint matches
// (recorded while the locator worked, R39); then fingerprint similarity, accepted only with a clear lead; else decline.
// The proposal goes through the same decision rules as any entry (R34) and keeps the entry's id.
import { z } from 'zod';
import { parseGradable } from '../grade-parse.js';
import { callPage, handleFromPage } from '../page-runtime.js';
import { ID_PATTERN, pathOf, recordPage } from '../records.js';
import { rootedExpression } from '../check-scan.js';
import { verifyRecord } from '../verify.js';

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

// Calibrated on the mutation cases in tests/u12-heal.test.js (0 wrong-element heals): a stored strategy's element must
// still look like the recorded one; a similarity heal needs a high score AND a clear lead over the next element.
export const STORED_MIN = 0.7;
export const SIMILARITY_MIN = 0.7;
export const SIMILARITY_MARGIN = 0.15;
const MAX_LISTED = 5;

// Attributes that say WHICH element it is — when the text changed, one of these must still be equal (review fix).
const IDENTIFYING = ['aria-label', 'aria-labelledby', 'name', 'placeholder', 'title', 'alt', 'href', 'for'];

/**
 * The most scoreSimilarity can give this fingerprint: same tag 0.25, attributes 0.55 (only if it has any), text 0.2
 * (only if it has some). A button with no attributes tops out at 0.45 — so the stored-locator bar is relative to this.
 */
export const maxSimilarity = (fp) => 0.25 + (Object.keys(fp.attrs ?? {}).length ? 0.55 : 0) + (fp.text ? 0.2 : 0);

/** Is the live element plausibly the recorded one? Same tag; and if its text changed, an identifying attribute kept. */
export function sameIdentity(recorded, live) {
  if (!live || recorded.tag !== live.tag) return false;
  if (!recorded.text || !live.text || recorded.text === live.text) return true;
  return IDENTIFYING.some((a) => recorded.attrs?.[a] != null && recorded.attrs[a] === live.attrs?.[a]);
}

/** A stored `{ kind, value }` as a Playwright locator on `page`, or null when it cannot be run as stored. */
export function strategyLocator(page, { kind, value }) {
  if (kind === 'template') return null; // takes a parameter: not one element
  if (/:nth-|nth=|\[\d+\]$/.test(value)) return null; // a position finds whatever is there now — never evidence (review fix)
  if (/^aria\//.test(value)) return null; // WebdriverIO's accessible-name form: no role to run it with here
  if (kind === 'role' || kind === 'roleExact') {
    const m = /^role=([\w-]+)(?:, name=(.*?))?(?: \(exact\))?$/.exec(value);
    return m ? page.getByRole(m[1], m[2] !== undefined ? { name: m[2], exact: true } : {}) : null;
  }
  if (['text', 'textExact', 'linkText'].includes(kind)) return page.getByText(value.replace(/^"(.*)"$/, '$1'), { exact: true });
  if (kind === 'label') return page.getByLabel(value, { exact: true });
  if (kind === 'placeholder') return page.getByPlaceholder(value, { exact: true });
  if (kind === 'title') return page.getByTitle(value, { exact: true });
  if (kind === 'alt') return page.getByAltText(value, { exact: true });
  return page.locator(value);
}

/** P6: a template member's own line, run for every recorded item — one element each. Not readable: false. */
async function lineFindsEvery(page, line, expr, values) {
  const param = /\(\s*(\w+)(?:\s*:[^)]*)?\)\s*=>/.exec(line)?.[1];
  if (!param || !expr) return false;
  try {
    const parsed = parseGradable(expr, { param });
    for (const v of values) if (await parsed.build(page, v).count() !== 1) return false;
    return true;
  } catch { return false; }
}

/** P3: the record of an every-item locator (a template's items), not of one element. */
const isEvery = (record) => record.strategies.some((s) => s.kind === 'every');

/** A stored strategy that still finds the recorded element, else a clear fingerprint match, else a decline (P8b uses it too). */
export async function propose(page, record) {
  // 1. A stored strategy that still finds exactly one element that still looks like the recorded one.
  for (const s of record.strategies) {
    const loc = strategyLocator(page, s);
    if (!loc) continue;
    let handle = null;
    try { if (await loc.count() === 1) handle = await loc.elementHandle(); } catch { continue; }
    if (!handle) continue;
    let sim = 0;
    let live = null;
    try {
      sim = await callPage(page, 'similarityTo', { element: handle, fingerprint: record.fingerprint });
      live = await callPage(page, 'fingerprintOf', { element: handle });
    } catch { /* the element went away mid-check: try the next strategy */ }
    const rel = sim / maxSimilarity(record.fingerprint);
    if (rel >= STORED_MIN && sameIdentity(record.fingerprint, live)) return { handle, evidence: `stored ${s.kind} locator ${s.value} still finds exactly one element, and it matches the recorded fingerprint (${Math.round(rel * 100)}% of a full match)` };
    await handle.dispose().catch(() => {});
  }
  // 2. Fingerprint similarity, with a clear lead. P6: relative to the most this fingerprint can score — a plain
  // <p class="price"> tops out at 0.45 and could never reach 0.7; one with attributes (max 1.0) keeps the calibrated bar.
  const max = maxSimilarity(record.fingerprint);
  const { best, next } = await callPage(page, 'healScores', { fingerprint: record.fingerprint });
  const found = await handleFromPage(page, 'healBest', { fingerprint: record.fingerprint, min: SIMILARITY_MIN * max, margin: SIMILARITY_MARGIN * max });
  const handle = found.asElement();
  if (handle && sameIdentity(record.fingerprint, await callPage(page, 'fingerprintOf', { element: handle }).catch(() => null))) {
    return { handle, evidence: `no stored locator finds it; fingerprint similarity ${best.toFixed(2)} of a possible ${max.toFixed(2)} (next element ${next.toFixed(2)})` };
  }
  await found.dispose();
  return { handle: null, evidence: `no stored locator finds it, and no element is close enough — best similarity ${best.toFixed(2)}, next ${next.toFixed(2)}; a heal needs ≥ ${(SIMILARITY_MIN * max).toFixed(2)} and a lead of ${(SIMILARITY_MARGIN * max).toFixed(2)}` };
}

export function healTools(session, inspector, records = null) {
  async function proposalLines(page, record) {
    const { handle, evidence } = await propose(page, record);
    if (!handle) return { ok: false, lines: [`Declined — ${evidence}. The element may be gone or changed beyond recognition: cor_snapshot the page and cor_inspect it if it still exists.`] };
    const { entry, template } = await inspector({ element: handle, quiet: true, reuseId: record.id }).finally(() => handle.dispose());
    if (!entry) return { ok: false, lines: [`Found the element (${evidence}), but COR has no durable locator for it — cor_inspect it for the recommendation.`] };
    return { ok: true, lines: [`Evidence: ${evidence}.`, ...await itemsLine(page, record, template), 'Proposed — not applied. Replace the entry with (same id):', ...entry.filter(Boolean).map((l) => `  ${l}`)] };
  }

  /** P6 template heal: the proposed template is checked against every item the record knew, before it is offered. */
  async function itemsLine(page, record, template) {
    if (!record.values?.length || record.kind !== 'item') return [];
    if (!template) return [`The record held a template for ${record.values.length} items; the proposal is for this one element only — cor_inspect one item for a template.`];
    const check = await verifyRecord(page, { ...record, strategies: [{ kind: 'template', value: template }] });
    return [check.ok ? `The proposed template finds every recorded item (${record.values.length}: ${record.values.map((v) => `"${v}"`).join(', ')}).`
      : `The proposed template does not reach every recorded item — ${check.why ?? check.skip}. Check those items before applying it.`];
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
      let lineRuns = false; // P6: the given line runs on its own (not a template member taking a parameter)
      if (expr) {
        try {
          const n = await parseGradable(expr).build(page).count();
          lineRuns = true;
          if (n === 1) {
            return text('Healthy — it still finds exactly one element on this page. The failure is in the product or the assertion, not this locator. No heal.');
          }
        } catch { /* not runnable here: carry on */ }
      }

      if (!id) {
        // R45: no id — COR cannot tell which element this locator meant. List what lost its locators, claim no pairing.
        if (!records) return text('No cor: id, and records are off — COR has nothing to heal from. cor_inspect the element and place its entry.', true);
        const here = pathOf(recordPage(page.url()));
        const lost = [];
        for (const rid of records.list()) {
          const r = records.read(rid);
          if (!r || pathOf(r.page) !== here || isEvery(r)) continue; // P3: an every-item locator finds many by design
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
      // Review fix: by path, so a record made on localhost heals on staging too.
      if (isEvery(record)) return text(`cor:${id} is an every-item locator — it finds every item, not one element, so there is nothing to heal to. cor_inspect one item for its entry; the entry carries the every-item locator again.`, true);
      if (pathOf(record.page) !== pathOf(recordPage(page.url()))) return text(`cor:${id} was recorded on the page ${pathOf(record.page)}; this page is ${pathOf(page.url())}. cor_open that page and run cor_heal again.`, true);
      // P6 template heal: an item template that still finds one element for every recorded item is healthy — said
      // outright for a template member's line; with an id only, the code may hold another form, so it is a note.
      const templateOk = record.kind === 'item' && record.values?.length && !lineRuns
        && (locator ? await lineFindsEvery(page, locator, expr, record.values) : (await verifyRecord(page, record)).ok);
      if (templateOk && locator) return text(`Healthy — cor:${id}'s template still finds every recorded item (${record.values.length}) on this page, and the recorded one is among them. The failure is in the product or the assertion, not this locator. No heal.`);
      const { ok, lines } = await proposalLines(page, record);
      const note = templateOk ? [`Note: the template COR issued for cor:${id} still finds every recorded item (${record.values.length}) — if your code uses it, it needs no heal.`] : [];
      return text([`Heal for cor:${id} (recorded ${record.created}).`, ...note, ...lines].join('\n'), !ok); // a decline is not a success
    },
  }];
}
