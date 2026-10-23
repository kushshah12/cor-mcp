import { frameHint, targetFor } from '../frames.js';
import { z } from 'zod';
import { callPage, handleFromPage } from '../page-runtime.js';
import { renderActResult } from '../format-act.js';
import { compactEntries } from './inspect.js';

// P2a: entry blocks an act reply carries; the rest are counted with their refs.
export const ACT_ENTRIES = 4; // P4: was 6
import { checkRef, goneError } from './refs.js';
import { pageSlug, pathOf, recordPage } from '../records.js';
import { renderInCode, verifyPages } from '../verify.js';

// P8b: how long cor_open spends verifying what the repo already holds for the page; the rest is "not checked".
export const OPEN_VERIFY_MS = 8000;

// Act tools only reach a page state so an element can be inspected; nothing
// here asserts. So they use raw DOM calls through evaluate rather than
// Playwright's actionability checks (visible, stable, enabled, not covered).
// A click that does not land shows up as the element still being absent,
// which the agent sees and retries.

const target = z.string().min(1).optional().describe('CSS selector for the element — must match exactly one. Alternative to ref.');
const ref = z.string().optional().describe('Element ref from the latest cor_snapshot, e.g. "e4". Alternative to target.');

const text = (value) => ({ content: [{ type: 'text', text: value }] });

async function pageState(page) {
  return `Now at ${page.url()} — "${await page.title()}"`;
}

// ponytail: waits up to 500 ms for an act to start a navigation, then for the
// DOM of the new page. An act that will navigate (a link, a form submit) waits up to
// 8 s for it to start: a slow server answers after 500 ms (or 5 s, on a slow day) and
// the reply would describe the old page (U22). The cost is 8 s on a submit that never
// navigates (a client-side form). A slower client-side transition lands after we return.
async function settle(page, expectNavigation = false) {
  await page
    .waitForEvent('framenavigated', { timeout: expectNavigation ? 8000 : 500 })
    .then(() => page.waitForLoadState('domcontentloaded'))
    .catch(() => {});
}

/** Will clicking this element navigate? A link to another document, or a submit button in a form. */
const expectsNavigation = (handle) =>
  handle
    .evaluate((el) => {
      const a = el.closest('a[href]');
      if (a) {
        const href = a.getAttribute('href') || '';
        return !href.startsWith('#') && !/^javascript:/i.test(href) && a.target !== '_blank';
      }
      const submit = el.tagName === 'INPUT' ? el.type === 'submit' : el.tagName === 'BUTTON' && el.type === 'submit';
      return Boolean(submit && !el.disabled && el.closest('form'));
    })
    .catch(() => false);

/** The one element a ref or selector names. */
async function resolveElement(session, page, { ref: given, target }) {
  // P3 (run f1380230): a ref passed as target ("e130") is a ref — no CSS selector is a bare e<digits> tag name worth meaning;
  // the agent passed refs as target four times and read "No element matches" each time.
  const asRef = !given && /^e\d+$/.test(target ?? '');
  const ref = given ?? (asRef ? target : null);
  const selector = asRef ? null : target;
  // U2: the parameter is named target, not selector; a failed click cost the agent a turn each time.
  if (Boolean(ref) === Boolean(selector)) throw new Error('Pass exactly one of ref (from cor_snapshot) or target (a CSS selector; the parameter is named target, not selector).');
  if (ref) {
    checkRef(session, ref);
    // U7: a frame's ref resolves in that frame
    const handle = (await handleFromPage(targetFor(session, page, ref), 'element', { ref })).asElement();
    if (!handle) throw goneError(ref);
    return handle;
  }
  let handles;
  try {
    handles = await page.$$(selector);
  } catch (error) {
    throw new Error(`"${selector}" could not be used: ${error.message.split('\n')[0]}`);
  }
  if (handles.length === 0) throw new Error(`No element matches "${selector}" on ${page.url()}.${await frameHint(page)}`);
  if (handles.length > 1) {
    throw new Error(`"${selector}" matches ${handles.length} elements — pass the ref of the one you mean (from cor_snapshot) instead, or narrow the selector to exactly one.`);
  }
  return handles[0];
}

