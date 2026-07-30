#!/usr/bin/env node
/**
 * Headless driver for Total Gym Logbook.
 *
 * Launches the Blazor dev server if it is not already up, drives the running app in headless
 * Chromium, screenshots both rendering tiers, and asserts the things that actually break.
 *
 * Usage (from repo root):
 *   node .claude/skills/run-totalgymlogbook/driver.mjs
 *   node .claude/skills/run-totalgymlogbook/driver.mjs --keep     # leave the server running
 *   node .claude/skills/run-totalgymlogbook/driver.mjs --dark     # dark colour scheme
 *   PORT=5300 node .claude/skills/run-totalgymlogbook/driver.mjs
 *
 * Exit code 0 = the app rendered both tiers with no console errors.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PORT = process.env.PORT ?? '5232';
const URL = `http://localhost:${PORT}`;
const SHOTS = join(HERE, 'screenshots');
const KEEP = process.argv.includes('--keep');
const DARK = process.argv.includes('--dark');

mkdirSync(SHOTS, { recursive: true });

/**
 * GOTCHA: Playwright's npm package pins a browser build number, but this machine's
 * ~/.cache/ms-playwright may hold a different one (installed by some other tool). Mismatch
 * gives "Executable doesn't exist at .../chromium_headless_shell-1234/..." even though a
 * perfectly good Chromium is sitting right there. Find whatever build is actually present
 * rather than pinning a version.
 */
function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined; // let Playwright try its own resolution

  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
    .filter(existsSync);

  return candidates[0];
}

async function waitForServer(ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

let server;
async function ensureServer() {
  if (await waitForServer(2000)) {
    console.log(`server already up on ${URL}`);
    return false;
  }

  console.log(`starting dev server on ${URL} ...`);
  server = spawn(
    'dotnet',
    ['run', '--project', 'src/TotalGymLogBook.Web', '--urls', `http://0.0.0.0:${PORT}`],
    { cwd: REPO, stdio: 'ignore', detached: false },
  );

  if (!(await waitForServer())) {
    throw new Error(`dev server never came up on ${URL}. Run it manually to see the error:
  dotnet run --project src/TotalGymLogBook.Web --urls http://0.0.0.0:${PORT}`);
  }
  console.log('server up');
  return true;
}

/**
 * GOTCHA: <tg-app-shell> renders into a CLOSED-over shadow root, so ordinary Playwright
 * selectors ("#level", "text=Level 8") never match. Everything inside the instant tier has
 * to be reached through el.shadowRoot from inside an evaluate().
 */
const shellEval = (page, fn, ...args) =>
  page.locator('tg-app-shell').evaluate(fn, ...args);

async function main() {
  const startedByUs = await ensureServer();
  const executablePath = findChromium();
  console.log(`chromium: ${executablePath ?? '(playwright default)'}`);

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, // phone-sized; this is a gym app
    colorScheme: DARK ? 'dark' : 'light',
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? '  ' + detail : ''}`);
  };

  console.log(`\nnav ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // ---- Instant tier: web components, no .NET required (docs/adr/0003) ----
  console.log('\nInstant tier (web components, pre-Blazor):');
  await page.waitForSelector('tg-app-shell', { timeout: 15_000 });
  const lb0 = await shellEval(page, (el) => el.shadowRoot?.getElementById('lb')?.textContent);
  check('shell rendered a resistance readout', !!lb0 && lb0 !== '—', `${lb0} lb`);
  await page.screenshot({ path: join(SHOTS, '01-instant.png'), fullPage: true });

  // ---- Derived tier: Blazor boots and fills #blazor-root ----
  // GOTCHA: index.html calls Blazor.start() manually from requestIdleCallback, so the runtime
  // arrives well after load. Do not waitForLoadState('networkidle') -- wait for the content.
  console.log('\nDerived tier (Blazor WASM):');
  let blazorOk = true;
  try {
    await page.waitForFunction(
      () => document.querySelector('#blazor-root')?.textContent?.includes('Load ladder'),
      { timeout: 60_000 },
    );
  } catch {
    blazorOk = false;
  }
  check('Blazor booted and rendered', blazorOk);

  const rows = await page.locator('#blazor-root tbody tr').count().catch(() => 0);
  check('load ladder has 14 rows', rows === 14, `${rows} rows`);
  await page.screenshot({ path: join(SHOTS, '02-full.png'), fullPage: true });

  // ---- Cross-language agreement: both tiers compute the same number ----
  const blazorL8 = await page
    .locator('#blazor-root tbody tr')
    .nth(7)
    .locator('td')
    .nth(2)
    .innerText()
    .catch(() => '');
  check(
    'TypeScript and C# agree at level 8',
    lb0?.trim() === blazorL8.trim(),
    `shell=${lb0} blazor=${blazorL8}`,
  );

  // ---- Interact: move the level slider ----
  console.log('\nInteraction:');
  await shellEval(page, (el) => {
    const s = el.shadowRoot.getElementById('level');
    s.value = '14';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const lbMax = await shellEval(page, (el) => el.shadowRoot.getElementById('lb').textContent);
  check('slider level 8 -> 14 raises load', Number(lbMax) > Number(lb0), `${lb0} -> ${lbMax} lb`);

  // ---- Interact: pulley must halve exactly (docs/adr/0004) ----
  await shellEval(page, (el) => {
    const c = el.shadowRoot.getElementById('pulley');
    c.checked = true;
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const lbCable = await shellEval(page, (el) => el.shadowRoot.getElementById('lb').textContent);
  check(
    'pulley halves the load',
    Math.abs(Number(lbCable) * 2 - Number(lbMax)) < 0.15,
    `${lbMax} -> ${lbCable} lb`,
  );

  // ---- Interact: added weight is discounted by the incline ----
  await shellEval(page, (el) => {
    const v = el.shadowRoot.getElementById('vest');
    v.value = '20';
    v.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const hint = await shellEval(page, (el) =>
    el.shadowRoot.getElementById('hint').textContent.trim(),
  );
  check('vest hint explains the discount', /contributes/.test(hint), hint);

  await page.screenshot({ path: join(SHOTS, '03-interacted.png'), fullPage: true });

  console.log('\nConsole:');
  check('no console errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  if (server && !KEEP) server.kill('SIGTERM');
  if (startedByUs && KEEP) console.log(`\nserver left running on ${URL} (--keep)`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(failed.length ? `\n\x1b[31m${failed.length} check(s) failed\x1b[0m` : '\n\x1b[32mAll checks passed\x1b[0m');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
