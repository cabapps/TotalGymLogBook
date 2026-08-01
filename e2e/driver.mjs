#!/usr/bin/env node
/**
 * Headless driver for Total Gym Logbook.
 *
 * Launches the Blazor dev server if it is not already up, then drives the real user flow:
 * onboarding, logging a set, the rest timer, correcting a set, and the coach picking it all
 * up. Screenshots each stage.
 *
 * Usage (from repo root):
 *   node e2e/driver.mjs
 *   node e2e/driver.mjs --keep     # leave the server running
 *   node e2e/driver.mjs --dark     # dark colour scheme
 *   PORT=5300 node e2e/driver.mjs
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
const REPO = join(HERE, '..');
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
    const before = await page.locator('tg-session-list li').count();
    await page.locator('tg-set-logger #log').click();
    // Wait for the row to actually appear rather than sleeping a guessed interval. Sessions
    // are created lazily now, so the first log after a reload carries an extra round trip.
    await page
      .waitForFunction(
        (n) => document.querySelector('tg-session-list')?.shadowRoot
          ?.querySelectorAll('li').length > n,
        before,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
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

  // ---- Weigh-in: smoothing feeds the load calculation (docs/adr/0004) ----
  console.log('\nWeigh-in:');
  const coverage0 = await page.locator('tg-weigh-in #coverage').innerText();
  check('prompts for more weigh-ins before calling a trend', /more weigh-in/.test(coverage0), coverage0);

  const loadBefore = Number(await page.locator('tg-set-logger #load').innerText());

  // Onboarding already recorded today's weight, so the form is collapsed behind a link --
  // deliberate, since re-prompting someone who already weighed in today is just noise.
  const collapsed = await page.locator('tg-weigh-in #toggle').count();
  check('collapses once weighed in today', collapsed === 1);
  if (collapsed) await page.locator('tg-weigh-in #toggle').click();

  // Smoothing needs a HISTORY to smooth. Onboarding recorded one reading today, and a second
  // entry today replaces it rather than accumulating (one row per calendar day), so seed a
  // week of prior days first -- otherwise there is nothing for the EMA to damp and the check
  // would pass vacuously.
  await page.evaluate(async () => {
    // Use the handle the shell publishes on globalThis rather than import()ing the bundle.
    // The dev server fingerprints static assets at serve time (dist/shell.<hash>.js) while
    // publish leaves the name alone, so any hardcoded or re-derived URL risks evaluating a
    // SECOND copy of the module, which dies on
    // "tg-set-logger has already been used with this registry".
    const m = globalThis.tglbDb;
    const day = 86_400_000;
    for (let i = 9; i >= 1; i--) {
      const d = new Date(Date.now() - i * day);
      const on = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await m.repo.recordBodyweight(on, 180);
    }
  });

  // A 6 lb jump on the scale against nine steady days.
  await page.fill('tg-weigh-in #lb', '186');
  await page.locator('tg-weigh-in button[type=submit]').click();
  await page.waitForTimeout(600);

  const shown = await page.locator('tg-weigh-in .now').innerText();
  check('shows the raw reading', shown.startsWith('186'), shown.replace(/\s+/g, ''));

  const trendText = await page.locator('tg-weigh-in .smoothed').innerText().catch(() => '');
  const trendLb = Number(trendText.replace(/[^\d.]/g, ''));
  check(
    'shows the smoothed trend alongside the raw reading',
    trendLb > 180 && trendLb < 184,
    `raw 186 -> trend ${trendLb} lb`,
  );

  const loadAfter = Number(await page.locator('tg-set-logger #load').innerText());
  check('a weigh-in updates the load readout', loadAfter !== loadBefore, `${loadBefore} -> ${loadAfter} lb`);

  // The load must track the SMOOTHED weight, not the raw spike. Six raw pounds at level 8 on a
  // cable exercise is worth ~0.72 lb; the EMA should deliver appreciably less than that.
  const moved = loadAfter - loadBefore;
  check('load follows the smoothed weight, not the spike', moved > 0 && moved < 0.5,
    `moved ${moved.toFixed(2)} lb (raw 6 lb would be ~0.72)`);

  await page.screenshot({ path: join(SHOTS, '04-weighin.png'), fullPage: true });

  // ---- Derived tier: Blazor reads what the shell wrote ----
  console.log('\nDerived tier (Blazor reads the logbook):');
  let blazorOk = true;
  try {
    await page.waitForSelector('#empty-state, #rec-load', { timeout: 60_000 });
  } catch {
    blazorOk = false;
  }
  check('Blazor booted and read the logbook', blazorOk);

  // Placement, not just presence. The coach used to render after the data-safety card, below
  // the fold, where nobody found it. #blazor-root is now a light-DOM child projected into the
  // shell's <slot name="derived">, so this asserts the two things that can silently break:
  // the slot is actually assigned, and the rendered result lands between Finish and the data
  // card. Comparing element positions is the only check that fails when the slot goes missing
  // -- unslotted content still exists in the DOM, it just stops being rendered.
  const placement = await page.evaluate(() => {
    const shell = document.querySelector('tg-app-shell');
    const root = document.getElementById('blazor-root');
    const finish = shell?.shadowRoot?.getElementById('finish');
    const safety = shell?.shadowRoot?.querySelector('tg-data-safety');
    const top = (el) => el?.getBoundingClientRect().top ?? NaN;

    return {
      slotted: root?.assignedSlot?.getAttribute('name') ?? null,
      insideShell: shell?.contains(root) ?? false,
      afterFinish: top(root) > top(finish),
      beforeSafety: top(root) < top(safety),
    };
  });

  check('derived tier is projected into the shell', placement.insideShell && placement.slotted === 'derived',
    `slot=${placement.slotted}`);
  check('coach renders under the workout, above the data card',
    placement.afterFinish && placement.beforeSafety);

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

  await page.screenshot({ path: join(SHOTS, '05-coach.png'), fullPage: true });

  // ---- History ----
  console.log('\nHistory:');
  await page.locator('.tg-nav a', { hasText: 'History' }).click();
  await page.waitForSelector('#history-summary, #history-empty', { timeout: 30_000 });

  const summary = await page.locator('#history-summary').innerText().catch(() => '');
  check('lists the session', /1 session/.test(summary), summary.replace(/\s+/g, ' '));

  const sessionRows = await page.locator('ul.sessions li').count();
  check('session row rendered', sessionRows === 1, `${sessionRows} rows`);

  await page.screenshot({ path: join(SHOTS, '06-history.png'), fullPage: true });

  await page.locator('button.del').first().click();
  await page.waitForTimeout(800);
  const afterDelete = await page.locator('ul.sessions li').count();
  check('a session can be deleted', afterDelete === 0, `${afterDelete} rows`);

  const emptyNow = await page.locator('#history-empty').count();
  check('empty state returns after deleting everything', emptyNow === 1);

  // ---- Safari: no requestIdleCallback ----
  //
  // Safari has NEVER shipped requestIdleCallback (still behind a preference in Technology
  // Preview), and index.html defers Blazor.start() through it. Written as
  // `requestIdleCallback?.(...)` that is a ReferenceError -- optional call guards a null VALUE,
  // not an undeclared IDENTIFIER -- so the boot module died on line one and the derived tier
  // had never once appeared on an iPhone, while passing every check above.
  //
  // Deleting the global reproduces the condition exactly. This is not a substitute for testing
  // on WebKit, but it is the specific trap, and it is free.
  console.log('\nSafari (no requestIdleCallback):');
  const safariCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await safariCtx.addInitScript(() => {
    delete window.requestIdleCallback;
    delete window.cancelIdleCallback;
  });

  const safariPage = await safariCtx.newPage();
  const safariErrors = [];
  safariPage.on('pageerror', (e) => safariErrors.push(e.message));

  await safariPage.goto(URL, { waitUntil: 'domcontentloaded' });
  await safariPage.waitForSelector('#bw', { timeout: 30_000 });
  check('the shell still paints', true);

  // Onboarding must be cleared first. The derived slot only exists on the workout screen, so
  // #empty-state renders nowhere until then -- attached to the DOM but not slotted, which is
  // the intended behaviour and would otherwise read here as a boot failure.
  await safariPage.selectOption('#notches', { label: '14 levels' });
  await safariPage.click('#start');
  await safariPage.waitForSelector('tg-set-logger #log', { timeout: 30_000 });

  let safariBlazor = true;
  try {
    await safariPage.waitForSelector('#empty-state, #rec-load', { timeout: 60_000 });
  } catch {
    safariBlazor = false;
  }
  check('Blazor boots with no idle callback', safariBlazor,
    safariBlazor ? '' : safariErrors.slice(0, 1).join(''));
  check('no page errors without requestIdleCallback', safariErrors.length === 0,
    safariErrors.slice(0, 2).join(' | '));

  await safariPage.screenshot({ path: join(SHOTS, '08-no-idle-callback.png'), fullPage: true });
  await safariCtx.close();

  // ---- Rep assist: motion counting, end to end ----
  //
  // The detector's arithmetic is covered by unit tests against synthetic waveforms. What only a
  // browser can check is the chain around it: permission gate, devicemotion listener, counter
  // guards, the custom event, and the reps field actually moving.
  //
  // Needs a touch-capable context. Motion assist deliberately hides itself on desktop, where
  // DeviceMotionEvent is defined but never fires -- offering a mode that silently does nothing
  // is worse than not offering it.
  console.log('\nRep assist (motion):');
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const phone = await phoneCtx.newPage();
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push(e.message));

  await phone.goto(URL, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('#bw', { timeout: 30_000 });
  await phone.selectOption('#notches', { label: '14 levels' });
  await phone.click('#start');
  await phone.waitForSelector('tg-set-logger #log', { timeout: 30_000 });

  const motionButton = phone.locator('tg-rep-assist #mode-motion');
  const voiceButton = phone.locator('tg-rep-assist #mode-voice');
  check('offers motion counting on a touch device', (await motionButton.count()) === 1);
  check('offers voice counting where recognition exists', (await voiceButton.count()) === 1);

  await motionButton.click();
  const armed = await phone.locator('tg-rep-assist #mode-motion').getAttribute('aria-pressed');
  check('motion assist arms on tap', armed === 'true');

  // Four reps of a clean glideboard waveform, dispatched in real time. Real time matters: the
  // plausibility filter is a wall-clock refractory period, so replaying the trace instantly
  // would be correctly rejected as impossibly fast.
  const REPS = 4;
  await phone.evaluate(
    async ({ cycles, periodMs }) => {
      const step = 1000 / 60;
      const total = cycles * periodMs;
      const startedAt = performance.now();

      await new Promise((resolve) => {
        const id = setInterval(() => {
          const t = performance.now() - startedAt;
          if (t >= total) {
            clearInterval(id);
            resolve();
            return;
          }
          const motion = 2.5 * Math.sin((2 * Math.PI * t) / periodMs);
          window.dispatchEvent(
            new DeviceMotionEvent('devicemotion', {
              accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + motion },
              interval: step,
            }),
          );
        }, step);
      });
    },
    { cycles: REPS, periodMs: 1600 },
  );

  const counted = Number(await phone.locator('tg-set-logger #reps').inputValue());
  check('counts reps from the accelerometer', counted >= REPS - 1 && counted <= REPS, `${counted} reps`);

  const assistStatus = await phone.locator('tg-rep-assist #status').innerText();
  check('shows the running count', /Counted/.test(assistStatus), assistStatus.trim());

  await phone.screenshot({ path: join(SHOTS, '09-rep-assist.png'), fullPage: true });

  // Rule 3: the stepper stays live while a source runs, so a miscount is always one tap from
  // being right.
  await phone.locator('tg-set-logger #plus').click();
  const corrected = Number(await phone.locator('tg-set-logger #reps').inputValue());
  check('manual correction still works while counting', corrected === counted + 1, `${corrected} reps`);

  // ...and the counter re-anchors to it, rather than fighting the trainee back down.
  await phone.evaluate(() => {
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
        interval: 16,
      }),
    );
  });
  const afterCorrection = Number(await phone.locator('tg-set-logger #reps').inputValue());
  check('correction is not overwritten', afterCorrection === corrected, `${afterCorrection} reps`);

  await phone.locator('tg-set-logger #log').click();
  await phone.waitForSelector('tg-session-list li', { timeout: 10_000 });
  const loggedReps = await phone.locator('tg-session-list .reps').first().innerText();
  check('the counted set logs with the counted reps', loggedReps === String(corrected), loggedReps);

  check('no page errors during rep assist', phoneErrors.length === 0, phoneErrors.slice(0, 2).join(' | '));
  await phoneCtx.close();

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
