// U8: the entry COR hands the agent to place — the decided locator as code in the team's store style, its target file
// and member name, and a grade comment carrying its `cor:` id (R13, R19, R42). The agent places it with its own edit
// tools; COR never edits the team's files. cor_check (U9) finds entries again by that id, never by their text.

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
  if (lead) {
    const leafName = result.params?.model?.leaf?.name ?? result.lookalikes?.name;
    return camel(leafName) ?? camel(lead.param) ?? 'item';
  }
  const el = result.element ?? {};
  const testId = Object.values(el.testIds ?? {})[0];
  if (testId) return camel(testId);
  const named = camel(el.accessibleName ?? el.text);
  const role = el.role ?? IMPLICIT_ROLE[el.tag];
  const suffix = ROLE_SUFFIX[role];
  return named ? `${named}${suffix && !named.toLowerCase().endsWith(suffix.toLowerCase()) ? suffix : ''}` : 'element';
}

const STORE_FILE = {
  'page-object-class': (name, ext) => `${name}.page.${ext}`,
  constants: (name, ext) => `${name}.locators.${ext}`,
  json: (name) => `${name}.json`,
  yaml: (name) => `${name}.yml`,
};

/** A plain CSS or XPath string: what a strings-only store can hold and every framework can read (R15). */
const isPlainSelector = (v) => !/^(role|text|internal|aria)[=/:]|getBy|>>|:has-text|:text-is|:visible/.test(String(v));

/**
 * The entry block for one inspected element: placed at the top of cor_inspect's reply.
 * @returns {{ lines: string[], member: string, file: string, store: string }}
 */
export function entryFor({ result, lead, helper, framework, conventions, typescript = false, url, id }) {
  const store = conventions.store.value;
  const ext = typescript ? 'ts' : 'js';
  const file = `${conventions.storeDir.value}/${STORE_FILE[store](pageName(url), ext)}`;
  const member = memberName(result, lead);
  const [best] = result.locators;
  const grade = lead
    ? `${lead.counted ?? lead.count}/${lead.counted ?? lead.count} ${lead.kind === 'group' ? 'options' : 'items'} checked`
    : `${best.score} ${best.tierLabel} · 1 match`;
  const tag = `COR cor:${id} · ${grade}`;
  const p = lead?.param;
  const pTyped = p ? `${p}${typescript ? ': string' : ''}` : '';
  const head = `Entry — place in ${file}, member ${member} (cor_check reads the cor: id; keep the comment):`;

  if (store === 'json' || store === 'yaml') {
    const value = lead
      ? lead.template?.xpath?.selectorTemplate?.replace(new RegExp(`__${p}__`, 'g'), `{${p}}`)
      : result.locators.find((l) => l.resolution?.usable !== false && isPlainSelector(l.value))?.value;
    if (!value) return { lines: [`Entry: no plain CSS or XPath string reaches this element for a ${store.toUpperCase()} map — keep it in code (cor.config.json store) or add a test attribute.`, ''], member, file, store };
    const lines = store === 'json'
      ? [head, `  ${JSON.stringify(member)}: ${JSON.stringify(value)}`, `  .cor/ids.json: ${JSON.stringify(`${file}#${member}`)} → "${id}" (written by COR; JSON holds no comments)`]
      : [head, `  # ${tag}`, `  ${member}: ${JSON.stringify(value)}`];
    if (lead) lines.push(`  {${p}} is replaced by the exact ${p} — the XPath compares it as text, so quote it as an XPath literal.`);
    return { lines: [...lines, ''], member, file, store };
  }

  const comment = `  // ${tag}`;
  let body;
  let preamble = [];
  if (framework === 'playwright') {
    const code = lead ? lead.code : (best.code || best.value);
    body = store === 'page-object-class'
      ? `  ${member} = (${pTyped}) => ${code.replace(/\bpage\./g, 'this.page.')};`
      : `  ${member}: (page${p ? `, ${pTyped}` : ''}) => ${code},`;
  } else {
    const helperLines = helper?.code ? helper.code.split('\n') : null;
    const use = helperLines ? helperLines.at(-1).trim() : (best.code || best.value).replace(/^await\s+/, '');
    if (helperLines) preamble = [`  // ${tag} · helper, once per file (module scope)`, ...helperLines.slice(0, -1).map((l) => `  ${l}`)];
    body = store === 'page-object-class' ? `  ${member} = (${pTyped}) => ${use};` : `  ${member}: (${pTyped}) => ${use},`;
  }
  return { lines: [head, ...preamble, comment, body, ''], member, file, store };
}
