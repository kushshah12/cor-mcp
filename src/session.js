// One browser, one page per server process — created on first use, reused
// across calls, closed on cor_close, on idle, or when the server shuts down.

// System Chrome, then Edge, then a Playwright-bundled Chromium if one happens
// to be installed. playwright-core never downloads a browser.
export const LAUNCH_CHAIN = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];

export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

const NO_BROWSER =
  'No browser found: COR drives an installed Chrome or Edge and neither is on this machine. ' +
  'Install Google Chrome, or run `npx playwright install chromium`, then retry.';

/**
 * @param {{ headless?: boolean, idleMs?: number, launchChain?: object[] }} [options]
 */
export function createSession({ headless = false, idleMs = DEFAULT_IDLE_MS, launchChain = LAUNCH_CHAIN } = {}) {
  let browser = null;
  let context = null;
  let page = null;
  let storageStatePath = null;
  let browserLabel = null;
  let idleTimer = null;
  let queue = Promise.resolve();

  async function launch() {
    // Lazy import keeps `createServer()` free of a browser until a tool needs one.
    const { chromium } = await import('playwright-core');
    for (const option of launchChain) {
      try {
        const launched = await chromium.launch({ ...option, headless });
        browserLabel = `${option.channel ?? 'chromium'} ${launched.version()}`;
        return launched;
      } catch {
        // Not installed — try the next one.
      }
    }
    throw new Error(NO_BROWSER);
  }

  function reset() {
    browser = context = page = null;
    clearTimeout(idleTimer);
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close().catch(() => {}), idleMs);
    idleTimer.unref(); // an idle timer must never keep the process alive
  }

  /**
   * The live page, launching the browser if needed. Passing a storage-state
   * path different from the current one starts a fresh context with it —
   * cookies and localStorage belong to the context, not the page.
   * @param {{ storageState?: string }} [options]
   */
  function getPage(options) {
    // Serialised: two tool calls arriving together must not launch two browsers.
    const run = queue.then(() => openPage(options));
    queue = run.catch(() => {});
    return run;
  }

  async function openPage({ storageState } = {}) {
    // Also true after the user closes a headed window or Chrome crashes: the
    // next call relaunches instead of wedging on a dead browser.
    if (!browser?.isConnected()) {
      reset();
      browser = await launch();
    }
    if (context && storageState && storageState !== storageStatePath) {
      await context.close();
      context = page = null;
    }
    if (!context) {
      context = await browser.newContext(storageState ? { storageState } : {});
      storageStatePath = storageState ?? null;
    }
    if (!page || page.isClosed()) page = await context.newPage();
    touch(); // after reset() above, which clears the timer
    return page;
  }

  async function close() {
    const open = browser;
    reset();
    storageStatePath = null;
    if (open) await open.close();
  }

  return {
    getPage,
    close,
    get browser() { return browser; },
    get browserLabel() { return browserLabel; },
    get isOpen() { return Boolean(browser?.isConnected()); },
  };
}
