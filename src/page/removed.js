// Elements an act removed, remembered for the life of the document. Runs in
// the page.
//
// Found in an agent run on bstackdemo.com (2026-09-25): after a click opened
// the cart, the agent inspected the count badge and COR called
// `span.bag__quantity` unique — true then, because the click had removed the
// header's badge. Close the cart and the header badge is back: 2 matches, a
// strict-mode failure. A hidden element needs no memory (it is still in the
// DOM and counted); a removed one is invisible to every count. So each act's
// removed controls are kept, and a locator that would also match one of them
// is unique only in this state.
import { classifyClass } from '@corlabs/engine/scoring';
import { isUnstableClass } from '@corlabs/engine/core';

const MAX = 50;
const removed = []; // { el, what } — detached nodes, newest last

/** Called by endAct for each control the act removed from the document. */
export function rememberRemoved(el, what) {
  removed.push({ el, what });
  if (removed.length > MAX) removed.shift();
}

/** Plain CSS only: engine-native chains (`>>`, role=, text=) and XPath cannot be tested on a detached node. */
const isCss = (value) => !/>>|^(role|text|internal|xpath)=|^\/\/|^\(/.test(value);

/** What a removed element (or something inside it) that `css` matches was, else null. */
export function removedMatch(css) {
  if (!isCss(css)) return null;
  for (let i = removed.length - 1; i >= 0; i--) {
    const { el, what } = removed[i];
    try {
      if (el.matches(css) || el.querySelector(css)) return what;
    } catch {
      return null;
    }
  }
  return null;
}

const ANCESTORS = 6;

/**
 * `css` scoped by the nearest ancestor of `target` that exists in both states:
 * the result matches only the target now and nothing that was removed.
 */
export function saferScope(target, css) {
  let node = target.parentElement;
  for (let depth = 0; node && node !== document.body && depth < ANCESTORS; depth++, node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const names = [...node.classList].filter((c) => !isUnstableClass(c) && classifyClass(c) !== 'state').map((c) => `${tag}.${CSS.escape(c)}`);
    for (const anchor of names) {
      const sel = `${anchor} ${css}`;
      let hits;
      try {
        hits = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      if (hits.length === 1 && hits[0] === target && !removedMatch(sel)) return sel;
    }
  }
  return null;
}

// P6 (R8): controls whose accessible name an act changed ("Cart, empty" → "Cart, 1 item", "Add to cart" → "Remove"),
// remembered for the life of the document — a locator on the name finds the element in one state only.
const renamed = new WeakMap(); // el → every name it has had, oldest first

/** Called by endAct when an act changed a control's name. */
export function rememberRenamed(el, was, is) {
  const names = renamed.get(el) ?? [was];
  if (names[names.length - 1] !== is) names.push(is);
  renamed.set(el, names.slice(-4));
}

/** The names this element has had in this document, or null when an act never changed it. */
export const namesOf = (el) => renamed.get(el) ?? null;
