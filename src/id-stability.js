// Does an id that ends in a number survive a reload?
//
// The engine's numbered-id rule has to decide from one DOM whether `shub63` is
// a name or a counter, and a lone stem+number id with no peers looks like a
// name. selectorshub proves otherwise: its Email field is shub58, shub31, shub43
// on three loads. One DOM cannot tell those apart — a second load can. So when
// a locator we are about to hand over rests on such an id, load the URL once
// more in a separate tab and look.

// `#shub63`, `[id="shub63"]`, `@id="shub63"` / `@id='shub63'`
const ID_PATTERNS = [/#([A-Za-z_][\w-]*?\d+)(?![\w-])/g, /\[id=["']([^"']*\d)["']\]/g, /@id=["']([^"']*\d)["']/g];

/** Ids ending in a digit that a locator string depends on. */
export function numberedIds(value) {
  const ids = new Set();
  for (const pattern of ID_PATTERNS) {
    for (const m of String(value ?? '').matchAll(pattern)) ids.add(m[1]);
  }
  return [...ids];
}

const stem = (id) => id.replace(/\d+$/, '');

/**
 * Load `url` in a separate page of the same context and classify each id:
 *   stable      — present again
 *   regenerated — absent, but the same kind of element carries stem+other digits
 *   unconfirmed — absent with nothing to compare (it may only exist in some page state)
 * The agent's page — its state and its refs — is not touched.
 *
 * @param {import('playwright-core').Page} page  the agent's page (its URL, its context, the ids' tags)
 * @param {string[]} idList
 * @param {Map<string, object>} cache  per-session, keyed by url + id
 * @returns {Promise<Map<string, { status: string, seen?: string }>>}
 */
export async function checkIds(page, idList, cache) {
  const results = new Map();
  const url = page.url();
  if (!idList.length || !/^https?:/.test(url)) return results;
  // The tag lets a regenerated id be told from an unrelated element sharing the stem.
  const ids = await page.evaluate(
    (list) => list.map((id) => ({ id, tag: document.getElementById(id)?.tagName.toLowerCase() ?? '' })),
    idList,
  );
  const todo = ids.filter(({ id }) => {
    const hit = cache.get(`${url}#${id}`);
    if (hit) results.set(id, hit);
    return !hit;
  });
  if (!todo.length) return results;

  // ponytail: one extra page load per URL with numbered ids; cached for the session.
  const probe = await page.context().newPage();
  try {
    await probe.goto(url, { waitUntil: 'load' });
    await probe.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    const found = await probe.evaluate(
      (items) => items.map(({ id, tag, stem }) => {
        if (document.getElementById(id)) return { id, status: 'stable' };
        const twin = [...document.querySelectorAll(`${tag}[id^="${CSS.escape(stem)}"]`)]
          .find((el) => /^\d+$/.test(el.id.slice(stem.length)));
        return twin ? { id, status: 'regenerated', seen: twin.id } : { id, status: 'unconfirmed' };
      }),
      todo.map(({ id, tag }) => ({ id, tag, stem: stem(id) })),
    );
    for (const { id, ...verdict } of found) {
      cache.set(`${url}#${id}`, verdict);
      results.set(id, verdict);
    }
  } catch {
    // A failed probe proves nothing either way; leave the ids unjudged.
  } finally {
    await probe.close().catch(() => {});
  }
  return results;
}

/**
 * Mark locators whose id did not survive a reload, and move them after every
 * other candidate — the engine's score is untouched; this is ordering plus a
 * warning, the same way resolvability orders without rescoring.
 * Returns the demoted top-scorer, if the order changed because of it.
 */
export function applyIdVerdicts(locators, verdicts) {
  for (const l of locators) {
    for (const id of numberedIds(l.value)) {
      const v = verdicts.get(id);
      if (v?.status === 'regenerated') {
        l.volatileId = { id, seen: v.seen };
        (l.warnings ??= []).unshift(`Its id changes on every page load (${id} was ${v.seen} on a fresh load) — breaks on the next load`);
      } else if (v?.status === 'unconfirmed') {
        (l.warnings ??= []).push(`Could not confirm id ${id} survives a reload — it was not on a fresh load of this URL`);
      }
    }
  }
  const before = locators[0];
  locators.sort((a, b) => Number(Boolean(a.volatileId)) - Number(Boolean(b.volatileId)));
  return before?.volatileId && locators[0] !== before ? before : null;
}
