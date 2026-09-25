// State-bound elements. Runs in the page.
//
// Found in an agent run on bstackdemo.com (2026-09-25): the agent inspected the
// cart badge with the cart closed and got a locator that matched nothing once
// the cart opened — the header badge (`span.bag.bag--float-cart-closed`) is
// removed on open. No locator survives its element being removed. What COR can
// say is that the element belongs to a UI state (it carries a state class,
// or sits under one), and point at the twin that shows the same value without
// one: the float cart's own badge, present in both states.
import { classifyClass } from '@corlabs/engine/scoring';
import { squash } from './dom.js';

const ANCESTORS = 3;

const stateClasses = (el) => [...(el.classList ?? [])].filter((c) => classifyClass(c) === 'state');
const plainClasses = (el) => [...(el.classList ?? [])].filter((c) => classifyClass(c) !== 'state');

/** The state class the element or one of its nearest ancestors carries, and on which node. */
function stateMark(el) {
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && node !== document.body && depth <= ANCESTORS; depth++, node = node.parentElement) {
    const [cls] = stateClasses(node);
    if (cls) return { cls, node };
  }
  return null;
}

/**
 * The state class and the twin — same tag, same non-state classes, same text,
 * no state class of its own or on its nearest ancestors — or null. Only with a
 * twin: a state class alone (a nav item's `active`) is too common to warn on,
 * and without a twin there is nothing to do differently.
 */
export function stateBound(el) {
  const mark = stateMark(el);
  if (!mark) return null;
  const text = squash(el.textContent);
  const classes = plainClasses(el);
  if (!classes.length) return null; // nothing to recognise a twin by
  const same = (o) => o !== el && !o.contains(el) && !el.contains(o)
    && squash(o.textContent) === text
    && classes.every((c) => o.classList.contains(c))
    && plainClasses(o).length === classes.length
    && !stateMark(o);
  const twins = [...document.getElementsByTagName(el.tagName)].filter(same);
  return twins.length === 1 ? { stateClass: mark.cls, twin: twins[0] } : null;
}
