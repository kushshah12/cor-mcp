// U9: cor_check — every locator in the changed test files must carry a COR id (R31, R43, R47). A typed or positional
// one fails and comes back with COR's entry to paste (R32); a working one with no id is tied to its element's record
// and gets the id to add (R44). Identity is the id, or the element a locator finds — never its text (R46).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { scanLocators, scanYaml } from '../check-scan.js';
import { parseGradable } from '../grade-parse.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);
const MAX_FILES = 2000;
const MAX_FINDINGS = 15;
const posix = (p) => p.split(sep).join('/');

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Files changed on this branch, uncommitted, or untracked — absolute paths — or null outside a git repo. */
export function changedFiles(root) {
  let top;
  try { top = git(root, ['rev-parse', '--show-toplevel']); } catch { return null; }
  let base = null;
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try { base = git(root, ['merge-base', 'HEAD', ref]); break; } catch { /* next */ }
  }
  const names = new Set();
  const add = (out) => out.split('\n').filter(Boolean).forEach((n) => names.add(resolve(top, n)));
  try { add(git(root, ['diff', '--name-only', ...(base ? [base] : ['HEAD'])])); } catch { /* no commits yet */ }
  try { add(git(root, ['ls-files', '--others', '--exclude-standard'])); } catch { /* ignore */ }
  // git reports real paths (macOS: /private/var/… for /var/…); answer in the root's own spelling.
  const real = realpathSync(root);
  return [...names].filter((f) => f.startsWith(real) && existsSync(f)).map((f) => join(root, relative(real, f)));
}

function allFiles(root) {
  const out = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(root);
  return out;
}

export function checkTools(session, inspector, records = null) {
  return [{
    name: 'cor_check',
    config: {
      title: 'Check every locator in the test files carries a COR id',
      description:
        'Run before the tests. Scans the test and locator files changed on this branch (or all: true for the whole project) and fails any locator ' +
        'without a COR id (the // COR cor:… comment an entry carries), any id COR did not issue here, and any positional pick (.first(), .nth(), .eq(), [n]). ' +
        'With the locator\'s page open it returns the fix: COR\'s entry to paste, or the id to add for a locator COR already has a record of.',
      inputSchema: {
        files: z.array(z.string()).optional().describe('Files to check, relative to the project root. Default: changed files.'),
        all: z.boolean().optional().describe('Check every file in the project instead of the changed ones.'),
      },
    },
    handler: async ({ files, all = false }) => {
      const root = session.root;
      const changed = files?.length || all ? null : changedFiles(root);
      const listed = files?.length ? files.map((f) => resolve(root, f)) : changed ?? allFiles(root);
      const scope = files?.length ? 'the given files' : changed ? 'files changed on this branch' : 'all project files';
      const storeDir = posix(session.conventions.storeDir.value);
      const recordDir = join(root, '.cor', 'records');
      const recordsOn = existsSync(recordDir);
      const known = new Set(recordsOn ? readdirSync(recordDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);
      let sidecar = {};
      try { sidecar = JSON.parse(readFileSync(join(root, '.cor', 'ids.json'), 'utf8')); } catch { /* none */ }
      const page = session.isOpen ? await session.getPage() : null;

      const findings = [];
      let count = 0;
      let filesWithLocators = 0;
      for (const file of listed) {
        const rel = posix(relative(root, file));
        if (rel.startsWith('.cor/') || rel.startsWith('node_modules/')) continue;
        const inStore = rel.startsWith(`${storeDir}/`);
        let src;
        try { src = readFileSync(file, 'utf8'); } catch { continue; }
        let sites = [];
        if (CODE.test(rel)) sites = scanLocators(src);
        else if (inStore && /\.ya?ml$/.test(rel)) sites = scanYaml(src);
        else if (inStore && rel.endsWith('.json')) {
          let map = null;
          try { map = JSON.parse(src); } catch { /* not ours */ }
          if (map && typeof map === 'object') sites = Object.keys(map).map((key) => ({ line: 1, key, id: sidecar[`${rel}#${key}`] ?? null, statement: `${key}: ${JSON.stringify(map[key])}`, positional: />>\s*nth=/.test(String(map[key])) }));
        }
        if (!sites.length) continue;
        filesWithLocators++;
        for (const site of sites) {
          count++;
          const where = `${rel}:${site.line}`;
          const shown = site.statement.split('\n')[0].slice(0, 100);
          if (site.positional) {
            findings.push({ where, what: `${shown} — picks by position (.first/.nth/.eq/[n]): a reorder silently changes the element.`, fix: await fixFor(site) });
          } else if (site.id && (known.has(site.id) || !recordsOn)) {
            continue; // issued by COR (with records off, the id is all there is to check)
          } else if (site.id) {
            findings.push({ where, what: `cor:${site.id} is not a record COR issued in this project (copied from elsewhere, or edited?).`, fix: await fixFor(site) });
          } else {
            findings.push({ where, what: `${shown} — no COR id.`, fix: await fixFor(site) });
          }
        }
      }

      /** COR's fix for a site: run its locator on the open page; the element it finds gets an entry (or its existing id). */
      async function fixFor(site) {
        if (!page || !site.expression) return [`Open the page it targets (cor_open) and run cor_check again for COR's entry — or cor_inspect the element.`];
        let parsed;
        try { parsed = parseGradable(site.expression, { framework: session.resolveFramework() ?? undefined }); } catch { return ['Not readable as a locator COR can run — cor_inspect the element and place its entry.']; }
        let handle = null;
        try {
          const loc = parsed.build(page);
          if (await loc.count() === 1) handle = await loc.elementHandle();
        } catch { /* not on this page */ }
        if (!handle) return ['It finds no single element on the open page — open the page it targets, or cor_inspect the element and place its entry.'];
        const before = new Set(known);
        const { entry } = await inspector({ element: handle, quiet: true }).finally(() => handle.dispose());
        if (!entry) return ['COR has no durable locator for this element — cor_inspect it for the recommendation.'];
        const id = /cor:([0-9a-f]{6})/.exec(entry.join('\n'))?.[1];
        if (id) known.add(id);
        if (!site.positional && id && before.has(id)) return [`COR already has a record of this element: add \`// COR cor:${id}\` on the line above it (keep the locator).`];
        return ['Replace it with COR\'s entry:', ...entry.filter(Boolean).map((l) => `  ${l}`)];
      }

      const head = `cor_check: ${count} locator${count === 1 ? '' : 's'} in ${filesWithLocators} file${filesWithLocators === 1 ? '' : 's'} (${scope}) — ${count - findings.length} carry a COR id, ${findings.length} to fix.`;
      if (!findings.length) return text(`${head}${recordsOn ? '' : '\nNo .cor/records/ in this project (records off): ids were checked for presence only.'}`);
      const lines = [head, ''];
      for (const f of findings.slice(0, MAX_FINDINGS)) lines.push(`✗ ${f.where} — ${f.what}`, ...f.fix.map((l) => `  ${l}`), '');
      if (findings.length > MAX_FINDINGS) lines.push(`… ${findings.length - MAX_FINDINGS} more — fix these and run cor_check again.`);
      return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }], isError: true };
    },
  }];
}
