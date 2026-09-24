import { z } from 'zod';
import { handleFromPage } from '../page-runtime.js';
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
// DOM of the new page. A slower client-side transition lands after we return;
// the agent sees the old state and acts again. Raise if agents report that.
async function settle(page) {
  await page
    .waitForEvent('framenavigated', { timeout: 500 })
    .then(() => page.waitForLoadState('domcontentloaded'))
    .catch(() => {});
}

/** Run `fn(element, arg)` in the page on the one element a ref or selector names. */
async function onElement(session, page, { ref, target: selector }, fn, arg) {
  if (Boolean(ref) === Boolean(selector)) throw new Error('Pass exactly one of ref (from cor_snapshot) or target (a CSS selector).');
  let handle;
  if (ref) {
    checkRef(session, ref);
    handle = (await handleFromPage(page, 'element', { ref })).asElement();
    if (!handle) throw goneError(ref);
  } else {
    let handles;
    try {
      handles = await page.$$(selector);
    } catch (error) {
      throw new Error(`"${selector}" could not be used: ${error.message.split('\n')[0]}`);
    }
    if (handles.length === 0) throw new Error(`No element matches "${selector}" on ${page.url()}.`);
    if (handles.length > 1) {
      throw new Error(`"${selector}" matches ${handles.length} elements — narrow it to exactly one before acting.`);
    }
    [handle] = handles;
  }
  // Handle evaluation goes through the protocol, so a page CSP without
  // 'unsafe-eval' does not block it.
  const outcome = await handle.evaluate(fn, arg);
  // Any act ends the page state the refs described, whether or not it visibly changed anything.
  session.invalidateRefs(`a ${ref ?? selector} act call changed the page`);
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
        const response = await page.goto(url, { waitUntil: 'load' });
        // Client-rendered apps (React, Next) paint after `load`; snapshotting
        // then lists nothing. Wait for the network to go quiet, capped.
        // ponytail: 3 s cap; a page that polls forever just costs the cap.
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        const status = response ? ` (HTTP ${response.status()})` : '';
        return text(`${await pageState(page)}${status}. Browser: ${session.browserLabel}.`);
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
        await onElement(session, page, args, click);
        await settle(page);
        return text(`Clicked ${args.ref ?? args.target}. ${await pageState(page)}`);
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
        await onElement(session, page, args, fill, args.value);
        return text(`Filled ${args.ref ?? args.target}.`);
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
        if (r || selector) await onElement(session, page, { ref: r, target: selector }, focus);
        // A real key event, so Enter submits a form and Escape closes a dialog.
        await page.keyboard.press(key);
        session.invalidateRefs(`pressing ${key} changed the page`);
        await settle(page);
        return text(`Pressed ${key}. ${await pageState(page)}`);
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
