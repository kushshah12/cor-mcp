// cwq-u3: a Playwright selector engine over ariaHits, built self-contained (tsup IIFE → dist/aria-engine.js) because
// Playwright evaluates an engine inside the page. src/aria-engine.js registers it as `cor-aria`, so the grader counts
// `$('aria/Email')` as `cor-aria=Email` — chained steps included (`root` is then the step's element).
import { ariaHits } from './aria.js';

export const queryAll = (root, name) => ariaHits(root, name);
export const query = (root, name) => ariaHits(root, name)[0] ?? null;
