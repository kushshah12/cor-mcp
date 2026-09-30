// P3b: Cypress idiom table (spec §7.2, D2) — composition only; never `cy.xpath` (needs a plugin, §12).
// Names are matched with an anchored regex through `Cypress._.escapeRegExp`, never a plain `cy.contains(sel, text)` (a substring match).
import { helperName, js, plainValue, withinBar } from './shared.js';

/** Idioms this renderer can emit (each has a conformance case, §10). */
export const IDIOMS = ['item.attribute', 'item.label', 'item.either', 'leaf.css', 'leaf.css.shown', 'leaf.role', 'every', 'variant.click'];

// The anchored, whitespace-tolerant name (a wrapping label puts spaces around the text — found by E1 in real Cypress 16).
const exactName = (p) => `new RegExp(\`^\\\\s*\${Cypress._.escapeRegExp(${p})}\\\\s*$\`)`;

function item(model, values, ts) {
  const { param, item: it, slot } = model;
  const type = ts ? `${param}: string` : param;
  const shown = it.visible ? ".filter(':visible')" : '';
  const name = helperName(it.css);
  if (slot.kind === 'attribute') {
    if (!values.every(plainValue)) return { none: `a ${slot.attr} value has a quote or backtick in it` };
    return { idiom: 'item.attribute', name, lines: [`const ${name} = (${type}) => cy.get(\`${it.css}[${slot.attr}="\${${param}}"]\`)${shown};`] };
  }
  const contains = `.contains(${js(slot.sels.join(', '))}, ${exactName(param)})`;
  const lines = [
    `const ${name} = (${type}) =>`,
    `  cy.get(${js(it.css)})${shown}`,
    // a long selector list goes on its own line rather than past 120 characters
    ...(contains.length + 4 <= 120 ? [`    ${contains}`] : ['    .contains(', `      ${js(slot.sels.join(', '))},`, `      ${exactName(param)},`, '    )']),
    `    .closest(${js(it.css)});`,
  ];
  return { idiom: slot.kind === 'either' ? 'item.either' : 'item.label', name, lines };
}

/** The target inside the found item: Testing Library's role query when the project has it, else the checked CSS. */
function leaf(model, from, { testingLibrary }) {
  const l = model.leaf;
  if (testingLibrary && l?.role && l.name && !/['\\]/.test(l.name)) return { idiom: 'leaf.role', code: `${from}.findByRole(${js(l.role)}, { name: ${js(l.name)} })` };
  if (l?.cy) return { idiom: l.cy.shown ? 'leaf.css.shown' : 'leaf.css', code: `${from}.find(${js(l.cy.css)})${l.cy.shown ? ".filter(':visible')" : ''}` };
  return null;
}

/**
 * @returns {{ code: string, define: string, uses: string[], idioms: string[] } | { none: string }}
 * `define` is the helper; `uses` are the calls that reach the leaf and show a variant.
 */
export function render(params, { typescript = false, testingLibrary = false } = {}) {
  const { model, values } = params;
  if (model.kind !== 'item') return { none: `no parameterised Cypress form for a ${model.kind} yet` };
  const found = item(model, values, typescript);
  if (found.none) return found;
  const idioms = [found.idiom];
  const uses = [];
  const l = leaf(model, `${found.name}(${model.param})`, { testingLibrary });
  if (l) { uses.push(l.code); idioms.push(l.idiom); }
  if (model.toggle && params.variantAct) {
    const oneLine = `${found.name}(${model.param}).contains(${js(model.toggle)}, ${exactName(model.param)}).click()`;
    uses.push(oneLine.length <= 120 ? oneLine : `${found.name}(${model.param})\n  .contains(${js(model.toggle)}, ${exactName(model.param)})\n  .click()`);
    idioms.push('variant.click');
  }
  if (!withinBar(found.lines, uses.flatMap((u) => u.split('\n')))) return { none: 'the helper does not fit the readability bar (8 lines, 120 characters)' };
  const define = found.lines.join('\n');
  return { define, uses, idioms, code: [define, ...uses].join('\n'), call: `${found.name}(${model.param})` };
}

/** The every-item expression: loop over it with `.each`. */
export const every = (model) => `cy.get(${js(model.item.css)})${model.item.visible ? ".filter(':visible')" : ''}`;
