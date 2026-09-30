import { detectFramework, frameworkLine } from './detect.js';

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
 * @param {{ headless?: boolean, idleMs?: number, launchChain?: object[], cwd?: string }} [options]
 */
export function createSession({ headless = false, idleMs = DEFAULT_IDLE_MS, launchChain = LAUNCH_CHAIN, cwd = process.cwd() } = {}) {
  let browser = null;
  let context = null;
  let page = null;
  let storageStatePath = null;
  let browserLabel = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  // What the last cor_snapshot issued. Refs name elements in one page state;
  // any navigation or act call ends that state and they must not be resolved.
  let refs = null; // { issued: Set<ref>, staleBecause, dropped: { ref: reason } }
  let navigations = 0; // main-frame navigations, so an act can tell it navigated

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

  // P1a: the project's test framework — read from package.json once per session; an
  // agent's `framework` argument wins and sticks.
  let detection = null;
  let chosen = null;

  let highestRef = 0;
  const note = (live) => { for (const r of live) highestRef = Math.max(highestRef, Number(r.slice(1))); };

  function invalidateRefs(reason) {
    if (refs && !refs.staleBecause) refs.staleBecause = reason;
  }

  function reset() {
    browser = context = page = null;
    refs = null;
    detection = chosen = null;
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
    if (!page || page.isClosed()) {
      const opened = await context.newPage();
      opened.on('framenavigated', (frame) => {
        if (frame === opened.mainFrame()) {
          navigations++;
          invalidateRefs('the page navigated');
        }
      });
      page = opened;
    }
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
    /** The framework to render for: the argument, else the session's, else the detected one, else null (callers render Playwright). */
    resolveFramework(argument) {
      if (argument) chosen = argument;
      return chosen ?? this.detection.framework;
    },
    get detection() { return (detection ??= detectFramework(cwd)); },
    get frameworkLine() { return frameworkLine(this.detection, chosen); },
    invalidateRefs,
    /** The refs the page now resolves — the whole set, after a full or scoped snapshot. */
    issueRefs(live, { expiredBefore = null } = {}) {
      note(live);
      refs = { issued: new Set(live), staleBecause: null, dropped: {}, expiredBefore };
    },
    /** The highest ref number issued on any page so far: a new document numbers from here, so an old ref never names a new element. */
    get highestRef() { return highestRef; },
    /** After an act (U16): the page's re-checked live set, plus why any ref was dropped. */
    rebindRefs(live, dropped) {
      note(live);
      refs = { issued: new Set(live), staleBecause: null, dropped: { ...(refs?.dropped ?? {}), ...dropped } };
    },
    get navigations() { return navigations; },
    get refs() { return refs; },
    get browser() { return browser; },
    get browserLabel() { return browserLabel; },
    get isOpen() { return Boolean(browser?.isConnected()); },
  };
}
