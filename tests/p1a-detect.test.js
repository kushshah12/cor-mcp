// P1a: the test framework is read from the project's package.json (spec §6).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createSession } from '../src/session.js';
import { detectFramework, frameworkLine } from '../src/detect.js';

const root = mkdtempSync(join(tmpdir(), 'cor-p1a-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A project folder: files is { 'package.json': {…} | string, 'tsconfig.json': '{}' }. */
function project(name, files) {
  const dir = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const pkg = (devDependencies, extra = {}) => ({ name: 'x', devDependencies, ...extra });

test('each runner is found by its own package, with the major version and the add-ons', () => {
  const wdio = detectFramework(project('wdio', { 'package.json': pkg({ '@wdio/cli': '^9.2.1', typescript: '^5', '@testing-library/webdriverio': '^3' }) }));
  assert.equal(wdio.framework, 'webdriverio');
  assert.deepEqual([wdio.candidates[0].version, wdio.candidates[0].typescript, wdio.candidates[0].testingLibrary], ['9', true, true]);
  const cy = detectFramework(project('cy', { 'package.json': pkg({ cypress: '~16.1.0' }) }));
  assert.deepEqual([cy.framework, cy.candidates[0].version, cy.candidates[0].typescript, cy.candidates[0].testingLibrary], ['cypress', '16', false, false]);
  assert.equal(detectFramework(project('pw', { 'package.json': pkg({ '@playwright/test': '1.50.0' }) })).framework, 'playwright');
  assert.equal(detectFramework(project('wdio2', { 'package.json': pkg({ webdriverio: '8.40.0' }) })).candidates[0].version, '8');
});

test('TypeScript is also a tsconfig.json next to the package.json', () => {
  const d = detectFramework(project('ts', { 'package.json': pkg({ cypress: '16' }), 'tsconfig.json': '{}' }));
  assert.equal(d.candidates[0].typescript, true);
});

test('`playwright` alone is a library, not Playwright Test: it does not count', () => {
  const d = detectFramework(project('lib', { 'package.json': pkg({ playwright: '1.50.0', '@wdio/cli': '9.0.0' }) }));
  assert.equal(d.framework, 'webdriverio');
  assert.equal(d.ambiguous, false);
  assert.equal(detectFramework(project('lib2', { 'package.json': pkg({ playwright: '1.50.0', 'playwright-core': '1.50.0' }) })).framework, null);
});

test('two frameworks in one package.json: not guessed', () => {
  const d = detectFramework(project('two', { 'package.json': pkg({ cypress: '16', '@wdio/cli': '9' }) }));
  assert.deepEqual([d.framework, d.ambiguous, d.candidates.map((c) => c.framework)], [null, true, ['webdriverio', 'cypress']]);
});

test('no package.json anywhere: no framework', () => {
  const d = detectFramework(project('none', { 'README.md': 'nothing' }));
  assert.deepEqual([d.framework, d.candidates.length, d.ambiguous], [null, 0, false]);
});

test('a broken package.json is skipped, not thrown', () => {
  assert.equal(detectFramework(project('broken', { 'package.json': '{ nope' })).framework, null);
});

test('the nearest package.json wins over one further up', () => {
  const root2 = project('nest', { 'package.json': pkg({ '@wdio/cli': '9' }), 'apps/web/package.json': pkg({ cypress: '16' }) });
  assert.equal(detectFramework(join(root2, 'apps/web')).framework, 'cypress');
});

test('a folder below the root reads the root package.json when its own has no runner', () => {
  const r = project('below', { 'package.json': pkg({ cypress: '16' }), 'src/deep/package.json': { name: 'lib' } });
  assert.equal(detectFramework(join(r, 'src/deep')).framework, 'cypress');
});

test('monorepo: tests in packages/e2e, working directory at the root with workspaces', () => {
  const r = project('mono', {
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'packages/app/package.json': { name: 'app' },
    'packages/e2e/package.json': pkg({ '@wdio/cli': '^9.0.0', typescript: '5' }),
  });
  const d = detectFramework(r);
  assert.equal(d.framework, 'webdriverio');
  assert.equal(d.candidates[0].dir, join(r, 'packages/e2e'));
  const obj = project('mono2', { 'package.json': { workspaces: { packages: ['tests/e2e'] } }, 'tests/e2e/package.json': pkg({ cypress: '16' }) });
  assert.equal(detectFramework(obj).framework, 'cypress');
});

test('workspaces: two frameworks across packages are ambiguous; a package past the 20th is not read', () => {
  const two = project('mono3', {
    'package.json': { workspaces: ['packages/*'] },
    'packages/a/package.json': pkg({ cypress: '16' }),
    'packages/b/package.json': pkg({ '@playwright/test': '1.50.0' }),
  });
  assert.equal(detectFramework(two).ambiguous, true);
  const files = { 'package.json': { workspaces: ['packages/*'] } };
  for (let i = 0; i < 25; i++) files[`packages/p${String(i).padStart(2, '0')}/package.json`] = i === 22 ? pkg({ cypress: '16' }) : { name: `p${i}` };
  assert.equal(detectFramework(project('mono4', files)).framework, null);
});

test('the line cor_open prints names the framework, version, language and source', () => {
  const dir = project('line', { 'package.json': pkg({ '@wdio/cli': '^9.2.1', typescript: '5' }) });
  assert.equal(frameworkLine(detectFramework(dir)), 'Framework: WebdriverIO v9 (TypeScript) — from ./package.json (@wdio/cli). Override with framework: "…".');
  assert.match(frameworkLine(detectFramework(project('line2', { 'package.json': pkg({ cypress: '16', '@playwright/test': '1' }) }))), /^Framework: several found — Playwright v1 \(\.\/package\.json\), Cypress v16 \(\.\/package\.json\)\. Rendering Playwright unless a call passes framework: "playwright" or "cypress"\.$/);
  assert.equal(frameworkLine(detectFramework(project('line3', { 'x': 'y' }))), 'Framework: no framework found — rendering Playwright. Pass framework: "…" to change.');
});

test('U2 session: detected once and kept; an argument applies to its own call only (D3)', () => {
  const dir = project('sess', { 'package.json': pkg({ cypress: '16' }) });
  const session = createSession({ cwd: dir });
  assert.equal(session.resolveFramework(), 'cypress');
  rmSync(join(dir, 'package.json'));
  assert.equal(session.resolveFramework(), 'cypress', 'the file is not read again');
  assert.equal(session.resolveFramework('webdriverio'), 'webdriverio');
  assert.equal(session.resolveFramework(), 'cypress', 'an earlier argument does not stick');
  assert.equal(createSession({ cwd: project('sess2', { 'x': 'y' }) }).resolveFramework(), null);
});

// ── through the server ──
const site = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>Form</title><h1>Sign up</h1><label for="email">Email</label><input id="email" data-testid="email-input" type="email">');
});
let base;
before(async () => {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => { site.closeAllConnections?.(); site.close(); });

async function connect(t, cwd) {
  const session = createSession({ headless: true, cwd });
  t.after(() => session.close());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const server = createServer({ session });
  server.server.onclose = null;
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: name === 'cor_inspect' && !args.targets && !('detail' in args) ? { ...args, detail: true } : args });
    return r.content.map((c) => c.text).join('\n');
  };
}

