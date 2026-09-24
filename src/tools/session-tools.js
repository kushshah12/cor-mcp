import { z } from 'zod';

// Act tools only reach a page state so an element can be inspected; nothing
// here asserts. So they use raw DOM calls through evaluate rather than
// Playwright's actionability checks (visible, stable, enabled, not covered).
// A click that does not land shows up as the element still being absent,
// which the agent sees and retries.

const target = z.string().min(1).describe('CSS selector for the element. Must match exactly one element.');

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

/** Run `fn(element, arg)` in the page on the single element `selector` names. */
async function onElement(page, selector, fn, arg) {
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
  // Handle evaluation goes through the protocol, so a page CSP without
  // 'unsafe-eval' does not block it.
  const outcome = await handles[0].evaluate(fn, arg);
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
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const status = response ? ` (HTTP ${response.status()})` : '';
        return text(`${await pageState(page)}${status}. Browser: ${session.browserLabel}.`);
      },
    },
    {
      name: 'cor_click',
      config: {
        title: 'Click an element',
        description: 'Click an element to reach a page state — open a menu, go to the next step. Does not assert anything.',
        inputSchema: { target },
      },
      handler: async ({ target: selector }) => {
        const page = await openPage();
        await onElement(page, selector, click);
        await settle(page);
        return text(`Clicked ${selector}. ${await pageState(page)}`);
      },
    },
    {
      name: 'cor_fill',
      config: {
        title: 'Fill a field',
        description: 'Set the value of an input, textarea, select or editable element, firing input and change events.',
        inputSchema: { target, value: z.string().describe('Value to set.') },
      },
      handler: async ({ target: selector, value }) => {
        const page = await openPage();
        await onElement(page, selector, fill, value);
        return text(`Filled ${selector}.`);
      },
    },
    {
      name: 'cor_press',
      config: {
        title: 'Press a key',
        description: 'Press a key, e.g. Enter, Escape, Tab, ArrowDown. With a target, that element is focused first.',
        inputSchema: {
          key: z.string().min(1).describe('Key name as Playwright spells it: Enter, Escape, Tab, ArrowDown, a, Shift+Tab.'),
          target: target.optional(),
        },
      },
      handler: async ({ key, target: selector }) => {
        const page = await openPage();
        if (selector) await onElement(page, selector, focus);
        // A real key event, so Enter submits a form and Escape closes a dialog.
        await page.keyboard.press(key);
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
