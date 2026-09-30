import { frameHint } from '../frames.js';
import { z } from 'zod';
import { callPage, handleFromPage } from '../page-runtime.js';
import { renderActResult } from '../format.js';
import { checkRef, goneError } from './refs.js';

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
async function resolveElement(session, page, { ref, target: selector }) {
  if (Boolean(ref) === Boolean(selector)) throw new Error('Pass exactly one of ref (from cor_snapshot) or target (a CSS selector).');
  if (ref) {
    checkRef(session, ref);
    const handle = (await handleFromPage(page, 'element', { ref })).asElement();
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
    throw new Error(`"${selector}" matches ${handles.length} elements — narrow it to exactly one before acting.`);
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
    if (!sameDocument) return { navigated: true, headings: await headingsWithRefs(session, page) };
  }
  try {
    const after = await callPage(page, 'afterAct');
    session.rebindRefs(after.live, after.refs.dropped);
    return after;
  } catch {
    // The page changed under us (a late navigation): nothing to re-check.
    session.invalidateRefs('the page changed during the act');
    return { navigated: true };
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
export function sessionTools(session) {
  // Act tools never launch a browser onto about:blank — that only hides the missing step.
  const openPage = () => {
    if (!session.isOpen) throw new Error('No page is open — call cor_open with a URL first.');
    return session.getPage();
  };

  // U22: said once per session, the first time an act changes something.
  let hinted = false;
  const actReply = (result) => {
    const body = renderActResult(result);
    const changed = result.navigated || result.changes?.length || result.texts?.length || result.shownGroups?.length;
    if (!changed || hinted) return body;
    hinted = true;
    return `${body}\nAssert what this changed — the new or changed text, the URL, that gone items are no longer displayed (hidden or removed: "not displayed" holds for both) — not only that an element exists.`;
  };

  return [
    {
      name: 'cor_open',
      config: {
        title: 'Open a page',
        description:
          'Open a URL in the COR-controlled browser. The browser starts on first use and is reused across calls. ' +
          'For a page behind a login, pass a Playwright storage-state file so the existing session is adopted.',
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
        return text(`${await pageState(page)}${status}. Browser: ${session.browserLabel}.\n${session.frameworkLine}`);
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
        const result = await act(session, page, () => onHandle(handle, click), { expectNavigation: await expectsNavigation(handle) });
        return text(`Clicked ${args.ref ?? args.target}. ${await pageState(page)}\n${actReply(result)}`);
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
        const result = await act(session, page, () => onHandle(handle, fill, args.value));
        return text(`Filled ${args.ref ?? args.target}.\n${actReply(result)}`);
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
        const result = await act(session, page, async () => {
          if (handle) await onHandle(handle, focus);
          // A real key event, so Enter submits a form and Escape closes a dialog.
          await page.keyboard.press(key);
        });
        return text(`Pressed ${key}. ${await pageState(page)}\n${actReply(result)}`);
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
