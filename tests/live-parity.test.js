// Opt-in, network-bound: COR_LIVE=1 npm test
//
// The acceptance test for approach A (U13): for every element the outline
// lists on real pages, Playwright's own getByRole(role, { name, exact }) must
// find it by the role and name COR shows. Before the engine's accessible-name
// fix (engine 844e4c8) this failed on 12 of 363 elements; after, 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';

const PAGES = [
  'https://www.browserstack.com/pricing',
  'https://selectorshub.com/xpath-practice-page/',
  'https://www.bstackdemo.com/',
];
const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'textbox',
  'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox', 'menuitemcheckbox', 'menuitemradio']);

test('live parity: Playwright finds every outlined element by the role and name COR shows', { skip: !process.env.COR_LIVE }, async (t) => {
  const session = createSession({ headless: true });
  t.after(() => session.close());
  const page = await session.getPage();
  const mismatches = [];
  let clickables = 0;
  for (const url of PAGES) {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    const { tree } = await callPage(page, 'snapshot');
    const leaves = [];
    const walk = (nodes) => nodes.forEach((n) => (n.kind === 'leaf' ? leaves.push(n) : walk(n.children)));
    walk(tree);
    for (const leaf of leaves.filter((l) => ROLES.has(l.role))) {
      const clipped = leaf.name.endsWith('…');
      const options = leaf.name ? { name: clipped ? leaf.name.slice(0, -1) : leaf.name, exact: !clipped } : {};
      const handle = await page.evaluateHandle((ref) => window.__corMcp.element({ ref }), leaf.ref);
      // A hidden input shown by its label is out of the accessibility tree; getByLabel reaches it.
      const found = leaf.viaLabel
        ? await page.getByLabel(leaf.name, { exact: true }).evaluateAll((els, el) => els.includes(el), handle)
        : await page.getByRole(leaf.role, options).evaluateAll((els, el) => els.includes(el), handle);
      if (!found) mismatches.push(`${url} ${leaf.role} "${leaf.name}"`);
    }
    // A clickable has no role to query by; Playwright reaches it by its text.
    for (const leaf of leaves.filter((l) => l.role === 'clickable' && !l.name.endsWith('…'))) {
      const handle = await page.evaluateHandle((ref) => window.__corMcp.element({ ref }), leaf.ref);
      // getByText returns the smallest element with the text; a click there is a click on the clickable.
      const byText = await page.getByText(leaf.name, { exact: true }).evaluateAll((els, el) => els.some((e) => el.contains(e)), handle);
      const byLabel = await page.getByLabel(leaf.name, { exact: true }).evaluateAll((els, el) => els.includes(el), handle);
      if (!byText && !byLabel) mismatches.push(`${url} clickable "${leaf.name}"`);
      clickables += 1;
    }
  }
  t.diagnostic(`clickables checked: ${clickables}`);
  assert.deepEqual(mismatches, []);
});
