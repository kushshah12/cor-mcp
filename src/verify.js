// P8b: verification — what the repo's records say is on a page, checked instead of rediscovered (R13–R20).
// Valid = the recorded locator finds exactly one element AND it matches the recorded fingerprint (cor_heal's bar); an item
// template is checked for every value. Later states are reached by replaying their steps in a background tab — never the
// agent's page or refs. A failing step stops its state ("state not reached"); a failure gets cor_heal's proposal or
// "re-inspect"; nothing is applied. Past the time cap the rest is "not checked". Replies carry members, files and
// statuses — never record contents (R20).
import { callPage } from './page-runtime.js';
import { pathOf } from './records.js';
import { maxSimilarity, propose, sameIdentity, STORED_MIN, strategyLocator } from './tools/heal.js';

const placeholders = (tpl) => [...new Set(tpl.match(/__\w+__/g) ?? [])];
const xpathLiteral = (v) => (!v.includes("'") ? `'${v}'` : !v.includes('"') ? `"${v}"` : `concat(${v.split("'").map((p) => `'${p}'`).join(`, "'", `)})`);
/** A template with its one placeholder filled: a quoted CSS string (`"__title__"`) or an XPath literal (cells, rows). */
const fill = (tpl, name, value) => tpl.replace(new RegExp(`"${name}"|${name}`, 'g'), (m) => (m.startsWith('"') ? JSON.stringify(value) : xpathLiteral(value)));
const templateOf = (record) => {
  const tpl = record.strategies.find((s) => s.kind === 'template')?.value;
  const names = tpl ? placeholders(tpl) : [];
  // ponytail: one placeholder only — a cell (row × column) is checked through its single-element locators.
  return names.length === 1 ? { tpl, name: names[0] } : null;
};

/** The one element a locator finds, else how many it found. */
async function one(loc) {
  const n = await loc.count().catch(() => 0);
  return n === 1 ? { handle: await loc.elementHandle().catch(() => null) } : { found: n };
}

/** Does the live element look like the recorded one — cor_heal's bar: similarity and identity. */
async function matches(page, handle, fingerprint) {
  try {
    const sim = await callPage(page, 'similarityTo', { element: handle, fingerprint });
    const live = await callPage(page, 'fingerprintOf', { element: handle });
    return sim / maxSimilarity(fingerprint) >= STORED_MIN && sameIdentity(fingerprint, live);
  } catch { return false; }
}

const finds = (n) => `finds ${n} elements`;

/** R13: one record on `page` — `{ ok }` or `{ ok: false, why }`. A template is checked for every value. */
export async function verifyRecord(page, record) {
  const t = templateOf(record);
  if (t && record.values?.length) {
    let same = false;
    for (const value of record.values) {
      const { handle, found } = await one(page.locator(fill(t.tpl, t.name, value)));
      if (!handle) return { ok: false, why: `${finds(found)} for "${value}"` };
      same ||= await matches(page, handle, record.fingerprint);
      await handle.dispose().catch(() => {});
    }
    // The recorded element may be named by a value outside the list (a card named by its toggle label): its own locator counts.
    // Shown only: its own locator can find the hidden twin (the Team card's other price, before its toggle).
    return same || (await single(page, record, { shown: true })).ok ? { ok: true } : { ok: false, why: 'no item looks like the recorded element any more' };
  }
  return single(page, record);
}

/** The recorded element through its first locator that runs on its own. */
async function single(page, record, { shown = false } = {}) {
  for (const s of record.strategies) {
    const loc = strategyLocator(page, s);
    if (!loc) continue;
    const { handle, found } = await one(loc);
    if (!handle) return { ok: false, why: finds(found) };
    const same = (!shown || await handle.isVisible()) && await matches(page, handle, record.fingerprint);
    await handle.dispose().catch(() => {});
    return same ? { ok: true } : { ok: false, why: 'finds one element, but not the recorded one' };
  }
  return { ok: false, why: 'COR has no locator it can run for it' };
}