/**
 * Run an act and report what it did (U16 + U17): snapshot the visible
 * controls, act, settle, then re-check every ref and diff the controls.
 * A navigation ends the page the refs described — every ref expires.
 */
async function act(session, page, perform, { expectNavigation = false } = {}) {
  const navigationsBefore = session.navigations;
  await callPage(page, 'beginAct').catch(() => {});
  await perform();
  await settle(page, expectNavigation);
  if (session.navigations !== navigationsBefore) {
    // Playwright reports a pushState/hash change as a navigation, but the DOM
    // (and our injected runtime) survives it: BrowserStack's Monthly toggle
    // rewrites the URL in place. Only a new document expires the refs.
    const sameDocument = await page.evaluate(() => Boolean(window.__corMcp)).catch(() => false);
    if (!sameDocument) return { navigated: true, headings: await newPageHeadings(session, page) };
  }
  try {
    const after = await callPage(page, 'afterAct');
    session.rebindRefs(after.live, after.refs.dropped);
    return after;
  } catch {
    // The page changed under us (a late navigation): nothing to re-check — but the new page's headings are the reply.
    session.invalidateRefs('the page changed during the act');
    return { navigated: true, headings: await newPageHeadings(session, page) };
  }
}

/** The new page's first visible h1–h3 headings, each with a live ref (U20, U22). */
async function headingsWithRefs(session, page) {
  try {
    const start = session.highestRef + 1;
    const { items, live } = await callPage(page, 'headings', { start });
    if (live.length) session.issueRefs(live, { expiredBefore: start });
    return items;
  } catch {
    return [];
  }
}

/**
 * P3 (run f1380230): the new page's headings, waiting for them when the navigation lands on an interim page first —
 * BrowserStack's Choose shows "Loading https://…/orders/new" before the checkout, and the reply listed no headings, so the
 * agent wrote the checkout assertion by hand. ponytail: 5 s caps each wait; a page with no h1–h3 costs them once.
 */
async function newPageHeadings(session, page) {
  const now = await headingsWithRefs(session, page);
  if (now.length) return now;
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('h1, h2, h3', { state: 'visible', timeout: 5000 }).catch(() => {});
  return headingsWithRefs(session, page);
}

/** Run `fn(element, arg)` in the page on `handle`; throws the page-side error message if it returns one. */
async function onHandle(handle, fn, arg) {
  // Handle evaluation goes through the protocol, so a page CSP without
  // 'unsafe-eval' does not block it.
  const outcome = await handle.evaluate(fn, arg);
  if (outcome?.error) throw new Error(outcome.error);
}

function click(el) {
  el.scrollIntoView({ block: 'center' });
  el.click();
}

