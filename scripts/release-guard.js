// Refuses a publish while the engine is the local working copy (file: spec or a symlink),
// so a release is always built against a tagged engine.
import { readFileSync, lstatSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const spec = pkg.devDependencies['@corlabs/engine'];
const link = new URL('../../../node_modules/@corlabs/engine', import.meta.url);

const problems = [];
if (!spec || spec.startsWith('file:')) problems.push(`package.json pins the engine as "${spec}" — pin a git tag (github:…#vX.Y.Z)`);
if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) problems.push('node_modules/@corlabs/engine is a symlink to a local copy — run `npm run dev:pinned-engine`');
// U4: a release without the telemetry key would ship with telemetry silently off.
if (!process.env.COR_POSTHOG_KEY) problems.push('COR_POSTHOG_KEY is not set — the release would ship with telemetry off. Set the write-only key, or ship deliberately without it');
if (problems.length) {
  console.error(`release blocked:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
