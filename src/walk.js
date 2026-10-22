// One directory walker for the scans that read a team's repo (U7 spec scan, U9 cor_check): skips dependencies,
// build output and dot-folders, visits files in a stable order, and stops at its caps — `truncated` says it did.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.cor']);

/**
 * @param {string} root
 * @param {{ accept: (name: string) => boolean, maxFiles?: number, maxDepth?: number, maxDirs?: number }} options
 * @returns {string[] & { truncated: boolean }} absolute paths of accepted files
 */
export function walkFiles(root, { accept, maxFiles = Infinity, maxDepth = Infinity, maxDirs = Infinity }) {
  const out = [];
  out.truncated = false;
  let dirs = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || ++dirs > maxDirs) { out.truncated = true; return; }
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= maxFiles) { out.truncated = true; return; }
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (accept(name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}
