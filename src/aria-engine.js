// cwq-u3: registers the `cor-aria` selector engine (dist/aria-engine.js) with Playwright, once per process.
// Playwright's selectors are process-wide and `register` throws on a second call with the same name, so the
// registration is remembered here; session.openPage calls this beside setTestIdAttribute.
import { readFileSync } from 'node:fs';

const BUNDLE = new URL('../dist/aria-engine.js', import.meta.url);
export const ARIA_ENGINE = 'cor-aria';
let registered = null;

export function registerAriaEngine(selectors) {
  registered ??= (async () => {
    let code;
    try {
      code = readFileSync(BUNDLE, 'utf8');
    } catch {
      throw new Error('The aria selector engine bundle is missing (dist/aria-engine.js). Run `npm run build`.');
    }
    const content = `(() => { ${code}\nreturn { query: __corAria.query, queryAll: __corAria.queryAll }; })()`;
    try {
      await selectors.register(ARIA_ENGINE, { content });
    } catch (err) {
      if (!/already registered/i.test(err.message)) throw err;
    }
  })().catch((err) => { registered = null; throw err; }); // a failed registration is retried on the next page
  return registered;
}