/** R16: a failed element gets cor_heal's proposal when one passes the heal bar, else "re-inspect". */
async function failed(page, record, why) {
  let healable = false;
  try {
    const { handle } = await propose(page, record);
    healable = Boolean(handle);
    await handle?.dispose().catch(() => {});
  } catch { /* the page changed under us */ }
  return { status: healable ? 'heal' : 'reinspect', why };
}

/** Replay one recorded step on the tab — its target must pass verification first (R15). Returns null, or why it failed. */
async function replay(tab, records, step) {
  const record = step.id ? records.read(step.id) : null;
  if (!record) return { why: 'its element was never recorded' };
  const t = templateOf(record);
  let target;
  // A template takes the step's value even when the item list does not hold it (the Team card's "Team Pro" label).
  if (t && step.value != null) target = await one(tab.locator(fill(t.tpl, t.name, step.value)));
  else {
    const check = await verifyRecord(tab, record);
    if (!check.ok) return { record, ...(await failed(tab, record, check.why)) };
    target = await one(record.strategies.map((s) => strategyLocator(tab, s)).find(Boolean));
  }
  if (!target.handle) return { record, ...(await failed(tab, record, finds(target.found))) };
  const navigates = Boolean(record.leadsTo);
  const landed = tab.waitForEvent('framenavigated', { timeout: navigates ? 8000 : 500 }).then(() => tab.waitForLoadState('domcontentloaded')).catch(() => {});
  try {
    // Raw DOM acts, as the act tools do (src/tools/session-tools.js): a hidden radio is clicked through its label.
    if (step.action === 'click') await target.handle.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.click(); });
    else if (step.action === 'fill') await target.handle.fill(step.value ?? '');
    else if (step.action === 'press') { await target.handle.focus(); await tab.keyboard.press(step.value); }
  } catch (error) { return { record, status: 'reinspect', why: `the ${step.action} failed (${error.message.split('\n')[0]})` }; } finally { await target.handle.dispose().catch(() => {}); }
  await landed;
  if (navigates) await tab.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  return null;
}

async function load(tab, url) {
  await tab.goto(url, { waitUntil: 'domcontentloaded' });
  await tab.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  await tab.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

/** How a page is reached: the URL it opens from and the steps after it — through `from` pages back to one opened by URL. */
function reachOf(slug, pages, current, seen = new Set()) {
  const p = pages[slug];
  if (!p || seen.has(slug)) return null;
  seen.add(slug);
  // The agent's open page on the same path is the environment under test (?release=2, staging): open it as the agent did.
  if (!p.reach?.from) return { url: current && pathOf(current) === pathOf(p.page) ? current : p.page, steps: [] };
  const before = reachOf(p.reach.from, pages, current, seen);
  return before && { url: before.url, steps: [...before.steps, ...(p.reach.steps ?? [])] };
}

/**
 * Verify the placed records of the given pages. `pages` maps a page's file name to its record (records.listPages());
 * `here` is { slug, page } when the agent's own page is that page as opened (cor_open): its initial state is checked
 * there, read-only. `current` is the agent's page URL: a recorded page on its path is opened at it. Every state is replayed in its own background tab. Returns one result per record, by id.
 * @returns {Promise<Map<string, { record: object, status: string, why?: string }>>}
 */
export async function verifyPages({ context, records, pages, slugs, here = null, current = null, capMs }) {
  const results = new Map();
  const placed = records.list().map((id) => records.read(id)).filter((r) => r && r.kind !== 'every' && !r.declined); // an every-item locator is checked through its template; a decline is cited by cor_check, not verified
  const tabs = [];
  const tasks = [];
  for (const slug of slugs) {
    const page = pages[slug];
    const mine = placed.filter((r) => pathOf(r.page) === pathOf(page?.page ?? ''));
    if (!mine.length) continue;
    for (const r of mine) results.set(r.id, { record: r, status: r.state == null ? 'needs state' : 'not checked' });
    // The agent opened this page by its URL (cor_open): that is how it is reached now.
    const reach = here?.slug === slug ? { url: here.page.url(), steps: [] } : reachOf(slug, pages, current);
    const byState = new Map();
    for (const r of mine) if (r.state != null) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);
    for (const [state, list] of byState) {
      tasks.push((async () => {
        const steps = state === 'initial' ? [] : page.states?.[state]?.steps;
        if (!steps) { for (const r of list) results.set(r.id, { record: r, status: 'reinspect', why: 'its state is not in the page record' }); return; }
        let tab = here?.slug === slug && state === 'initial' ? here.page : null;
        if (!tab) {
          if (!reach) { for (const r of list) results.set(r.id, { record: r, status: 'unreached', why: 'COR has no recorded way to reach this page' }); return; }
          tab = await context.newPage();
          tabs.push(tab);
          await load(tab, reach.url);
          for (const step of reach.steps) {
            const stop = await replay(tab, records, step);
            if (stop) { for (const r of list) results.set(r.id, { record: r, status: 'unreached', why: stepWhy(step, stop) }); return; }
          }
        }
        // P8b (run b14ddae4): a state's steps are the whole visit — check after each step, so an element shows as soon
        // as a shorter prefix reveals it; one that never passes fails after the last step.
        let left = list;
        const check = async (last) => {
          const next = [];
          for (const r of left) {
            const v = await verifyRecord(tab, r);
            if (v.ok) results.set(r.id, { record: r, status: 'verified' });
            else if (last) results.set(r.id, { record: r, ...(await failed(tab, r, v.why)) });
            else next.push(r);
          }
          left = next;
        };
        await check(!steps.length);
        for (let i = 0; i < steps.length && left.length; i++) {
          const stop = await replay(tab, records, steps[i]);
          if (stop) { for (const r of left) results.set(r.id, { record: r, status: 'unreached', why: stepWhy(steps[i], stop) }); return; }
          await check(i === steps.length - 1);
        }
      })().catch(() => { /* a tab closed at the cap, or the page broke: what is left stays "not checked" */ }));
    }
  }
  let timer;
  await Promise.race([Promise.all(tasks), new Promise((r) => { timer = setTimeout(r, capMs); })]);
  clearTimeout(timer);
  await Promise.all(tabs.map((t) => t.close().catch(() => {})));
  return results;
}

