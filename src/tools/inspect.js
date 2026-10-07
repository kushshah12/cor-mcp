import { frameHint } from '../frames.js';
import { z } from 'zod';
import { callPage } from '../page-runtime.js';
import { inspectParts, renderBrief, renderInspect } from '../format.js';
import { renderAmbiguousScope, renderIndex, renderScoped, renderSnapshot } from '../format-snapshot.js';
import { REF, checkRef, goneError } from './refs.js';
import { applyIdVerdicts, checkIds, numberedIds } from '../id-stability.js';
import { parseGradable } from '../grade-parse.js';
import { entryFor, everyName, everyOf, memberName } from '../entries.js';
import { bannedIn, bannedSelector } from '../positional.js';
import { pathOf } from '../records.js';

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
// P2a: entry blocks a cor_snapshot within reply carries; the rest are counted with their refs.
const WITHIN_ENTRIES = 5; // P4: was 8

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
    // P3: a template reaching an element inside the cell (an image) finds none where a cell lacks it — that is the answer
    // there (no tick); more than one, or nothing parseable, still fails.
    const ok = (n) => n === 1 || (params.model?.inner && n === 0);
    const bad = counts.findIndex((n) => !ok(n));
    if (bad !== -1) {
      params.reason = `the template matched ${counts[bad] < 0 ? 'nothing parseable' : counts[bad]} for ${combos[bad].join(' / ')} when Playwright counted it`;
      delete params.template;
      return;
    }
    params.counted = combos.length;
    // P1c: WebdriverIO and Cypress hand the XPath to the browser as it is, so it is also counted with the browser's own XPath engine.
    const browser = await callPage(page, 'countXpaths', { xpaths: combos.map(([r, c]) => params.template.xpath.selectorTemplate.replace(`__${rv}__`, () => xpathLiteralOf(r)).replace(`__${cv}__`, () => xpathLiteralOf(c))) });
    if (browser.some((n) => !ok(n))) params.template.xpath = null;
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * P2a fix: the visible label a user clicks to change a hidden input — in the framework's own form, and only when it finds
 * exactly that one label (the page counts it), else null.
 */
async function labelLocator(page, text, framework) {
  const labels = await page.locator('label').filter({ hasText: new RegExp(`^\\s*${escapeRe(text)}\\s*$`) }).count().catch(() => 0);
  if (labels !== 1) return null;
  if (framework === 'cypress') return `cy.contains('label', /^\\s*${escapeRe(text)}\\s*$/)`;
  if (framework === 'webdriverio') return `$(${quote(`label=${text}`)})`;
  if (framework !== 'playwright') return null;
  const byText = await page.getByText(text, { exact: true }).count().catch(() => 0);
  return byText === 1 ? `page.getByText(${quote(text)}, { exact: true })` : null;
}

// P2a: a page outline longer than this is answered with the region index.
const INDEX_OVER = 3000;

/**
 * P2a: the page outline as cor_open and cor_snapshot give it — in full on a small page, else the region index. Issues the
 * refs either way. P2a fix (2026-10-06 runs 2f6029eb, 90838245, c3a5447f): the full outline is no longer written to
 * .cor/snapshots/ — every agent read the whole file with Bash (~8.7k characters, 1–2 turns); a region is one
 * cor_snapshot within away.
 */
export async function pageOutline(session, page, { idCache = new Map(), full = false } = {}) {
  // U14: mark ids U7's reload check already found regenerated — cached verdicts only; a snapshot never reloads.
  const unstableIds = new Set(
    [...idCache].filter(([key, v]) => v.status === 'regenerated' && key.startsWith(`${page.url()}#`)).map(([key]) => key.slice(page.url().length + 1)),
  );
  const snapshot = await callPage(page, 'snapshot', { start: session.highestRef + 1 });
  session.issueRefs(snapshot.live);
  const outline = renderSnapshot(snapshot, { unstableIds });
  return full || outline.length <= INDEX_OVER ? outline : renderIndex(snapshot);
}

