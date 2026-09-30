// A "no element" error on a page with iframes may just mean the element is inside one.
import { callPage } from './page-runtime.js';
import { framesNote } from './format.js';

/** The sentence to append to a not-found message, or ''. */
export async function frameHint(page) {
  const frames = await callPage(page, 'frames').catch(() => []);
  return frames.length ? ` ${framesNote(frames)[0]}` : '';
}
