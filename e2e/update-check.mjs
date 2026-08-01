#!/usr/bin/env node
/**
 * Verifies a NEW DEPLOY actually reaches an already-installed app.
 *
 * This is the check that would have caught the bug it exists for. The stock Blazor service
 * worker installs a new build and then parks it in 'waiting' until every client of the old
 * worker closes. A browser tab satisfies that within a day. An iPhone home-screen PWA does not
 * -- resuming from the app switcher is not a fresh navigation, and the old client never
 * retires -- so the trainee stays on the build they first installed, with no visible way out
 * and nothing in any log to say so.
 *
 * Nothing else in the suite can see this. offline-check.mjs runs a SINGLE build; the failure
 * only exists on the SECOND one. So this publishes once, installs it, then mutates the served
 * worker to look like a redeploy and drives the full handshake:
 *
 *   registration.update()  ->  new worker installs and waits
 *                          ->  banner appears
 *                          ->  Update tapped -> SKIP_WAITING -> controllerchange -> reload
 *                          ->  the new worker is in control
 *
 * The foreground check is exercised the way iOS triggers it -- by backgrounding the page and
 * bringing it back -- rather than by calling update() directly, because "does the app notice
 * on resume" IS the thing under test.
 *
 * Usage (from repo root):
 *   node e2e/update-check.mjs
 *
 * Exit code 0 = a redeploy is detected, offered, and applied without losing the logbook.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = Number(process.env.PORT ?? 5234);
const SHOTS = join(HERE, 'screenshots');

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

    if (!path.startsWith(root)) path = join(root, 'index.html');
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');

    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      // The worker files must never be stale-cached, or the browser never even looks at the
      // new build (docs/adr/0008). Serving them from disk each request is the point here.
      'Cache-Control': /index\.html|service-worker/.test(path) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(readFileSync(path));
  });

  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? '  ' + detail : ''}`);
};

/** Resolves when the banner is showing, or false on timeout. Never hangs the run. */
async function bannerVisible(page, timeout) {
  try {
    await page.waitForSelector('tg-update-banner[open]', { timeout });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const out = mkdtempSync(join(tmpdir(), 'tglb-update-'));
  console.log(`publishing to ${out} ...`);
  execFileSync(
    'dotnet',
    ['publish', join(REPO, 'src/TotalGymLogBook.Web'), '-c', 'Release', '-o', out, '--nologo', '-v', 'quiet'],
    { stdio: 'inherit' },
  );

  const root = normalize(join(out, 'wwwroot'));
  const workerPath = join(root, 'service-worker.js');
  const server = await serve(root);
  const url = `http://localhost:${PORT}`;
  console.log(`serving published output on ${url}\n`);

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- Build 1 installs ----
  console.log('First install:');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bw', { timeout: 30_000 });

  const ready = await page.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 45_000)),
    ]),
  );
  check('build 1 service worker active', ready === true);

  // A first install is not an update. If the banner shows here, every new user is told to
  // update to the version they just downloaded.
  const prematureBanner = await bannerVisible(page, 3_000);
  check('no update banner on a first install', prematureBanner === false);

  // Something in the logbook, so the reload at the end has something to lose.
  await page.selectOption('#notches', { label: '14 levels' });
  await page.click('#start');
  await page.waitForSelector('tg-set-logger #log', { timeout: 30_000 });
  await page.locator('tg-set-logger #log').click();
  await page.locator('tg-session-list li').first().waitFor({ timeout: 15_000 });
  check('a set was logged on build 1', true);

  // ---- Redeploy ----
  console.log('\nRedeploy:');
  // A byte-different worker script is exactly what a real redeploy produces, and it is what
  // the browser compares. The assets manifest is untouched, so the precache still succeeds --
  // this isolates the handover, not the caching.
  const original = readFileSync(workerPath, 'utf8');
  writeFileSync(workerPath, `${original}\n// redeployed at ${Date.now()}\n`);
  check('served worker differs from the installed one', true);

  // Returning to the foreground is what makes an iOS PWA look for a new build, so that is the
  // path under test. The event is dispatched rather than provoked with bringToFront(): headless
  // Chromium keeps every page visible and never fires visibilitychange on tab switches
  // (verified -- the listener simply does not run). Firing the event on resume is the
  // platform's guarantee; what this checks is that our handler does the right thing with it.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  const offered = await bannerVisible(page, 45_000);
  check('returning to the app detects the new build', offered);

  if (offered) {
    await page.screenshot({ path: join(SHOTS, '07-update-banner.png'), fullPage: true });
  }

  // ---- Applying it ----
  console.log('\nApplying the update:');
  const before = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);

  const reloaded = page.waitForEvent('load', { timeout: 45_000 }).then(() => true).catch(() => false);
  await page.locator('tg-update-banner').evaluate((el) => el.shadowRoot.getElementById('update').click());
  check('tapping Update reloads the app', (await reloaded) === true);

  await page.waitForSelector('tg-set-logger, #bw', { timeout: 30_000 });

  const took = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { waiting: reg?.waiting !== null && reg?.waiting !== undefined, controller: !!navigator.serviceWorker.controller };
  });
  check('the new worker took control', took.controller && !took.waiting,
    took.waiting ? 'still waiting' : 'controlling');
  check('controller was present before the swap too', before !== null);

  // The whole point is a seamless update, not a factory reset.
  const survived = await page.evaluate(() =>
    Promise.race([
      new Promise((resolve) => {
        const request = indexedDB.open('totalgymlogbook');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('setLogs', 'readonly');
          const count = tx.objectStore('setLogs').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(-1);
        };
        request.onerror = () => resolve(-1);
      }),
      new Promise((r) => setTimeout(() => r(-2), 10_000)),
    ]),
  );
  check('the logbook survived the update', survived === 1, `${survived} set(s)`);

  const bannerGone = await page.locator('tg-update-banner[open]').count();
  check('banner is gone after updating', bannerGone === 0);

  console.log('\nConsole:');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length
      ? `\n\x1b[31m${failed.length} update check(s) failed\x1b[0m`
      : `\n\x1b[32mAll ${results.length} update checks passed\x1b[0m`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
