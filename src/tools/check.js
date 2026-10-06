// U9: cor_check — every locator in the changed test files must carry a COR id (R31, R43, R47). A typed or positional
// one fails and comes back with COR's entry to paste (R32); a working one with no id is tied to its element's record
// and gets the id to add (R44). Identity is the id, or the element a locator finds — never its text (R46).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { scanLocators, scanYaml } from '../check-scan.js';
import { walkFiles } from '../walk.js';
import { parseGradable } from '../grade-parse.js';
import { callPage } from '../page-runtime.js';
import { ID_PATTERN, pathOf, recordPage } from '../records.js';
import { bannedSelector, isIndexReason } from '../positional.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const CODE = /\.[cm]?[jt]sx?$/;
const MAX_FILES = 2000;
const MAX_FINDINGS = 15;
const posix = (p) => p.split(sep).join('/');

// Review fix: a hung git must not block the MCP server.
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }).trim();

/** Files changed on this branch, uncommitted, or untracked — absolute paths — or null outside a git repo. */
export function changedFiles(root) {
  let top;
  try { top = git(root, ['rev-parse', '--show-toplevel']); } catch { return null; }
  let base = null;
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try { base = git(root, ['merge-base', 'HEAD', ref]); break; } catch { /* next */ }
  }
  if (!base) return null; // no merge base (shallow clone, unusual default branch): the caller checks every file and says so
  const names = new Set();
  const add = (out) => out.split('\n').filter(Boolean).forEach((n) => names.add(resolve(top, n)));
  try { add(git(root, ['diff', '--name-only', base])); } catch { /* no commits yet */ }
  // Review fix: --full-name — without it ls-files prints paths relative to the cwd, and a project in a subfolder lost its new specs.
  try { add(git(root, ['ls-files', '--others', '--exclude-standard', '--full-name'])); } catch { /* ignore */ }
  // git reports real paths (macOS: /private/var/… for /var/…); answer in the root's own spelling.
  const real = realpathSync(root);
  return [...names].filter((f) => (f === real || f.startsWith(real + sep)) && existsSync(f)).map((f) => join(root, relative(real, f)));
}

/** Candidate files only (code, JSON, YAML), capped — `truncated` says when the cap cut the walk short. */
const allFiles = (root) => walkFiles(root, { accept: (name) => CODE.test(name) || /\.(json|ya?ml)$/.test(name), maxFiles: MAX_FILES });

