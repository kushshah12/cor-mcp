// U7: iframes. The page outline reads each visible frame with the same in-page engine as the top document, so a control
// inside a frame gets a ref, an entry, and a grade. Each frame has its own in-page ref map; the session records which
// frame issued each ref, and inspect and act calls resolve it there.
import { callPage } from './page-runtime.js';
import { goneError } from './tools/refs.js';

/** The sentence to append to a not-found message, or ''. Frame refs are reachable only through a ref, not a selector. */
export async function frameHint(page) {
  const frames = await callPage(page, 'frames').catch(() => []);
  return frames.length ? ' Some controls are in iframes: pass a ref from cor_snapshot for them.' : '';
}

/** Visible frames under `page`, flat (nested frames included), each with the label and origin the outline names it by. */
async function visibleFrames(page) {
  const main = page.mainFrame();
  const out = [];
  for (const frame of page.frames()) {
    if (frame === main || frame.isDetached()) continue;
    const element = await frame.frameElement().catch(() => null);
    if (!element || !(await element.isVisible().catch(() => false))) {
      await element?.dispose();
      continue;
    }
    const attrs = await element.evaluate((e) => ({
      title: e.title || e.getAttribute('aria-label') || '',
      name: e.name || '',
      // A sandbox without allow-same-origin gives the frame an opaque origin, so it is another site whatever its URL says.
      sandboxed: e.hasAttribute('sandbox') && !/allow-same-origin/.test(e.getAttribute('sandbox')),
    }));
    const origin = await frame.evaluate(() => location.origin).catch(() => 'null');
    const sameOrigin = !attrs.sandboxed && origin === new URL(page.url()).origin;
    out.push({ frame, element, label: attrs.title || attrs.name || 'unnamed', sameOrigin });
  }
  return out;
}

/**
 * U7: each visible frame's own outline, with its refs recorded in `session` (after the top document's). Returns the frames
 * that have controls (`sections`, rendered by the caller) and the frames that could not be read (`unread`, for the
 * page outline's "Not listed" line).
 * @returns {Promise<{ sections: { frame, label, sameOrigin, snapshot }[], unread: { label: string, sameOrigin: boolean }[] }>}
 */
export async function readFrames(session, page) {
  const sections = [];
  const unread = [];
  for (const { frame, element, label, sameOrigin } of await visibleFrames(page)) {
    const snapshot = await callPage(frame, 'snapshot', { start: session.highestRef + 1 }).catch(() => null);
    await element.dispose();
    if (!snapshot) {
      unread.push({ label, sameOrigin });
      continue;
    }
    session.addFrameRefs(snapshot.live, frame);
    if (snapshot.count > 0) sections.push({ frame, label, sameOrigin, snapshot });
  }
  return { sections, unread };
}

/** Which page context resolves `ref`: its frame, or the page. Throws the "changed since the snapshot" error for a gone frame. */
export function targetFor(session, page, ref) {
  const frame = ref ? session.frameFor(ref) : null;
  if (!frame) return page;
  if (frame.isDetached()) throw goneError(ref);
  return frame;
}

/**
 * U7 (Playwright only): the `page.frameLocator(…)` chain that reaches `frame`, so an entry for a control inside it runs
 * from the test's page. Each step names its iframe by title, then name, then id, else by its index among the iframes.
 */
export async function frameLocatorPrefix(frame) {
  const chain = [];
  for (let f = frame; f.parentFrame(); f = f.parentFrame()) chain.unshift(f);
  const steps = [];
  for (const f of chain) {
    const element = await f.frameElement();
    const attrs = await element.evaluate((e) => ({
      title: e.getAttribute('title'),
      name: e.getAttribute('name'),
      id: e.id,
      index: [...e.ownerDocument.querySelectorAll('iframe,frame')].indexOf(e),
    }));
    await element.dispose();
    steps.push(frameLocatorStep(attrs));
  }
  return `page.${steps.join('.')}.`;
}

function frameLocatorStep({ title, name, id, index }) {
  const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (title && !title.includes('"') && !title.includes(']')) return `frameLocator(${quote(`iframe[title="${title}"]`)})`;
  if (name && !name.includes('"') && !name.includes(']')) return `frameLocator(${quote(`iframe[name="${name}"]`)})`;
  if (id && /^[\w-]+$/.test(id)) return `frameLocator(${quote(`#${id}`)})`;
  return `frameLocator('iframe').nth(${index})`;
}