/**
 * P1: a locator that fails the shared check (positional, bare-tag chain, …) never leads while one that resolves and passes
 * exists — so a text or role anchor outranks an anonymous `div div div h3` chain whatever the engine scored.
 */
function sinkBanned(result, framework) {
  // P2a fix: WebdriverIO's aria/ lookup on a hidden input hung a whole session (2026-10-06, d50c4b2a): for an element
  // operated through its label, aria/ goes last like a banned form.
  const banned = (l) => bannedIn(l.code || l.value, framework)
    ?? (framework === 'webdriverio' && result.viaLabel && /aria\//.test(l.code || l.value) ? 'is an aria/ lookup on a hidden input, which WebdriverIO waits on' : null);
  const [first] = result.locators;
  if (!first || !banned(first)) return;
  const ok = result.locators.filter((l) => l.resolution?.usable !== false && !banned(l));
  if (!ok.length) return;
  result.locators = [...ok, ...result.locators.filter((l) => !ok.includes(l))];
  result.rankingNote = `Ranked ${ok[0].value} first — ${first.value} (score ${first.score}) ${banned(first)}, and COR never issues that.`;
}

/**
 * P3: which items of a template start open (an accordion's first answer, a disclosure) — clicking one closes it. Read per
 * value on the page: aria-expanded in the item, <details open>, or an open / active class on the item. Noted only when the
 * items differ.
 */
async function noteStartsOpen(page, params) {
  const css = params?.model?.item?.css;
  if (!params?.template || !css || !params.code || ['group', 'cell'].includes(params.kind)) return;
  let parsed;
  try { parsed = parseGradable(params.code, { param: params.param }); } catch { return; }
  const states = await Promise.all(params.values.slice(0, 30).map(async (v) => {
    const handle = await parsed.build(page, v).elementHandle({ timeout: 1000 }).catch(() => null);
    if (!handle) return null;
    return handle.evaluate((el, itemCss) => {
      const item = el.closest(itemCss) ?? el;
      // P3: clipped by an ancestor collapsed to 0 height (overflow hidden) while keeping a box of its own — what
      // BrowserStack's closed FAQ answers are. toBeVisible / be.visible / isDisplayed() all still report it visible.
      let collapsed = false;
      const own = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== item.parentElement && own.height > 0; a = a.parentElement) {
        const box = a.getBoundingClientRect();
        if ((box.height === 0 || box.width === 0) && /hidden|clip/.test(getComputedStyle(a).overflow)) { collapsed = true; break; }
      }
      const exp = item.matches('[aria-expanded]') ? item : item.querySelector('[aria-expanded]');
      const open = exp ? exp.getAttribute('aria-expanded') === 'true'
        : item.matches('details') ? item.open
          : /(^|[\s_-])(open|is-open|active|is-active|expanded|show)(\s|$)/.test(item.className) || item.hasAttribute('open');
      return { open, collapsed };
    }, css).catch(() => null).finally(() => handle.dispose());
  }));
  const open = params.values.filter((_, i) => states[i]?.open === true);
  if (open.length && states.some((s) => s?.open === false)) params.startsOpen = open;
  if (states.some((s) => s?.collapsed)) params.collapsedWhenClosed = true;
}

/**
 * U9: the inspect pipeline, shared by cor_inspect and cor_check (which issues an entry for a typed locator's element).
 * @returns {(args: object) => Promise<{ reply: string, entry: string[]|null }>}
 */