const stepWhy = (step, stop) => {
  const what = `${step.action}${step.value != null ? ` "${step.value}"` : ''}${step.id ? ` (cor:${step.id})` : ''}`;
  const fix = stop.status === 'heal' ? `cor_heal cor:${step.id} has a proposal` : 're-inspect it';
  return `step ${what} ${stop.why}${stop.record ? `; ${fix}` : ''}`;
};

const LABEL = {
  verified: 'verified',
  heal: 'broken, cor_heal has a proposal',
  reinspect: 'broken, re-inspect',
  unreached: 'state not reached',
  'needs state': 'needs state — recorded before COR kept states: cor_inspect it once',
  'not checked': 'not checked (time cap)',
};
const ORDER = Object.keys(LABEL);

/** R18: the "already in your code" block for one page — members grouped by status, files once. Only records code uses. */
export function renderInCode(results, path) {
  const used = [...results.values()].filter((r) => r.record.usedIn?.length).sort((a, b) => (a.record.member ?? '').localeCompare(b.record.member ?? ''));
  if (!used.length) return null;
  const files = [...new Set(used.flatMap((r) => r.record.usedIn.map((u) => u.file)))];
  const lines = [`Already in your code on ${path} (${files.join(', ')}): ${used.length} element${used.length === 1 ? '' : 's'}.`];
  for (const status of ORDER) {
    const group = used.filter((r) => r.status === status);
    if (!group.length) continue;
    const name = (r) => `${r.record.member ?? r.record.fingerprint.tag}${r.record.values?.length ? ` (${r.record.values.length} values)` : ''}`;
    if (status === 'verified' || status === 'not checked' || status === 'needs state') lines.push(`  ${LABEL[status]}: ${group.map(name).join(', ')}`);
    else for (const r of group) lines.push(`  ${LABEL[status]}: ${name(r)} cor:${r.record.id} — ${r.why}`);
  }
  lines.push('Reuse these members — cor_inspect only what is missing. Broken ones: cor_heal with their cor: line.');
  return lines.join('\n');
}