test('cor_open names the framework; cor_inspect renders for it without an argument; U2: an argument applies to its call only', async (t) => {
  const call = await connect(t, project('e2e-cy', { 'package.json': pkg({ cypress: '16' }) }));
  const opened = await call('cor_open', { url: base });
  assert.match(opened, /\nFramework: Cypress v16 — from \.\/package\.json \(cypress\)\. Override with framework: "…"\.\nLocators: /); // U7: the conventions line follows
  const detected = await call('cor_inspect', { selector: '#email' });
  assert.match(detected, /cy\.get\(/);
  assert.doesNotMatch(detected, /page\.get/);
  const asked = await call('cor_inspect', { selector: '#email', framework: 'playwright' });
  assert.match(asked, /page\.getBy/);
  assert.match(await call('cor_inspect', { selector: '#email' }), /cy\.get\(/, 'U2 (D3): the argument does not stick');
});

test('two frameworks: cor_open asks, and output stays Playwright until the agent answers', async (t) => {
  const call = await connect(t, project('e2e-two', { 'package.json': pkg({ cypress: '16', '@wdio/cli': '9' }) }));
  assert.match(await call('cor_open', { url: base }), /Framework: several found — .*Rendering Playwright unless a call passes framework/);
  assert.match(await call('cor_inspect', { selector: '#email' }), /page\.getBy/);
});

test('cor_grade: the selector form beats the project framework; bare strings follow a WebdriverIO project', async (t) => {
  const call = await connect(t, project('e2e-wdio', { 'package.json': pkg({ '@wdio/cli': '9' }) }));
  await call('cor_open', { url: base });
  const bare = await call('cor_grade', { selector: 'h1=Sign up' }); // only a WebdriverIO string is read this way
  assert.match(bare, /1 match/);
  assert.match(bare, /alternative for the same element \(webdriverio\)/);
  const cy = await call('cor_grade', { selector: "cy.get('h1:nth-child(1)')" });
  assert.doesNotMatch(cy, /Not gradable/);
  assert.match(cy, /\(cypress\)/);
  assert.doesNotMatch(cy, /\(webdriverio\)/);
});