export function checkTools(session, inspector, records = null) {
  const MAX_FIXES = MAX_FINDINGS; // each fix runs an inspect and may write a record: only for findings that are shown
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
      await session.prepare();
      const root = session.root;
      const changed = files?.length || all ? null : changedFiles(root);
      if (changed && !changed.length) return text('cor_check: no test or locator files changed on this branch — nothing to check. Pass all: true to check every file.');
      const listed = files?.length ? files.map((f) => resolve(root, f)) : changed ?? allFiles(root);
      const scope = files?.length ? 'the given files' : changed ? 'files changed on this branch' : 'all project files';
      const storeDir = posix(session.conventions.storeDir.value);
      const recordDir = join(root, '.cor', 'records');
      // Review fix: with capture off, committed records cannot be extended — ids are checked for presence only.
      const recordsOn = existsSync(recordDir) && records?.enabled !== false;
      const known = new Set(recordsOn ? readdirSync(recordDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);
      let sidecar = {};
      try { sidecar = JSON.parse(readFileSync(join(root, '.cor', 'ids.json'), 'utf8')); } catch { /* none */ }
      const page = session.isOpen ? await session.getPage() : null;
      const framework = session.resolveFramework() ?? null;

      const findings = [];
      const cited = []; // P1: a decline id — COR recorded that no durable locator exists here; reported, not failed
      let fixes = 0;
      let count = 0;
      let filesWithLocators = 0;
      for (const file of listed) {
        const rel = posix(relative(root, file));
        if (rel.startsWith('.cor/') || rel.startsWith('node_modules/') || rel.startsWith('../')) continue;
        const inStore = storeDir === '.' || rel.startsWith(`${storeDir}/`);
        let src;
        try { src = readFileSync(file, 'utf8'); } catch { continue; }
        let sites = [];
        if (CODE.test(rel)) sites = scanLocators(src, framework);
        else if (inStore && /\.ya?ml$/.test(rel)) sites = scanYaml(src, framework);
        else if (inStore && rel.endsWith('.json')) {
          let map = null;
          try { map = JSON.parse(src); } catch { /* not ours */ }
          if (map && typeof map === 'object') sites = Object.keys(map).map((key) => ({ line: 1, key, id: sidecar[`${rel}#${key}`] ?? null, statement: `${key}: ${JSON.stringify(map[key])}`, positional: bannedSelector(String(map[key]).replace(/^(?:css|xpath)=/, ''), framework) }));
        }
        if (!sites.length) continue;
        filesWithLocators++;
        for (const site of sites) {
          count++;
          const where = `${rel}:${site.line}`;
          const shown = site.statement.split('\n')[0].slice(0, 100);
          if (site.positional) {
            const declined = site.id && known.has(site.id) ? records?.read(site.id)?.declined : null;
            if (declined) { cited.push({ where, id: site.id, why: declined }); continue; }
            findings.push({ where, what: `${shown} — ${site.positional}${isIndexReason(site.positional) ? '' : ' (COR never issues this shape)'}.`, fix: await fixFor(site) });
          } else if (site.id && (known.has(site.id) || !recordsOn)) {
            const declined = recordsOn ? records?.read(site.id)?.declined : null;
            if (declined) { cited.push({ where, id: site.id, why: declined }); continue; }
            // Review fix: an id copied onto another locator, or an entry extended with a typed step, finds a different
            // element than its record — checked by element on the record's page (R46: never by comparing text).
            const drift = recordsOn ? await elementDrift(site) : null;
            if (drift) findings.push({ where, what: drift, fix: await fixFor(site) });
            continue; // issued by COR (with records off, the id is all there is to check)
          } else if (site.id) {
            findings.push({ where, what: `cor:${site.id} is not a record COR issued in this project (copied from elsewhere, or edited?).`, fix: await fixFor(site) });
          } else {
            findings.push({ where, what: `${shown} — no COR id.`, fix: await fixFor(site) });
          }
        }
      }

      /** Review fix: an id on a locator that, on the record's own page, finds a different element than the one recorded. */
      async function elementDrift(site) {
        const record = records?.read(site.id);
        if (!page || !site.expression || !record || pathOf(record.page) !== pathOf(recordPage(page.url()))) return null;
        try {
          const loc = parseGradable(site.expression).build(page);
          if (await loc.count() !== 1) return null; // broken or ambiguous here: cor_grade / cor_heal territory, not identity
          const handle = await loc.elementHandle();
          const r = await callPage(page, 'inspect', { element: handle, framework: 'playwright', max: 1 }).finally(() => handle.dispose());
          return r.capture?.elementKey && r.capture.elementKey !== record.elementKey
            ? `cor:${site.id} was issued for another element on this page — the locator was edited after COR issued it.` : null;
        } catch { return null; }
      }

      /** COR's fix for a site: run its locator on the open page; the element it finds gets an entry (or its existing id). */
      async function fixFor(site) {
        if (fixes++ >= MAX_FIXES) return ['Fix the ones above and run cor_check again for this one.'];
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
        let entry = null;
        let declined = null;
        try { ({ entry, declined } = await inspector({ element: handle, quiet: true })); } catch { /* page changed under us */ } finally { await handle.dispose().catch(() => {}); }
        if (!entry) return ['COR has no durable locator for this element — cor_inspect it for the recommendation.'];
        const id = ID_PATTERN.exec(entry.join('\n'))?.[1];
        if (id) known.add(id);
        // Review fix: the fix is for the element this locator finds on the OPEN page — say which page, in case it targets another.
        const on = `On ${pathOf(page.url())} (if this locator targets another page, cor_open it and run cor_check again):`;
        if (declined) return [on, ...entry.filter(Boolean).map((l) => `  ${l}`)];
        if (!site.positional && id && before.has(id)) return [on, `COR already has a record of this element: add \`// COR cor:${id}\` on the line above it (keep the locator).`];
        return [on, 'Replace it with COR\'s entry:', ...entry.filter(Boolean).map((l) => `  ${l}`)];
      }

      const cut = listed.truncated ? ` Scanned the first ${MAX_FILES} files only — pass files to check the rest.` : '';
      const declinedNote = cited.length ? `, ${cited.length} declined (cited)` : '';
      const head = `cor_check: ${count} locator${count === 1 ? '' : 's'} in ${filesWithLocators} file${filesWithLocators === 1 ? '' : 's'} (${scope}) — ${count - findings.length - cited.length} carry a COR id${declinedNote}, ${findings.length} to fix.${cut}`;
      const citedLines = cited.length ? ['', 'Declined, cited — COR found no durable locator; each needs a test attribute in the app:', ...cited.map((c) => `  ${c.where} cor:${c.id} — ${c.why}`)] : [];
      if (listed.truncated && !findings.length) return text([head, ...citedLines].join('\n'), true);
      if (!findings.length) return text(`${[head, ...citedLines].join('\n')}${recordsOn ? '' : '\nNo .cor/records/ in this project (records off): ids were checked for presence only.'}`);
      const lines = [head, ...citedLines, ''];
      for (const f of findings.slice(0, MAX_FINDINGS)) lines.push(`✗ ${f.where} — ${f.what}`, ...f.fix.map((l) => `  ${l}`), '');
      if (findings.length > MAX_FINDINGS) lines.push(`… ${findings.length - MAX_FINDINGS} more — fix these and run cor_check again.`);
      return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }], isError: true };
    },
  }];
}
