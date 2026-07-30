#!/usr/bin/env node
/**
 * Headless driver for Total Gym Logbook.
 *
 * Launches the Blazor dev server if it is not already up, then drives the real user flow:
 * onboarding, logging a set, the rest timer, correcting a set, and the coach picking it all
 * up. Screenshots each stage.
 *
 * Usage (from repo root):
 *   node .claude/skills/run-totalgymlogbook/driver.mjs
 *   node .claude/skills/run-totalgymlogbook/driver.mjs --keep     # leave the server running
 *   node .claude/skills/run-totalgymlogbook/driver.mjs --dark     # dark colour scheme
 *   PORT=5300 node .claude/skills/run-totalgymlogbook/driver.mjs
 *
 * Exit code 0 = the whole loop worked with no console errors.
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

  // ---- Onboarding: three questions (docs/adr/0010) ----
  //
  // NOTE: Playwright's CSS engine pierces OPEN shadow roots, so these plain locators reach
  // inside <tg-app-shell> without any special handling.
  console.log('\nOnboarding (instant tier, no .NET yet):');
  await page.waitForSelector('#bw', { timeout: 20_000 });

  const questions = await page.locator('tg-app-shell select, tg-app-shell input').count();
  check('asks exactly three questions', questions === 3, `${questions} inputs`);

  await page.fill('#bw', '180');
  await page.selectOption('#notches', { label: '14 levels' });
  await page.selectOption('#goal', { label: 'Build muscle' });
  await page.screenshot({ path: join(SHOTS, '01-onboarding.png'), fullPage: true });
  await page.click('#start');

  // ---- Workout screen ----
  console.log('\nLogging a set:');
  await page.waitForSelector('#logger', { timeout: 15_000 });
  check('reached the workout screen', true);

  const load0 = await page.locator('tg-set-logger #load').innerText();
  check('load readout computed with no .NET', Number(load0) > 0, `${load0} lb`);

  // Chest press is a cable movement, so the pulley note must be visible.
  const note = await page.locator('tg-set-logger #loadNote').innerText();
  check('flags cable exercises', /half the incline load/.test(note), note.trim());

  await page.locator('tg-set-logger #plus').click();
  await page.locator('tg-set-logger #plus').click();
  const reps = await page.locator('tg-set-logger #reps').inputValue();
  check('rep stepper works', reps === '12', `${reps} reps`);

  await page.screenshot({ path: join(SHOTS, '02-logger.png'), fullPage: true });

  await page.locator('tg-set-logger #log').click();
  await page.waitForSelector('tg-session-list li', { timeout: 10_000 });

  const rows = await page.locator('tg-session-list li').count();
  check('set appears in the session list', rows === 1, `${rows} rows`);

  // ---- Rest timer: deadline-based (docs/adr/0005) ----
  console.log('\nRest timer:');
  const timerVisible = await page.locator('tg-rest-timer').isVisible();
  check('starts automatically after a set', timerVisible);

  const t1 = await page.locator('tg-rest-timer #time').innerText();
  await page.waitForTimeout(1500);
  const t2 = await page.locator('tg-rest-timer #time').innerText();
  check('counts down from the deadline', t1 !== t2, `${t1} -> ${t2}`);

  // Survives a reload, because the deadline is absolute rather than a decrementing counter.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tg-rest-timer #time', { timeout: 15_000 });
  const t3 = await page.locator('tg-rest-timer #time').innerText();
  check('survives a reload', Boolean(t3) && t3 !== '0:00', `${t3} after reload`);

  // ---- Two more sets, then correction ----
  console.log('\nMore sets and a correction:');
  await page.waitForSelector('tg-set-logger #log', { timeout: 15_000 });
  for (let i = 0; i < 2; i++) {
    await page.locator('tg-set-logger #log').click();
    await page.waitForTimeout(250);
  }

  const rows3 = await page.locator('tg-session-list li').count();
  check('three sets logged', rows3 === 3, `${rows3} rows`);

  page.once('dialog', (d) => d.accept('8'));
  await page.locator('tg-session-list button[aria-label="Edit reps"]').first().click();
  await page.waitForTimeout(400);
  const firstReps = await page.locator('tg-session-list .reps').first().innerText();
  check('a mistyped set can be corrected', firstReps === '8', `${firstReps} reps`);

  await page.locator('tg-session-list button[aria-label="Delete set"]').first().click();
  await page.waitForTimeout(400);
  const rowsAfterDelete = await page.locator('tg-session-list li').count();
  check('a set can be deleted', rowsAfterDelete === 2, `${rowsAfterDelete} rows`);

  await page.screenshot({ path: join(SHOTS, '03-session.png'), fullPage: true });

  // ---- Derived tier: Blazor reads what the shell wrote ----
  console.log('\nDerived tier (Blazor reads the logbook):');
  let blazorOk = true;
  try {
    await page.waitForSelector('#empty-state, #rec-load', { timeout: 60_000 });
  } catch {
    blazorOk = false;
  }
  check('Blazor booted and read the logbook', blazorOk);

  const recLoad = await page.locator('#rec-load').innerText().catch(() => '');
  const recWhy = await page.locator('#rec-why').innerText().catch(() => '');
  check('coach produced a recommendation', recLoad.trim().length > 0, recLoad.replace(/\s+/g, ' '));
  check('rationale is plain language', recWhy.length > 20, recWhy.slice(0, 70) + '…');

  // The recommendation must be built against the SAME exercise that was logged. Chest press is
  // a cable movement, so its ladder is halved; a coach that ignores the pulley factor compares
  // 28.4 lb against a 61.4 lb direct-press rung and tells the trainee to double their load.
  const loggedLb = Number(await page.locator('tg-set-logger #load').innerText());
  const recommendedLb = Number(recLoad.replace(/[^\d.]/g, ''));
  const step = recommendedLb / loggedLb;
  check(
    'recommendation is a sane step, not a different exercise',
    step > 1 && step < 1.3,
    `${loggedLb} -> ${recommendedLb} lb (x${step.toFixed(2)})`,
  );

  await page.screenshot({ path: join(SHOTS, '04-coach.png'), fullPage: true });

  console.log('\nConsole:');
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  if (server && !KEEP) server.kill('SIGTERM');
  if (startedByUs && KEEP) console.log(`\nserver left running on ${URL} (--keep)`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(
    failed.length
      ? `\n\x1b[31m${failed.length} check(s) failed\x1b[0m`
      : `\n\x1b[32mAll ${results.length} checks passed\x1b[0m`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