function fill(el, value) {
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
  } else if ('value' in el && !(el instanceof HTMLButtonElement)) {
    el.focus();
    // The prototype setter, not `el.value =`, so React's value tracker sees the change.
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  } else {
    return { error: `<${el.tagName.toLowerCase()}> does not take text — target an input, textarea, select or editable element.` };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function focus(el) {
  el.focus();
}

/** @param {ReturnType<import('../session.js').createSession>} session */
export function sessionTools(session, inspector = null, outline = null, records = null) {
  // Act tools never launch a browser onto about:blank — that only hides the missing step.
  const openPage = () => {
    if (!session.isOpen) throw new Error('No page is open — call cor_open with a URL first.');
    return session.getPage();
  };

  // P8a: the steps acted since this page was opened. An inspect records the state they reach; an act that opens another
  // document records that page's reach (this page plus the steps) and the control's leadsTo. A step names a record.
  const startTrail = (page) => { session.trail = { page: pathOf(page.url()), url: page.url(), steps: [] }; };
  // G2 (state replay): a press keeps its key apart from the item value, which a template's replay fills in.
  const stepFor = async (page, handle, action, value = null, key = null) => {
    if (!records?.enabled || !inspector) return null;
    if (session.trail?.page !== pathOf(page.url())) startTrail(page);
    let target = null;
    if (handle) try { target = await inspector({ element: handle, quiet: true }); } catch { /* not inspectable: the step names no record */ }
    return { id: target?.id ?? null, action, value: value ?? target?.value ?? null, ...(key ? { key } : {}) };
  };
  const endStep = (page, step, result) => {
    if (!step) return;
    const from = session.trail;
    if (result.navigated && pathOf(page.url()) !== from.page) {
      startTrail(page);
      records.recordReach(page.url(), from.url, [...from.steps, step]);
      if (step.id) records.leadsTo(step.id, page.url());
    } else if (result.navigated) startTrail(page); // the same page reloaded: back to as opened
    else from.steps.push(step);
  };

  /** P8b: the "already in your code" block for the page just opened, or null when no code uses a record of it. */
  const inCodeBlock = async (page) => {
    if (!records?.enabled) return null;
    const path = pathOf(recordPage(page.url()));
    if (!records.list().some((id) => { const r = records.read(id); return r && records.liveUsedIn(r).length && pathOf(r.page) === path; })) return null;
    const slug = pageSlug(page.url());
    const pages = records.listPages();
    pages[slug] ??= { page: recordPage(page.url()), reach: { open: path }, states: {} }; // version-1 records: no page file yet
    try {
      const results = await verifyPages({ context: page.context(), records, pages, slugs: [slug], here: { slug, page }, capMs: OPEN_VERIFY_MS });
      return renderInCode(results, path);
    } catch { return null; }
  };

  // U22: said once per session, the first time an act changes something.
  let hinted = false;
  const actReply = async (result, options) => {
    const body = [renderActResult(result, options), ...await actEntries(result)].join('\n');
    const changed = result.navigated || result.changes?.length || result.texts?.length || result.shownGroups?.length;
    if (!changed || hinted) return body;
    hinted = true;
    return `${body}\nAssert what this changed — the new or changed text, the URL, that gone items are no longer displayed (hidden or removed: "not displayed" holds for both) — not only that an element exists.`;
  };
  // P2a: the reply carries the entries for what the act changed or showed — new and changed text, new controls, the new
  // page's headings — so act → snapshot → inspect is one call. Elements sharing a template share one entry.
  const actEntries = async (result) => {
    if (!inspector) return [];
    const refs = result.navigated
      ? (result.headings ?? []).map((h) => h.ref)
      : [...(result.texts ?? []).map((t) => t.ref), ...(result.shownGroups ?? []).flatMap((g) => g.examples.map((e) => e.ref)),
        ...(result.changes ?? []).filter((c) => c.kind === 'appeared').flatMap((c) => c.leaves.map((l) => l.ref))];
    const targets = [...new Set(refs.filter(Boolean))].map((ref) => ({ label: ref, args: { ref } }));
    return targets.length ? ['', ...await compactEntries(inspector, targets, { max: ACT_ENTRIES })] : [];
  };

  return [
    {
      name: 'cor_open',
      config: {
        title: 'Open a page',
        description:
          'Open a URL in the COR-controlled browser. The browser starts on first use and is reused across calls. ' +
          'For a page behind a login, pass a Playwright storage-state file so the existing session is adopted. ' +
          'The reply lists the page\'s controls with refs (on a large page, a region index) — no cor_snapshot needed first — and, when the ' +
          'project\'s code already uses COR entries for this page, which members those are and whether each still finds its element.',
        inputSchema: {
          url: z.string().url().describe('Page to open.'),
          storageState: z
            .string()
            .optional()
            .describe('Path to a Playwright storage-state JSON file ({cookies, origins}) — e.g. from `npx playwright codegen --save-storage`.'),
        },
      },
      handler: async ({ url, storageState }) => {
        const page = await session.getPage({ storageState });
        // The DOM, not the load event: one hanging third-party asset holds `load` past
        // goto's 30 s and fails a page that is ready (run 69303bba, BrowserStack on a slow day).
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Client-rendered apps (React, Next) paint after the DOM; snapshotting
        // then lists nothing. Wait for the load event and then for the network to go quiet, capped.
        // ponytail: 5 s and 3 s caps; a page that never finishes just costs the caps.
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        const status = response ? ` (HTTP ${response.status()})` : '';
        startTrail(page);
        // P2a: the page's outline (or region index) comes with the open — no separate cor_snapshot turn.
        // P8b: what the repo's code already uses on this page, verified alongside the outline (R18).
        const [shown, inCode] = await Promise.all([
          outline ? outline(page).then((o) => `\n\n${o}`, () => '\n\ncor_snapshot lists the page\'s controls.') : '',
          inCodeBlock(page),
        ]);
        return text(`${await pageState(page)}${status}. Browser: ${session.browserLabel}.\n${session.frameworkLine}${inCode ? `\n\n${inCode}` : ''}${shown}`);
      },
    },
    {
      name: 'cor_click',
      config: {
        title: 'Click an element',
        description: 'Click an element to reach a page state — open a menu, go to the next step. Does not assert anything.',
        inputSchema: { ref, target },
      },
      handler: async (args) => {
        const page = await openPage();
        const handle = await resolveElement(session, page, args);
        const step = await stepFor(page, handle, 'click');
        const result = await act(session, page, () => onHandle(handle, click), { expectNavigation: await expectsNavigation(handle) });
        endStep(page, step, result);
        return text(`Clicked ${args.ref ?? args.target}. ${await pageState(page)}\n${await actReply(result)}`);
      },
    },
    {
      name: 'cor_fill',
      config: {
        title: 'Fill a field',
        description: 'Set the value of an input, textarea, select or editable element, firing input and change events.',
        inputSchema: { ref, target, value: z.string().describe('Value to set.') },
      },
      handler: async (args) => {
        const page = await openPage();
        const handle = await resolveElement(session, page, args);
        const step = await stepFor(page, handle, 'fill', args.value);
        const result = await act(session, page, () => onHandle(handle, fill, args.value));
        endStep(page, step, result);
        return text(`Filled ${args.ref ?? args.target}.\n${await actReply(result, { quietIfUnchanged: true })}`);
      },
    },
    {
      name: 'cor_press',
      config: {
        title: 'Press a key',
        description: 'Press a key, e.g. Enter, Escape, Tab, ArrowDown. With a ref or target, that element is focused first.',
        inputSchema: {
          key: z.string().min(1).describe('Key name as Playwright spells it: Enter, Escape, Tab, ArrowDown, a, Shift+Tab.'),
          ref,
          target,
        },
      },
      handler: async ({ key, ref: r, target: selector }) => {
        const page = await openPage();
        const handle = r || selector ? await resolveElement(session, page, { ref: r, target: selector }) : null;
        const step = await stepFor(page, handle, 'press', null, key);
        const result = await act(session, page, async () => {
          if (handle) await onHandle(handle, focus);
          // A real key event, so Enter submits a form and Escape closes a dialog.
          await page.keyboard.press(key);
        });
        endStep(page, step, result);
        return text(`Pressed ${key}. ${await pageState(page)}\n${await actReply(result)}`);
      },
    },
    {
      name: 'cor_close',
      config: {
        title: 'Close the browser',
        description: 'Close the browser and forget the session. The next cor_open starts a fresh one.',
        inputSchema: {},
      },
      handler: async () => {
        const wasOpen = session.isOpen;
        await session.close();
        return text(wasOpen ? 'Browser closed.' : 'No browser was open.');
      },
    },
  ];
}
