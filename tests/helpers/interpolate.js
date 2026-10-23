// Copy of cor-sdk/packages/client/src/interpolate.js (the client package is not on npm, so cor-mcp cannot depend on it).
// Keep in sync with that file. Used only by the params tests.
/**
 * Parameterized-locator interpolation (F-014 Phase 2a).
 *
 * Single source of truth for substituting runtime params into a locator's
 * `selectorTemplate`. Previously this loop was duplicated across the Playwright
 * adapter (cor(), corAction, corPage); the Cypress and WDIO adapters didn't
 * support params at all. All adapters now delegate here.
 *
 * Fail-loud (R8a): a parameterized locator whose var has neither a supplied
 * param nor a stored `rawValue` throws instead of emitting a selector that
 * still contains an `__var__` placeholder (which silently matches nothing).
 */

/**
 * A value lands inside a template written in some syntax; a quote in the
 * value must not end that syntax's string early ("12\" Monitor").
 *   css-string     the placeholder sits inside "…" (Playwright `:text-is("__v__")`)
 *   xpath-literal  the placeholder IS the literal, quotes included
 * No syntax: the value is inserted as-is (templates written before syntaxes).
 */
function escapeFor(syntax, value) {
  if (syntax === 'css-string') return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  if (syntax === 'xpath-literal') {
    if (!value.includes("'")) return `'${value}'`
    if (!value.includes('"')) return `"${value}"`
    return `concat(${value.split("'").map((p) => `'${p}'`).join(`, "'", `)})`
  }
  return value
}

/**
 * @param {import('./cache.js').LocatorEntry} entry
 * @param {Record<string, string>} [params]
 * @returns {string} concrete selector
 */
export function interpolateTemplate(entry, params) {
  if (!entry) return undefined
  // Not a parameterized locator → the plain selector.
  if (!entry.selectorTemplate || !entry.vars || entry.vars.length === 0) {
    return entry.selector
  }

  let result = entry.selectorTemplate
  for (const { varName, rawValue, syntax } of entry.vars) {
    let value
    if (params && Object.prototype.hasOwnProperty.call(params, varName)) {
      value = params[varName]
    } else if (rawValue !== undefined && rawValue !== null) {
      value = rawValue
    } else {
      throw new Error(
        `[COR] missing param "${varName}" for parameterized locator — call cor(page, name, { ${varName}: … })`,
      )
    }
    // Use a replacement FUNCTION: a string replacement would interpret `$&`,
    // `$$`, `` $` ``, `$'` in the value as special patterns and corrupt it.
    const escaped = escapeFor(syntax, String(value))
    result = result.replaceAll(`__${varName}__`, () => escaped)
  }
  return result
}
