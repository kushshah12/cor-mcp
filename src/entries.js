// U8: the entry COR hands the agent to place — the decided locator as code in the team's store style, its target file
// and member name, and a grade comment carrying its `cor:` id (R13, R19, R42). The agent places it with its own edit
// tools; COR never edits the team's files. cor_check (U9) finds entries again by that id, never by their text.

import { helperUse } from './format.js';
import { everyItem, leafIn, nameOf } from './idioms/index.js';

const camel = (s) => {
  const words = String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  const name = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[a-z]/.test(name) ? name : `el${name[0].toUpperCase()}${name.slice(1)}`;
};
const IMPLICIT_ROLE = { button: 'button', a: 'link', input: 'textbox', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading' };
const ROLE_SUFFIX = { button: 'Button', link: 'Link', textbox: 'Input', combobox: 'Select', checkbox: 'Checkbox', radio: 'Radio', tab: 'Tab', heading: 'Heading' };

/** The page's file name: `/inventory.html` → `inventory`, `/` → `home`. */
export function pageName(url) {
  let path = '/';
  try { path = new URL(url).pathname; } catch { /* keep / */ }
  const last = path.split('/').filter(Boolean).pop()?.replace(/\.[a-z]+$/i, '');
  return camel(last) ?? 'home';
}

/** The member's name: a parameterised entry by its action (`addToCart`), a single one by its test id or role + name. */
export function memberName(result, lead) {
  if (lead?.kind === 'cell') {
    // P1: not `cell` — the Cypress / WebdriverIO helper already has that name. P3: an element inside the cell (an image) is cellAtImg.
    const tag = /^\/\/([a-z0-9]+)/.exec(lead.model?.inner ?? '')?.[1];
    return tag ? `cellAt${tag[0].toUpperCase()}${tag.slice(1)}` : 'cellAt';
  }
  if (lead) {
    const leaf = result.params?.model?.leaf;
    // P3: the name of an item named by either of two elements: the item's name (`simplificationCardName`).
    if (leaf?.nameSels) return `${camel(/\.([\w-]+)[^.]*$/.exec(lead.model?.item?.css ?? '')?.[1]) ?? 'item'}Name`;
    // P2a: a leaf whose name differs per item (an item's own title, one FAQ answer's words) is named by its class instead
    // (`faq-item__answer` → faqItemAnswer), else by the parameter (`titleText`).
    const css = leaf?.css ?? leaf?.shownCss; // P3: a leaf with hidden twins keeps its CSS as shownCss
    const varies = leaf?.name && css && !lead.code?.includes(leaf.name)
      && (result.params?.values?.includes(leaf.name) || (!leaf.role && !IMPLICIT_ROLE[result.element?.tag]));
    if (varies) return camel(/\.([\w-]+)[^.]*$/.exec(css)?.[1]) ?? `${camel(lead.param) ?? 'item'}Text`;
    const leafName = leaf?.name ?? result.lookalikes?.name;
    return camel(leafName) ?? camel(lead.param) ?? 'item';
  }
  const el = result.element ?? {};
  const testId = Object.values(el.testIds ?? {})[0];
  if (testId) return camel(testId);
  const named = camel(el.accessibleName ?? el.text);
  const role = el.role ?? IMPLICIT_ROLE[el.tag];
  const suffix = ROLE_SUFFIX[role];
  if (named) return `${named}${suffix && !named.toLowerCase().endsWith(suffix.toLowerCase()) ? suffix : ''}`;
  // P2a: an element with no name (a plain <span id="plan">) is named by its id — not one with digits, which may be generated.
  return (el.id && !/\d/.test(el.id) && camel(el.id)) || camel(result.capture?.fingerprint?.text?.slice(0, 40)) || 'element';
}

// P3: each framework's visibility assertion, named in the collapsed-content note.
const VISIBLE_CHECK = { playwright: 'toBeVisible()', cypress: "should('be.visible')", webdriverio: 'isDisplayed()' };

const STORE_FILE = {
  'page-object-class': (name, ext) => `${name}.page.${ext}`,
  constants: (name, ext) => `${name}.locators.${ext}`,
  json: (name) => `${name}.json`,
  yaml: (name) => `${name}.yml`,
};

/** A plain CSS or XPath string: what a strings-only store can hold and every framework can read (R15). */
const isPlainSelector = (v) => !/^(role|text|internal|aria)[=/:]|getBy|>>|:has-text|:text-is|:visible/.test(String(v));

const indent = (code) => code.split('\n').map((l, i) => (i ? `  ${l}` : l)).join('\n');

/**
 * The entry block for one inspected element: placed at the top of cor_inspect's reply. `lead` is the template whose own
 * code is placed (inspectParts' entryLead), so the grade comment describes exactly that code (P1). `declined` (P1): no
 * locator passes — the entry is a decline id to cite, and no code.
 * @returns {{ lines: string[], member: string, file: string, store: string, declined?: string }}
 */
/** P3: the every-item locator for a template: Playwright's `every`, or the framework's form of the item helper's model. */
export function everyOf(lead, framework, helper) {
  if (!lead || ['group', 'cell'].includes(lead.kind)) return null;
  if (framework === 'playwright') return lead.every ?? null;
  return helper && lead.model?.item ? everyItem(framework, lead.model) : null;
}

/** P3: the every-item member's name — the items, plural, from the item's class or test id (`div.faq-item` → faqItems). */
export function everyName(code) {
  const css = /\(\s*['"`]([^'"`]+)['"`]/.exec(code ?? '')?.[1] ?? '';
  const word = /\[[\w-]+=["']?([\w-]+)["']?\]\s*$/.exec(css)?.[1] ?? /\.([\w-]+)[^.]*$/.exec(css)?.[1] ?? /([a-z][\w-]*)\s*$/i.exec(css)?.[1];
  const name = camel(word) ?? 'item';
  return /s$/.test(name) ? `${name}List` : `${name}s`;
}

export function entryFor({ result, lead, helper, framework, conventions, typescript = false, url, id, declined = null, labelCode = null, everyId = null }) {
  const store = conventions.store.value;
  const ext = typescript ? 'ts' : 'js';
  const file = `${conventions.storeDir.value}/${STORE_FILE[store](pageName(url), ext)}`;
  // P4: a helper that reaches only the item (no form for the element inside held in every item) returns the item — the
  // member is named for what it returns (`card`), not for the inspected button.
  const itemOnly = framework !== 'playwright' && Boolean(helper) && lead && !['group', 'cell'].includes(lead.kind) && helperUse(helper) === helper.call;
  const member = itemOnly ? /^(\w+)\(/.exec(helper.call)[1] : memberName(result, lead);
  const [best] = result.locators;
  const grade = lead
    ? `${lead.counted ?? lead.count}/${lead.counted ?? lead.count} ${lead.kind === 'group' ? 'options' : 'items'} checked`
    : best ? `${best.score} ${best.tierLabel} · 1 match` : null; // no locator at all: the entry is a decline
  // P4: the comment names the member, never a grade or count — those go stale; the record keeps the grade, cor_check reports it.
  const tag = `COR cor:${id} · ${member}`;
  const p = lead?.param;
  const pTyped = p ? `${p}${typescript ? ': string' : ''}` : '';
  const head = `Entry — place in ${file}, member ${member} (cor_check reads the cor: id; keep the comment):`;
  if (declined) {
    return {
      lines: [`Entry — declined: ${declined}. COR issues no locator for this element. If the test must use it, put this line above the locator you write; cor_check then reports it as declined, cited (the app needs a test attribute):`,
        `  ${store === 'yaml' ? '#' : '//'} COR cor:${id} · declined — ${declined}`, ''],
      member, file, store, declined,
    };
  }

  if (store === 'json' || store === 'yaml') {
    const value = lead
      ? lead.template?.xpath?.selectorTemplate?.replace(new RegExp(`__${p}__`, 'g'), `{${p}}`)
      : result.locators.find((l) => l.resolution?.usable !== false && isPlainSelector(l.value))?.value;
    if (!value) return { lines: [`Entry: no plain CSS or XPath string reaches this element for a ${store.toUpperCase()} map — keep it in code (cor.config.js locators.store) or add a test attribute.`, ''], member, file, store, proof: grade };
    const lines = store === 'json'
      ? [head, `  ${JSON.stringify(member)}: ${JSON.stringify(value)}`, `  .cor/ids.json: ${JSON.stringify(`${file}#${member}`)} → "${id}" (written by COR; JSON holds no comments)`]
      : [head, `  # ${tag}`, `  ${member}: ${JSON.stringify(value)}`];
    if (lead) lines.push(`  {${p}} is replaced by the exact ${p} — the XPath compares it as text, so quote it as an XPath literal.`);
    return { lines: [...lines, ''], member, file, store, proof: grade };
  }

  const comment = `  // ${tag}`;
  let body;
  let preamble = [];
  if (framework === 'playwright' && lead?.kind === 'cell') {
    // P1: the cell code is already a function of (row, column) — the member is that function, not one returning it.
    body = store === 'page-object-class'
      ? `  ${member} = ${indent(lead.code.replace(/\bpage\./g, 'this.page.'))};`
      : `  ${member}: ${indent(lead.code.replace(/^\(/, '(page, '))},`;
  } else if (framework === 'playwright') {
    const code = lead ? lead.code : (best.code || best.value);
    body = store === 'page-object-class'
      ? `  ${member} = (${pTyped}) => ${code.replace(/\bpage\./g, 'this.page.')};`
      : `  ${member}: (page${p ? `, ${pTyped}` : ''}) => ${code},`;
  } else {
    // P1: the helper is defined once at module scope; the member returns its call (the leaf, when it reaches one).
    // A cell helper takes (row, column), so the member passes both.
    const args = lead?.kind === 'cell' ? lead.vars.map((v) => `${v}${typescript ? ': string' : ''}`).join(', ') : pTyped;
    const use = helper ? helperUse(helper) : (best.code || best.value).replace(/^await\s+/, '');
    if (helper) preamble = [`  // ${tag} · helper, once per file (module scope)`, ...helper.define.split('\n').map((l) => `  ${l}`)];
    body = store === 'page-object-class' ? `  ${member} = (${args}) => ${indent(use)};` : `  ${member}: (${args}) => ${indent(use)},`;
  }
  // P2a fix: a hidden input is changed by clicking its label — the entry carries that member too, under the same id. The
  // `· label` marker tells cor_check this member finds the label, not the recorded input.
  const labelUse = lead?.kind === 'group' && framework === 'playwright' ? lead.act
    : lead?.kind === 'group' && helper?.idioms.includes('group.label-click')
      ? helper.uses.find((u) => /\.click\(\)\s*$/.test(u))?.replace(/\s*\.click\(\)\s*$/, '')
      : lead ? null : labelCode;
  const click = labelUse ? [
    `  // COR cor:${id} · ${member}Label · label — the input is hidden: click this, assert ${member}'s checked state`,
    framework === 'playwright' && store !== 'page-object-class'
      ? `  ${member}Label: (page${p ? `, ${pTyped}` : ''}) => ${labelUse},`
      : `  ${member}Label${store === 'page-object-class' ? ' =' : ':'} (${p ? pTyped : ''}) => ${indent(framework === 'playwright' ? labelUse.replace(/\bpage\./g, 'this.page.') : labelUse)}${store === 'page-object-class' ? ';' : ','}`,
  ] : [];
  // P3: a variant sits behind its item's toggle — the action that shows it is part of the entry (P1 had dropped it).
  const variantUse = framework === 'playwright' ? lead?.variantAct : helper?.idioms.includes('variant.click') ? helper.uses.at(-1) : null;
  const show = variantUse ? [
    `  // COR cor:${id} · showVariant · variant — click it first when the ${p} is a variant: it sits behind its item's toggle`,
    framework === 'playwright' && store !== 'page-object-class'
      ? `  showVariant: (page, ${pTyped}) => ${variantUse},`
      : `  showVariant${store === 'page-object-class' ? ' =' : ':'} (${pTyped}) => ${indent(framework === 'playwright' ? variantUse.replace(/\bpage\./g, 'this.page.') : variantUse)}${store === 'page-object-class' ? ';' : ','}`,
  ] : [];
  // P3: the every-item locator, with its own id — a loop the agent writes as instructed passes cor_check.
  const everyCode = everyId ? everyOf(lead, framework, helper) : null;
  const everyMember = everyCode ? everyName(everyCode) : null;
  const every = everyCode ? [
    `  // COR cor:${everyId} · ${everyMember}`,
    framework === 'playwright' && store !== 'page-object-class'
      ? `  ${everyMember}: (page) => ${everyCode},`
      : `  ${everyMember}${store === 'page-object-class' ? ' =' : ':'} () => ${framework === 'playwright' ? everyCode.replace(/\bpage\./g, 'this.page.') : everyCode}${store === 'page-object-class' ? ';' : ','}`,
  ] : [];
  // P3 (run b14ddae4): the element inside each item of that loop, under this entry's id — the agent had appended the leaf to the
  // every-item locator itself (items().locator('p.question')), and cor_check could not tie it to anything.
  const ofMember = everyCode && !itemOnly ? `${member}Of` : null;
  const ofCode = !ofMember ? null : framework === 'playwright' ? (lead.leafCode ? `item${lead.leafCode}` : null)
    : leafIn(framework, lead.model, framework === 'cypress' ? 'cy.wrap(item)' : 'item', { testingLibrary: helper?.idioms?.includes('leaf.role') });
  const itemType = !typescript ? '' : { playwright: ": import('@playwright/test').Locator", cypress: ': JQuery<HTMLElement>', webdriverio: ': WebdriverIO.Element' }[framework] ?? '';
  const of = ofCode ? [
    `  // COR cor:${id} · ${ofMember}`,
    store === 'page-object-class' ? `  ${ofMember} = (item${itemType}) => ${ofCode};` : `  ${ofMember}: (item${itemType}) => ${ofCode},`,
  ] : [];
  // P3 (runs 92a3c7e6, 8cf9312a): an item named by either of two elements comes with its name member — "each card shows its name".
  const nameMember = lead?.model?.slot?.kind === 'either' && !lead.model.leaf?.nameSels && !itemOnly
    ? `${camel(/\.([\w-]+)[^.]*$/.exec(lead.model.item?.css ?? '')?.[1]) ?? 'item'}Name` : null;
  const nameCode = !nameMember ? null : framework === 'playwright' ? lead.nameCode?.replace(/\bpage\./g, store === 'page-object-class' ? 'this.page.' : 'page.')
    : helper?.call ? nameOf(framework, lead.model, helper.call) : null;
  const named = nameCode && nameMember !== member ? [
    `  // COR cor:${id} · ${nameMember}`,
    store === 'page-object-class' ? `  ${nameMember} = (${pTyped}) => ${nameCode};`
      : framework === 'playwright' ? `  ${nameMember}: (page, ${pTyped}) => ${nameCode},` : `  ${nameMember}: (${pTyped}) => ${nameCode},`,
  ] : [];
  const extra = [...click, ...show, ...named, ...every, ...of];
  // P3: a state the test must check before acting — an item that starts open closes on the first click.
  const notes = [];
  if (lead?.startsOpen) notes.push(`note: ${lead.startsOpen.map((v) => `"${v}"`).join(', ')} ${lead.startsOpen.length === 1 ? 'is' : 'are'} open now — clicking it closes it; check its state before clicking`);
  // P3: a closed item clips this element to 0 height instead of hiding it, so the framework's visibility check passes anyway.
  if (lead?.collapsedWhenClosed) notes.push(`note: when its item is closed, ${member} is clipped to 0 height, not hidden — ${VISIBLE_CHECK[framework] ?? 'a visibility check'} still passes; assert the item's open state or ${member}'s height instead`);
  return { lines: [head, ...preamble, comment, body, ...extra, ...notes.map((n) => `  ${n}`), ''], member, file, store, preamble, comment, body, click: extra, proof: grade, itemOnly, everyMember, ofMember: of.length ? ofMember : null, notes, showVariant: show.length > 0 };
}
