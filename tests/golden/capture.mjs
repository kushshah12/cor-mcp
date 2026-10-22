#!/usr/bin/env node
// U1 — capture a real site as a frozen, offline golden page: the post-hydration DOM with its
// stylesheets inlined, open shadow roots serialised, and scripts stripped (a frozen page must not
// re-run its own JS). Same approach as cor-benchmark/tools/snapshot.mjs. Never automatic:
// re-capture overwrites in place so `git diff` is the review.
//
//   node tests/golden/capture.mjs            # every site below
//   node tests/golden/capture.mjs saucedemo-inventory
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const login = async (page) => {
  await page.fill('[data-test="username"]', 'standard_user');
  await page.fill('[data-test="password"]', 'secret_sauce');
  await page.click('[data-test="login-button"]');
  await page.waitForURL('**/inventory.html');
};

export const SITES = {
  'saucedemo-login': { url: 'https://www.saucedemo.com/' },
  'saucedemo-inventory': { url: 'https://www.saucedemo.com/', steps: login },
  bstackdemo: { url: 'https://www.bstackdemo.com/', ready: '.shelf-item' },
};

const SERIALIZE = () => {
  const roots = [];
  const walk = (r) => { for (const el of r.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  return { html: document.documentElement.getHTML({ serializableShadowRoots: true, shadowRoots: roots }), shadowRoots: roots.length };
};

const absolutise = (css, href) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
  if (/^(data:|https?:|\/\/|#)/i.test(ref)) return m;
  try { return `url(${q}${new URL(ref, href).href}${q})`; } catch { return m; }
});

async function capture(id, { url, steps, ready }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    if (steps) await steps(page);
    if (ready) await page.waitForSelector(ready);
    await page.waitForLoadState('networkidle');
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => l.href));
    const sheets = [];
    for (const href of hrefs) {
      const res = await page.request.get(href).catch(() => null);
      if (res?.ok()) sheets.push(`/* ${href} */\n${absolutise(await res.text(), href)}`);
    }
    const { html, shadowRoots } = await page.evaluate(SERIALIZE);
    const frozen = `<!doctype html>\n${html}`
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi, '')
      .replace('</head>', `<style>\n${sheets.join('\n')}\n</style></head>`);
    const dir = new URL(`./sites/${id}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('page.html', dir), frozen);
    writeFileSync(new URL('meta.json', dir), `${JSON.stringify({ id, url, finalUrl: page.url(), capturedAt: new Date().toISOString().slice(0, 10), stylesheetsInlined: sheets.length, shadowRoots }, null, 2)}\n`);
    console.log(`${id}: ${frozen.length} chars, ${sheets.length} sheets`);
  } finally {
    await browser.close();
  }
}

const only = process.argv.slice(2);
for (const [id, site] of Object.entries(SITES)) if (!only.length || only.includes(id)) await capture(id, site);
