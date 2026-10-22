import { defineConfig } from 'tsup';

export default defineConfig([
  // The page bundle: the engine plus src/page/entry.js as one IIFE, evaluated
  // inside the browser page by src/page-runtime.js.
  {
    entry: { page: 'src/page/entry.js' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
    minify: true,
    clean: false,
  },
  // The server: bin/ plus src/ as one minified file, so the published package
  // carries no readable source. `dependencies` (sdk, zod, playwright-core) stay
  // external — tsup's default. The engine only reaches the page bundle above.
  {
    entry: { 'cor-mcp': 'bin/cor-mcp.js' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
    minify: true,
    sourcemap: false,
    clean: false,
    // U4 (plan 2026-10-13-001): the write-only PostHog key is baked in at build time, only into the server bundle.
    // Unset (dev, tests) → empty → telemetry stays off. src/telemetry.js reads these two globals.
    define: {
      __COR_POSTHOG_KEY__: JSON.stringify(process.env.COR_POSTHOG_KEY || ''),
      __COR_POSTHOG_HOST__: JSON.stringify(process.env.COR_POSTHOG_HOST || ''),
    },
  },
]);
