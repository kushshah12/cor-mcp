import { defineConfig } from 'tsup';

// The page bundle: the engine plus src/page/entry.js as one IIFE, evaluated
// inside the browser page by src/page-runtime.js. (U3 adds the Node bundle.)
export default defineConfig({
  entry: { page: 'src/page/entry.js' },
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  minify: true,
  clean: false,
});
