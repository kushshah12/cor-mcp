// P3a: WebdriverIO idiom table (spec §7.2, D2) — composition only. The leaf inside the item comes from the page check.
// Measured in real WebdriverIO 9.32 (scripts/conformance): `$$(css).filter(fn).find(fn)` takes async callbacks and chains;
// `tag.class=text` is an exact text match; a selector with a space before `=` is invalid.
import { helperName, js, plainValue, withinBar } from './shared.js';

/** Idioms this renderer can emit (each has a conformance fixture, §10). */
export const IDIOMS = ['item.attribute', 'item.label', 'item.either', 'leaf.aria', 'leaf.aria.shown', 'leaf.css', 'every', 'variant.click'];

function item(model, values, ts) {
  const { param, item: it, slot } = model;
  const type = ts ? `${param}: string` : param;
  const shown = it.visible ? '.filter((el) => el.isDisplayed())' : '';
  if (slot.kind === 'attribute') {
    if (!values.every(plainValue)) return { none: `a ${slot.attr} value has a quote or backtick in it` };
    const found = it.visible
      ? `$$(\`${it.css}[${slot.attr}="\${${param}}"]\`).find((el) => el.isDisplayed())`
      : `$(\`${it.css}[${slot.attr}="\${${param}}"]\`)`;
    return { idiom: 'item.attribute', lines: [`const ${helperName(it.css)} = (${type}) => ${found};`] };
  }
  if (slot.transformed) return { none: 'the name is styled with text-transform, and getText() reports the displayed text' };
  if (!values.every(plainValue)) return { none: 'a name has a quote or backtick in it' };
  const named = slot.sels.map((sel) => `(await el.$(\`${sel}=\${${param}}\`).isExisting())`);
  const name = helperName(it.css);
  const lines = [
    `const ${name} = (${type}) =>`,
    `  $$(${js(it.css)})${shown}`,
    `    .find(async (el) => ${named.join(' ||\n      ')});`,
  ].join('\n').split('\n');
  return { idiom: slot.kind === 'either' ? 'item.either' : 'item.label', lines };
}

export function leaf(model, from) {
  const { leaf: l } = model;
  // twins: the item holds more than one button of that name (one per toggle state) — `$` would take the first, shown or not.
  if (l?.aria && l.twins) return { idiom: 'leaf.aria.shown', code: `${from}.$$(${js(`aria/${l.name}`)}).find((el) => el.isDisplayed())` };
  if (l?.aria) return { idiom: 'leaf.aria', code: `${from}.$(${js(`aria/${l.name}`)})` };
  if (l?.css) return { idiom: 'leaf.css', code: `${from}.$(${js(l.css)})` };
  return null;
}

/**
 * @returns {{ code: string, define: string, uses: string[], idioms: string[] } | { none: string }}
 * `define` is the helper; `uses` are expressions that call it (the leaf, the variant click).
 */
export function render(params, { typescript = false } = {}) {
  const { model, values } = params;
  const found = item(model, values, typescript);
  if (found.none) return found;
  const name = helperName(model.item.css);
  const idioms = [found.idiom];
  const uses = [];
  const l = leaf(model, `${name}(${model.param})`);
  if (l) { uses.push(l.code); idioms.push(l.idiom); }
  if (model.toggle && params.variantAct) {
    uses.push(`${name}(${model.param}).$(\`${model.toggle}=\${${model.param}}\`).click()`);
    idioms.push('variant.click');
  }
  if (!withinBar([...found.lines, ...uses])) return { none: 'the helper does not fit the readability bar (8 lines, 120 characters)' };
  const define = found.lines.join('\n');
  return { define, uses, idioms, code: [define, ...uses].join('\n') };
}

/** The every-item expression: loop over it. */
export const every = (model) => `$$(${js(model.item.css)})${model.item.visible ? '.filter((el) => el.isDisplayed())' : ''}`;
