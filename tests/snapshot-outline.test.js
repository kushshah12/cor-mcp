import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { callPage } from '../src/page-runtime.js';
import { expandGroups } from './helpers/outline.js';

let base;
const site = createHttpServer((req, res) => {
  let html;
  try {
    html = readFileSync(new URL(`./fixtures/${req.url.slice(1)}`, import.meta.url));
  } catch {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
const session = createSession({ headless: true });
let client;

before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer({ session }).connect(serverSide), client.connect(clientSide)]);
});
after(async () => {
  await client.close();
  await session.close();
  site.close();
});

const call = async (name, args = {}) => expandGroups((await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n'));

/** Each element line with its full path: `table › row "Alice" › button "Edit" [ref=e5]`. */
function paths(text) {
  const stack = [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^( *)- (.*)$/.exec(line);
    if (!m) continue;
    stack.length = m[1].length / 2;
    stack.push(m[2]);
    if (/\[ref=e\d+\]/.test(m[2])) out.push(stack.join(' › '));
  }
  return out;
}
const snapshotOf = async (page) => {
  await call('cor_open', { url: `${base}/${page}` });
  const text = await call('cor_snapshot');
  return { text, lines: paths(text).map((l) => l.replace(/ \[ref=e\d+\]/, '')) };
};

// ── U13: structure ──────────────────────────────────────────────────────────
test('landmarks, sections, table rows, groups, dialogs and shadow roots each nest what identifies them', async () => {
  const { lines } = await snapshotOf('outline.html');
  assert.deepEqual(lines, [
    'header › navigation "Main" › link "Home"',
    'header › navigation "Main" › link "Docs"',
    'button "Deep"',
    'section "Account" › button "Log out"',
    'table › row "Alice" › button "Edit"',
    'table › row "Bob" › button "Edit"',
    'group "Shipping" › radio "Standard" [checked]',
    'group "Shipping" › radio "Express"',
    'button "Pay" [disabled]',
    'button "Menu" [expanded]',
    'tab "One" [selected]',
    'tab "Two"',
    'dialog "Confirm" › button "OK"',
    'button "Shadow action"',
    'section "Starter" › button "Pick"',
    'button "Pick"',
    'table › column "Basic" › button "Choose plan"',
    'button "Select Automate" in "Web"',
    'button "Select Live" in "Web"',
    'button "Select Automate" in "Mobile"',
    'button "Select Live" in "Mobile"',
    'footer › link "Terms"',
  ]);
});

test('prose and anonymous wrappers never produce lines', async () => {
  const { text } = await snapshotOf('outline.html');
  assert.doesNotMatch(text, /Lorem|Signed in as/);
  assert.doesNotMatch(text, /- div\b/, 'the four-deep div chain collapses to the button');
});

test('a chain of single-child containers folds into one line; a container with several children nests them', async () => {
  const { text } = await snapshotOf('outline.html');
  assert.match(text, /^- section "Account" › button "Log out" \[ref=e\d+\]$/m, 'folded');
  assert.match(text, /^- header › navigation "Main"\n  - link "Home" \[ref=e\d+\]\n  - link "Docs" \[ref=e\d+\]$/m, 'nested');
  assert.doesNotMatch(text, /Example Store/, "the page's <h1> is not a section");
});

test('the outline is a fraction of Playwright\'s ariaSnapshot()', async () => {
  const sizes = {};
  for (const page of ['prose.html', 'pricing.html', 'traps.html', 'outline.html']) {
    const { text } = await snapshotOf(page);
    const aria = await (await session.getPage()).locator('body').ariaSnapshot();
    // The tree against the tree: the header and legend are a fixed cost per snapshot.
    const body = text.split('\n\n').slice(1).join('\n\n');
    sizes[page] = Number((body.length / aria.length).toFixed(2));
  }
  // Prose-heavy pages are where Playwright's tree balloons; the live
  // BrowserStack page measured 23% (12,054 vs 52,206 chars) with the legend.
  assert.ok(sizes['prose.html'] < 0.1, JSON.stringify(sizes));
  // Control-dense fixtures cost about what Playwright's tree does — refs and
  // markers are on every line — and never more than a third over.
  for (const [page, ratio] of Object.entries(sizes)) assert.ok(ratio < 1.35, `${page}: ${JSON.stringify(sizes)}`);
});

// ── U14: signals only COR has ───────────────────────────────────────────────
test('hidden lookalikes are counted on the visible line and never listed', async () => {
  const { lines } = await snapshotOf('pricing.html');
  const chooses = lines.filter((l) => l.includes('"Choose"'));
  assert.equal(chooses.length, 2, 'the hidden copy has no line of its own');
  assert.ok(chooses.every((l) => l.endsWith('+1 hidden')));
});

test('markers add nothing to lines they do not apply to', async () => {
  const { lines } = await snapshotOf('outline.html');
  assert.ok(lines.includes('button "Deep"'));
  assert.ok(lines.includes('tab "Two"'));
});

// ── approach A's risk, as a test ────────────────────────────────────────────
const ARIA_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'textbox',
  'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox', 'menuitemcheckbox', 'menuitemradio']);

test('parity: Playwright\'s own getByRole finds every listed element by the role and name COR shows', async () => {
  const mismatches = [];
  for (const file of ['outline.html', 'pricing.html', 'traps.html', 'shapes.html']) {
    await call('cor_open', { url: `${base}/${file}` });
    const page = await session.getPage();
    const { tree } = await callPage(page, 'snapshot');
    const leaves = [];
    const walk = (nodes) => nodes.forEach((n) => (n.kind === 'leaf' ? leaves.push(n) : walk(n.children)));
    walk(tree);
    for (const leaf of leaves) {
      if (!ARIA_ROLES.has(leaf.role)) continue;
      const clipped = leaf.name.endsWith('…');
      const options = leaf.name ? { name: clipped ? leaf.name.slice(0, -1) : leaf.name, exact: !clipped } : {};
      const handle = await page.evaluateHandle((ref) => window.__corMcp.element({ ref }), leaf.ref);
      const found = await page.getByRole(leaf.role, options).evaluateAll((els, el) => els.includes(el), handle);
      if (!found) mismatches.push(`${file}: ${leaf.role} "${leaf.name}" [${leaf.ref}]`);
    }
  }
  assert.deepEqual(mismatches, []);
});
