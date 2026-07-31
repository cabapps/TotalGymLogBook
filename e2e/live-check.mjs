#!/usr/bin/env node
/**
 * Verifies a LIVE deployment.
 *
 * offline-check.mjs proves the published output is sound; this proves the host is serving it
 * correctly. Those are different failures. staticwebapp.config.json -- the cache headers, the
 * MIME types, the navigation fallback -- has no effect locally and is only exercised once the
 * app is on Azure.
 *
 * The cache headers are the ones worth checking. index.html, service-worker.js, and
 * service-worker-assets.js are the only unfingerprinted entry points; if a CDN pins any of
 * them, every user is stuck on a stale build with NO recovery path (docs/adr/0008).
 *
 * Usage:
 *   node e2e/live-check.mjs https://your-app.azurestaticapps.net
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');
const BASE = (process.argv[2] ?? '').replace(/\/$/, '');

if (!BASE) {
  console.error('Usage: node e2e/live-check.mjs https://your-app.azurestaticapps.net');
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? '  ' + detail : ''}`);
};

function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  return readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort().reverse()
    .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
    .filter(existsSync)[0];
}

async function head(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'follow' });
  await res.arrayBuffer().catch(() => undefined);
  return res;
}

console.log(`Checking ${BASE}\n`);

// ---- Transport and headers: things only the host can get wrong ----
console.log('Serving:');

const index = await head('/');
check('index.html served', index.ok, `HTTP ${index.status}`);
check('HTTPS', BASE.startsWith('https://'), BASE.split(':')[0]);

const html = await (await fetch(BASE)).text();
check('import map populated', html.includes('<script type="importmap">{'),
  html.includes('importmap') ? 'present' : 'MISSING - Blazor will not load');
check('no unsubstituted fingerprint placeholder', !html.includes('{fingerprint}'));
check('shell bundle referenced', /dist\/shell[.\w]*\.js/.test(html));

console.log('\nCache headers (the only recovery path if a build goes bad):');
for (const path of ['/', '/service-worker.js', '/service-worker-assets.js']) {
  const res = await head(path);
  const cc = res.headers.get('cache-control') ?? '(none)';
  // Anything that lets a CDN or browser hold these is a trap: they are unfingerprinted, so a
  // stale copy pins users to an old build forever.
  const revalidates = /no-cache|no-store|max-age=0|must-revalidate/i.test(cc);
  check(`${path} revalidates`, revalidates, cc);
}

console.log('\nMIME types (Blazor refuses to boot on a wrong one):');
const swAssets = await (await fetch(`${BASE}/service-worker-assets.js`)).text();
const wasmUrl = swAssets.match(/"(_framework\/dotnet\.native\.[^"]+\.wasm)"/)?.[1];
if (wasmUrl) {
  const res = await head(`/${wasmUrl}`);
  const type = res.headers.get('content-type') ?? '(none)';
  check('runtime .wasm is application/wasm', /application\/wasm/.test(type), type);
  check('runtime .wasm reachable', res.ok, `HTTP ${res.status}`);
} else {
  check('found a runtime wasm in the asset manifest', false, 'could not parse manifest');
}

const manifest = await head('/manifest.webmanifest');
check('web manifest served', manifest.ok,
  manifest.headers.get('content-type') ?? `HTTP ${manifest.status}`);

console.log('\nNavigation fallback (deep links must reach the app, not a 404):');
const deep = await head('/some/deep/route');
const deepHtml = deep.ok ? await (await fetch(`${BASE}/some/deep/route`)).text() : '';
check('unknown route returns the app', deep.ok && deepHtml.includes('tg-app-shell'),
  `HTTP ${deep.status}`);

const missingAsset = await head('/_framework/definitely-not-real.js');
check('missing asset 404s instead of returning HTML', missingAsset.status === 404,
  `HTTP ${missingAsset.status}`);

// ---- The app itself ----
console.log('\nIn a browser:');
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

let shell = true;
try {
  await page.waitForSelector('#bw', { timeout: 30_000 });
} catch { shell = false; }
check('instant tier renders', shell);

if (shell) {
  await page.fill('#bw', '180');
  await page.selectOption('#notches', { label: '14 levels' });
  await page.click('#start');

  let logger = true;
  try {
    await page.waitForSelector('#logger', { timeout: 20_000 });
  } catch { logger = false; }
  check('onboarding completes and the logger appears', logger);

  if (logger) {
    await page.locator('tg-set-logger #log').click();
    await page.waitForSelector('tg-session-list li', { timeout: 15_000 }).catch(() => undefined);
    const rows = await page.locator('tg-session-list li').count();
    check('a set logs and persists', rows === 1, `${rows} rows`);
  }

  // The bug that shipped green locally. This is the check that would have caught it.
  let blazor = true;
  try {
    await page.waitForSelector('#empty-state, #rec-load', { timeout: 90_000 });
  } catch { blazor = false; }
  check('Blazor loads and the coach renders', blazor);
}

const sw = await page.evaluate(async () => {
  const reg = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 15000)),
  ]);
  return reg === true;
});
check('service worker registers', sw);

await page.screenshot({ path: join(SHOTS, '07-live.png'), fullPage: true });
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nscreenshot: ${join(SHOTS, '07-live.png')}`);
console.log(
  failed.length
    ? `\n\x1b[31m${failed.length} of ${results.length} checks failed\x1b[0m`
    : `\n\x1b[32mAll ${results.length} live checks passed\x1b[0m`,
);
process.exit(failed.length ? 1 : 0);
