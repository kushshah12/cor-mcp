import { readFileSync } from 'node:fs';

const BUNDLE = new URL('../dist/page.js', import.meta.url);
let source = null;

function bundle() {
  if (source === null) {
    try {
      source = readFileSync(BUNDLE, 'utf8');
    } catch {
      throw new Error('The in-page engine bundle is missing (dist/page.js). Run `npm run build` in packages/mcp.');
    }
  }
  return source;
}

/**
 * Call `window.__corMcp[fn](arg)` in the page, injecting the engine first if
 * this document does not have it yet. Injected on demand rather than as an
 * init script, so pages the agent only passes through never run it.
 * `page.evaluate` goes through the protocol, so a page CSP cannot block it.
 */
export async function callPage(page, fn, arg) {
  await ensureInjected(page);
  return page.evaluate(([name, value]) => window.__corMcp[name](value), [fn, arg]);
}

/** Like callPage, but returns a JSHandle — for handing an element to an act tool. */
export async function handleFromPage(page, fn, arg) {
  await ensureInjected(page);
  return page.evaluateHandle(([name, value]) => window.__corMcp[name](value), [fn, arg]);
}

async function ensureInjected(page) {
  if (!(await page.evaluate(() => Boolean(window.__corMcp)))) await page.evaluate(bundle());
}
