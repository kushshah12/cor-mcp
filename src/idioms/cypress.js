// P3b: Cypress idiom table (spec §7.2, D2) — composition only; never `cy.xpath` (needs a plugin, §12).
// Names are matched with an anchored regex through `Cypress._.escapeRegExp`, never a plain `cy.contains(sel, text)` (a substring match).
import { helperName, js, plainValue, withinBar } from './shared.js';

/** Idioms this renderer can emit (each has a conformance case, §10). */
export const IDIOMS = ['item.attribute', 'item.label', 'item.either', 'leaf.css', 'leaf.css.shown', 'leaf.role', 'every', 'variant.click',
  'group.role', 'group.label', 'group.label-click', 'group.tl', 'cell.css'];

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
 * A control group. An option with a role attribute (a tab) is found by its own text; a native input by its label — `.control` is
 * the input the label names, wrapping or `for`, hidden or not. A hidden input is changed by clicking its label, as a user does.
 * Testing Library's queries replace both when the project has it.
 */
function group(params, ts, testingLibrary) {
  const { model, values } = params;
  const p = model.param;
  if (!model.cy) return { none: 'no label or text names exactly one element per option (a name is shared, partial or repeated)' };
  if (!values.every(plainValue)) return { none: 'an option name has a quote or backtick in it' };
  const arg = ts ? `${p}: string` : p;
  const name = `${p}Option`;
  const re = exactName(p);
  const idioms = [];
  let define;
  if (testingLibrary && model.role) {
    // Hidden inputs are outside the accessibility tree, so they are found by label text.
    define = model.hidden ? `const ${name} = (${arg}) => cy.findByLabelText(${p});` : `const ${name} = (${arg}) => cy.findByRole(${js(model.role)}, { name: ${p} });`;
    idioms.push('group.tl');
  } else if (model.cy.kind === 'role') {
    define = [`const ${name} = (${arg}) =>`, `  cy.contains(${js(model.cy.selector)}, ${re});`].join('\n');
    idioms.push('group.role');
  } else {
    const sel = model.cy.scope ? `${model.cy.scope} label` : 'label';
    define = [`const ${name} = (${arg}) =>`, `  cy.contains(${js(sel)}, ${re})`, '    .then(($label) => cy.wrap($label[0].control));'].join('\n');
    idioms.push('group.label');
  }
  const uses = [];
  if (model.hidden) {
    if (!model.label) return { none: 'the hidden input\'s label text does not name exactly one label' };
    const sel = model.label.scope ? `${model.label.scope} label` : 'label';
    const one = `cy.contains(${js(sel)}, ${re}).click()`;
    uses.push(one.length <= 120 ? one : `cy.contains(${js(sel)}, ${re})\n  .click()`);
    idioms.push('group.label-click');
  }
  if (!withinBar(define.split('\n'), uses.flatMap((u) => u.split('\n')))) return { none: 'the helper does not fit the readability bar (8 lines, 120 characters)' };
  return { define, uses, idioms, code: [define, ...uses].join('\n'), kind: 'group', call: `${name}(${p})` };
}

/**
 * A row × column cell without XPath: the header cell's position from `cy.contains` + `.invoke('index')`, then the row by its key
 * cell. Only for cells named by their own text; the page check emulated every combination against the proven XPath.
 */
function cell(params, ts) {
  const { model, rows, columns } = params;
  if (!model.cy) return { none: 'a row or column name is only part of its cell, or the table has no id or class to name it by' };
  if (![...rows, ...columns].every(plainValue)) return { none: 'a row or column name has a quote or backtick in it' };
  const [r, c] = model.vars;
  const t = ts ? ': string' : '';
  const inner = model.cy.innerCss ? `.find(${js(model.cy.innerCss)})` : '';
  // The selectors and the anchored name are named once, so a scoped selector does not push a line past 120 characters.
  const define = [
    `const cell = (${r}${t}, ${c}${t}) => {`,
    `  const header = ${js(model.cy.headerSel)};`,
    `  const key = ${js(model.cy.keySel)};`,
    `  const is = (text${t}) => ${exactName('text')};`,
    `  return cy.contains(header, is(${c})).invoke('index')`,
    `    .then((i) => cy.contains(key, is(${r})).closest('tr').children().eq(i)${inner});`,
    '};',
  ].join('\n');
  if (!withinBar(define.split('\n'))) return { none: 'the helper does not fit the readability bar (8 lines, 120 characters)' };
  return { define, uses: [], idioms: ['cell.css'], code: define, kind: 'cell', call: `cell(${r}, ${c})` };
}

/**
 * @returns {{ code: string, define: string, uses: string[], idioms: string[] } | { none: string }}
 * `define` is the helper; `uses` are the calls that reach the leaf and show a variant.
 */
export function render(params, { typescript = false, testingLibrary = false } = {}) {
  const { model, values } = params;
  if (model.kind === 'group') return group(params, typescript, testingLibrary);
  if (model.kind === 'cell') return cell(params, typescript);
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
