#!/usr/bin/env node
/**
 * Verifies the app actually works offline.
 *
 * This CANNOT be tested against `dotnet run`. Blazor ships a no-op service-worker.js for
 * development and swaps in service-worker.published.js only on publish (docs/adr/0008), so the
 * dev server proves nothing about offline behaviour. This script publishes, serves the output
 * from a static server with correct MIME types, and then pulls the network out.
 *
 * Usage (from repo root):
 *   node e2e/offline-check.mjs
 *   KEEP_PUBLISH=1 node e2e/offline-check.mjs   # keep the output dir
 *
 * Exit code 0 = the app boots, logs a set, and persists it with the network disconnected.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = Number(process.env.PORT ?? 5233);
const SHOTS = join(HERE, 'screenshots');

/** Blazor will not boot if .wasm is served as anything but application/wasm. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.dat': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  return readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
    .filter(existsSync)[0];
}

function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));

    // Directory or unknown path -> index.html, matching the SWA navigation fallback.
    if (!path.startsWith(root)) path = join(root, 'index.html');
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');

    const body = readFileSync(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      // index.html and the worker files must never be stale-cached (docs/adr/0008).
      'Cache-Control': /index\.html|service-worker/.test(path) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
  });

  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? '  ' + detail : ''}`);
};

async function main() {
  const out = mkdtempSync(join(tmpdir(), 'tglb-offline-'));
  console.log(`publishing to ${out} ...`);
  execFileSync('dotnet', ['publish', join(REPO, 'src/TotalGymLogBook.Web'), '-c', 'Release', '-o', out, '--nologo', '-v', 'quiet'], { stdio: 'inherit' });

  const root = normalize(join(out, 'wwwroot'));
  const server = await serve(root);
  const url = `http://localhost:${PORT}`;
  console.log(`serving published output on ${url}\n`);

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- First visit, online: the worker installs and precaches ----
  console.log('Online, first visit:');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bw', { timeout: 30_000 });
  check('published build boots', true);

  const controlled = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  check('service worker activated', controlled);

  // Complete onboarding so there is real data to survive the disconnect.
  await page.fill('#bw', '180');
  await page.selectOption('#notches', { label: '14 levels' });
  await page.click('#start');
  await page.waitForSelector('#logger', { timeout: 20_000 });
  await page.locator('tg-set-logger #log').click();
  await page.waitForSelector('tg-session-list li', { timeout: 10_000 });
  check('logged a set while online', true);

  // Verify Blazor boots ONLINE from the published build BEFORE pulling the network. Without
  // this, an offline failure is ambiguous -- and the published build really was broken once
  // (a missing importmap), which looked like an offline problem but was not.
  let blazorOnline = true;
  try {
    await page.waitForSelector('#empty-state, #rec-load', { timeout: 60_000 });
  } catch {
    blazorOnline = false;
  }
  check('Blazor boots online from the published build', blazorOnline);

  // A reload is what puts the page under the worker's control.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#logger', { timeout: 30_000 });

  const cachedCount = await page.evaluate(async () => {
    const names = await caches.keys();
    let total = 0;
    for (const name of names) total += (await (await caches.open(name)).keys()).length;
    return total;
  });
  check('assets precached', cachedCount > 20, `${cachedCount} entries`);

  // ---- Offline ----
  console.log('\nNetwork disconnected:');
  await ctx.setOffline(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  let booted = true;
  try {
    await page.waitForSelector('#logger', { timeout: 45_000 });
  } catch {
    booted = false;
  }
  check('app boots with no network', booted);

  const priorRows = await page.locator('tg-session-list li').count();
  check('previously logged sets are still there', priorRows >= 1, `${priorRows} rows`);

  await page.locator('tg-set-logger #log').click();
  await page.waitForTimeout(600);
  const offlineRows = await page.locator('tg-session-list li').count();
  check('can log a set offline', offlineRows === priorRows + 1, `${offlineRows} rows`);

  // Blazor is the real test of precaching -- it is 2 MB of wasm across ~40 files.
  let blazorOffline = true;
  try {
    await page.waitForSelector('#empty-state, #rec-load', { timeout: 60_000 });
  } catch {
    blazorOffline = false;
  }
  check('Blazor runtime loads from cache', blazorOffline);

  await page.screenshot({ path: join(SHOTS, '06-offline.png'), fullPage: true });

  // ---- Back online: data written offline must survive ----
  console.log('\nBack online:');
  await ctx.setOffline(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tg-session-list li', { timeout: 30_000 });
  const finalRows = await page.locator('tg-session-list li').count();
  check('sets logged offline persisted', finalRows === offlineRows, `${finalRows} rows`);

  console.log('\nConsole:');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  server.close();
  if (!process.env.KEEP_PUBLISH) rmSync(out, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length
      ? `\n\x1b[31m${failed.length} check(s) failed\x1b[0m`
      : `\n\x1b[32mAll ${results.length} offline checks passed\x1b[0m`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