export function createInspector(session, idCache = new Map(), records = null) {
  const openPage = () => {
    if (!session.isOpen) throw new Error('No page is open — call cor_open with a URL first.');
    return session.getPage();
  };
  let dataCyNoted = false;
  // reuseId (U12): render the entry under an existing id and write no record — a heal proposal keeps the entry's id.
  return async function inspect({ ref, selector, element, framework: asked, all = false, quiet = false, reuseId = null }) {
    const framework = session.resolveFramework(asked) ?? 'playwright';
    const page = await openPage();
    let result = await callPage(page, 'inspect', { ref, selector, element, framework, max: 6, testIdAttribute: session.testIdAttribute, order: session.order });
    if (result.error === 'unknown-ref' || result.error === 'detached') throw goneError(ref);
    if (result.error === 'invalid-selector') {
      // U21: not CSS — a Playwright selector (:text-is, >>, text=)? Playwright resolves it.
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => null);
      if (count === null) throw new Error(`"${selector}" is not a valid selector (CSS or Playwright).`);
      if (count === 1) {
        const handle = await matches.elementHandle();
        result = await callPage(page, 'inspect', { element: handle, framework, max: 6, testIdAttribute: session.testIdAttribute, order: session.order }).finally(() => handle.dispose());
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
    await noteStartsOpen(page, result.params);
    const top = result.locators.reduce((a, b) => (b.score > a.score ? b : a), result.locators[0]);
    if (top?.volatileId && top !== result.locators[0]) {
      const [best] = result.locators;
      result.rankingNote = `Demoted ${top.value} (score ${top.score}) — its id changes on every page load (${top.volatileId.id} was ${top.volatileId.seen} on a fresh load). Ranked ${best.value} first.`;
    }
    sinkBanned(result, framework);
    const refsLive = Boolean(session.refs && !session.refs.staleBecause);
    // once per session: the note is about the page, not this element
    const dataCyNote = !quiet && !dataCyNoted && framework === 'cypress' && result.testAttrs === false;
    if (dataCyNote) dataCyNoted = true;
    const detected = session.detection.candidates.find((c) => c.framework === framework);
    // U8: the entry to place (store style, file, member, cor: id); its record is written under .cor/records/.
    const typescript = Boolean(detected?.typescript);
    const parts = inspectParts(result, { framework, typescript, major: detected?.version ?? null, testingLibrary: Boolean(detected?.testingLibrary) });
    // P1: every inspect issues an id — an entry, or a decline (no locator passes); the record never keeps a positional strategy.
    const { lead, entryLead, helper, declined } = parts;
    const strategies = [
      ...(lead?.template?.playwright ? [{ kind: 'template', value: lead.template.playwright.selectorTemplate }] : []),
      ...result.locators.filter((l) => !bannedSelector(l.value)).map((l) => ({ kind: l.strategy, value: l.value })),
    ];
    const member = memberName(result, entryLead);
    // P8a: the state the element was found in — the steps acted since the page was opened (cor_open or a navigation).
    const trail = session.trail?.page === pathOf(page.url()) ? session.trail : null;
    const state = records && !reuseId ? records.recordState(page.url(), trail?.steps ?? []) : 'initial';
    const kind = !entryLead ? 'single' : ['group', 'cell'].includes(entryLead.kind) ? entryLead.kind : 'item';
    const id = reuseId ?? (records ? records.issue({ url: page.url(), fingerprint: result.capture.fingerprint, elementKey: result.capture.elementKey, member, strategies, declined, state, kind, values: entryLead?.values ?? null, cell: kind === 'cell' && entryLead.vars ? { [entryLead.vars[0]]: entryLead.row, [entryLead.vars[1]]: entryLead.column } : null }) : newId());
    const labelCode = !entryLead && !declined && result.viaLabel ? await labelLocator(page, result.viaLabel, framework) : null;
    // P3: the every-item locator gets its own record and id (its strategy is the items' locator).
    const everyCode = !declined && !reuseId ? everyOf(entryLead, framework, helper) : null;
    const everyId = everyCode ? (records ? records.issue({ url: page.url(), fingerprint: { tag: 'every', attrs: {}, text: everyCode }, elementKey: `every:${everyCode}`, member: everyName(everyCode), strategies: [{ kind: 'every', value: everyCode }], state, kind: 'every' }) /* keyed by the locator: every item of the template shares it */ : newId()) : null;
    const entry = entryFor({ result, lead: entryLead, helper, framework, conventions: session.conventions, typescript, url: page.url(), id, declined, labelCode, everyId });
    if (records && !reuseId && entry.store === 'json') records.link(`${entry.file}#${entry.member}`, id);
    // Review fix: a record that could not be written does not fail the inspect — the reply says heal has nothing for it.
    const entryLines = records?.lastError && !reuseId ? [...entry.lines.slice(0, -1), `  (record not saved: ${records.lastError} — cor_heal will have no record for this id)`, ''] : entry.lines;
    const reply = renderInspect(result, { refsLive, framework, all, dataCyNote, typescript, major: detected?.version ?? null, testingLibrary: Boolean(detected?.testingLibrary), entry: entryLines, parts });
    return { reply, entry: entryLines, declined, info: entry, brief: renderBrief(result, parts, entry, { framework, refsLive }), id, value: entryLead?.value ?? null, template: lead?.template?.playwright?.selectorTemplate ?? null };
  };
}
const renamed = (info, member) => ({ ...info, member, body: info.body?.replace(info.member, member), comment: info.comment?.replace(`· ${info.member}`, `· ${member}`), click: info.click?.map((l) => l.split(info.member).join(member)) });

/**
 * P2a: entries for many elements in one reply — the file once, then each element's comment and code, without the
 * single-element detail (alternatives, why, durable). Elements whose code is the same (a template's items) share one
 * block; a helper is defined once. Past `max` blocks the rest are counted, with their refs for cor_inspect targets.
 * @param {{ label: string, args: object }[]} targets  `args` is what the inspector takes (ref / selector / element)
 * @returns {Promise<string[]>}
 */
export async function compactEntries(inspector, targets, { max = Infinity, framework } = {}) {
  const blocks = [];
  const byBody = new Map();
  const rest = [];
  const failed = [];
  for (const t of targets) {
    if (blocks.length >= max) { rest.push(t.label); continue; }
    let r;
    try { r = await inspector({ ...t.args, framework, quiet: true }); } catch (error) { failed.push(`${t.label} ✗ ${error.message.split('\n')[0]}`); continue; }
    const { info, declined } = r;
    const key = declined ? null : info.body ?? info.lines.join('\n');
    if (key && byBody.has(key)) { byBody.get(key).labels.push(t.label); continue; }
    // Two elements named alike (two "Add" buttons) would be two members of one name: the later one is numbered.
    const taken = blocks.filter((b) => b.info.member === info.member || b.info.member.startsWith(`${info.member}`) && /^\d+$/.test(b.info.member.slice(info.member.length))).length;
    const named = taken ? renamed(info, `${info.member}${taken + 1}`) : info;
    const block = { labels: [t.label], info: named, declined };
    blocks.push(block);
    if (key) byBody.set(key, block);
  }
  if (!blocks.length) return failed;
  const out = [`Entries — place in ${blocks[0].info.file} (keep each // COR comment: cor_check reads the ids):`];
  const helpers = new Set();
  for (const { labels, info, declined } of blocks) {
    if (declined) { out.push(`${labels.join(', ')} ✗ ${info.member}: declined — ${declined}`, info.lines[1]); continue; }
    out.push(`${labels.join(', ')} → ${info.member}${info.file === blocks[0].info.file ? '' : ` (in ${info.file})`}${info.proof ? ` — ${info.proof}` : ''}`);
    const helper = (info.preamble ?? []).join('\n');
    if (helper && !helpers.has(helper)) { helpers.add(helper); out.push(...info.preamble); } else if (helper) out.push('  (helper above)');
    out.push(...(info.comment ? [info.comment, info.body, ...(info.click ?? [])] : info.lines.slice(1, -1))); // a JSON / YAML map entry
    for (const n of info.notes ?? []) out.push(`  ${n}`);
  }
  if (rest.length) out.push(`… ${rest.length} more: cor_inspect targets: [${rest.map((l) => JSON.stringify(l)).join(', ')}]`);
  return [...out, ...failed];
}

/** @param {ReturnType<import('../session.js').createSession>} session */
export function inspectTools(session, idCache = new Map(), inspector = createInspector(session, idCache), records = null) {
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
          'Take a new snapshot after any navigation or act call — earlier refs expire. ' +
          'On a large page it answers with a region index (each region\'s controls, the named ones first); full: true lists every control.',
        inputSchema: {
          full: z.boolean().optional().describe('The whole outline even on a large page, instead of the region index.'),
          within: z.string().optional().describe(
            'Show one region in full instead — every line of text, prices and labels included. ' +
            'A ref (its region: the card, row, column or section that identifies it) or a region\'s name ' +
            '(a heading, a landmark label, a list item or table row\'s text). A name matching several regions returns the choices.',
          ),
        },
      },
      handler: async ({ within, full = false }) => {
        const page = await openPage();
        if (!within) return text(await pageOutline(session, page, { idCache, full }));
        const unstableIds = new Set(
          [...idCache].filter(([key, v]) => v.status === 'regenerated' && key.startsWith(`${page.url()}#`)).map(([key]) => key.slice(page.url().length + 1)),
        );

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
        // P2a: the region's entries come with it — its controls and texts, a template's items sharing one entry.
        const targets = scoped.lines.flatMap((l) => [l.ref, l.contentRef]).filter(Boolean).map((ref) => ({ label: ref, args: { ref } }));
        const entries = targets.length ? await compactEntries(inspector, targets, { max: WITHIN_ENTRIES }) : [];
        return text([renderScoped(scoped, within, { unstableIds }), ...(entries.length ? ['', ...entries] : [])].join('\n'));
      },
    },
    {
      name: 'cor_inspect',
      config: {
        title: 'Get ranked locators for an element',
        description:
          'Rank, score and match-count locators for one element, rendered for the chosen test framework. ' +
          'Pass a ref from cor_snapshot, or a CSS selector that matches exactly one element — or targets: many of them in one call, one entry each. ' +
          'The response leads with the recommendation; below the quality floor it recommends an application change ' +
          '(a test attribute) instead of a fragile locator. Use the locator as given; write the surrounding test code yourself.',
        inputSchema: {
          ref: z.string().optional().describe('Element ref from the latest cor_snapshot, e.g. "e4".'),
          selector: z.string().optional().describe('CSS or Playwright selector (:text-is, >>, text=) matching exactly one element — alternative to ref.'),
          targets: z.array(z.string()).min(1).max(30).optional().describe('P2a: several refs or selectors at once — every element you need from this page in one call. Each gets its entry only (no alternatives); inspect one ref alone for the detail.'),
          framework: z.enum(FRAMEWORKS).optional().describe('Test framework to render and rank for. Default: the project\'s framework as cor_open reported it, else playwright.'),
          detail: z.boolean().optional().describe('P4: the full reply — alternatives, facts, why this order, the durable annotation. By default: the answer and its code, about 6 lines.'),
          all: z.boolean().optional().describe('List every alternative. By default: the runner-up and the best of each other locator kind, up to 3.'),
        },
      },
      handler: async ({ ref, selector, targets, framework: asked, all = false, detail = false }) => {
        if ([ref, selector, targets].filter(Boolean).length !== 1) throw new Error('Pass exactly one of ref (from cor_snapshot), selector, or targets.');
        if (targets) {
          await openPage();
          const list = targets.map((t) => (REF.test(t.trim()) ? { label: t.trim(), args: { ref: t.trim() }, ref: true } : { label: t, args: { selector: t } }));
          for (const t of list) if (t.ref) { try { checkRef(session, t.label); } catch (error) { t.args = null; t.error = error; } }
          const usable = list.filter((t) => t.args);
          const lines = await compactEntries(inspector, usable, { framework: asked });
          return text([...lines, ...list.filter((t) => t.error).map((t) => `${t.label} ✗ ${t.error.message.split('\n')[0]}`)].join('\n'));
        }
        if (ref) checkRef(session, ref);
        const done = await inspector({ ref, selector, framework: asked, all });
        return text(detail || all ? done.reply : done.brief);
      },
    },
  ];
}
