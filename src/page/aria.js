// cwq-u3: WebdriverIO's `aria/<name>` semantics in one place. The page bundle (params.js, which decides whether an
// `aria/` helper is safe to issue) and the grader's selector engine (aria-engine.js, which counts an `aria/` locator a
// user wrote) both read this, so what COR issues and what COR verifies cannot drift apart.
import { HEADING, isControl, roleAndName, squash } from './dom.js';

/**
 * The elements WebdriverIO's `aria/<name>` finds under `root` (measured on 9.32, scripts/conformance): controls answering to
 * the name — hidden ones too — and elements with a role of their own (a heading) or an aria-label / title / placeholder equal
 * to it. Plain text (<p>, <span>) is found only when no control answers, so it is not counted here.
 */
export function ariaHits(root, name) {
  return [...root.querySelectorAll('*')].filter((el) => {
    if (isControl(el)) return squash(roleAndName(el).name) === name;
    const named = ['aria-label', 'title', 'placeholder'].some((a) => el.getAttribute(a) === name);
    return named || ((el.matches(HEADING) || el.hasAttribute('role')) && squash(roleAndName(el).name) === name);
  });
}
