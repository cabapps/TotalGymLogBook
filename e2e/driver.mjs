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
 *   node e2e/driver.mjs --dark     # dark color scheme
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

  /**
   * Polls a locator's text until it matches. Several panels refresh asynchronously off a
   * 'set-logged' event, so the click resolving is not the same as the DOM having caught up --
   * reading straight after the click is a race that fails maybe one run in three.
   */
  const waitForText = async (locator, pattern, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    let text = '';
    while (Date.now() < deadline) {
      text = await locator.innerText().catch(() => '');
      if (pattern.test(text)) return text;
      await page.waitForTimeout(150);
    }
    return text;
  };

  /** waitForText against a page other than the desktop one. */
  const waitForTextOn = async (target, locator, pattern, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    let text = '';
    while (Date.now() < deadline) {
      text = await locator.innerText().catch(() => '');
      if (pattern.test(text)) return text;
      await target.waitForTimeout(150);
    }
    return text;
  };

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

  // Reps start at zero, not at a guess. A prefilled count is one the trainee has to notice and
  // correct, and a set logged at a number they did not do reads as real data forever.
  const startingReps = await page.locator('tg-set-logger #reps').inputValue();
  check('reps start at zero', startingReps === '0', `${startingReps} reps`);

  await page.locator('tg-set-logger #plus').click();
  await page.locator('tg-set-logger #plus').click();
  const reps = await page.locator('tg-set-logger #reps').inputValue();
  check('rep stepper works', reps === '2', `${reps} reps`);

  // Twelve: the top of the hypertrophy rep range, so the coach downstream has a reason to
  // recommend more load rather than more reps. Reps now start at zero, so this has to be set
  // rather than nudged.
  await page.fill('tg-set-logger #reps', '12');

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
  // a cable load against a direct-press rung and tells the trainee to double their load.
  const loggedLb = Number(await page.locator('tg-set-logger #load').innerText());
  const recommendedLb = Number(recLoad.replace(/[^\d.]/g, ''));
  const step = recommendedLb / loggedLb;
  check(
    'recommendation is a sane step, not a different exercise',
    step > 1 && step < 1.3,
    `${loggedLb} -> ${recommendedLb} lb (x${step.toFixed(2)})`,
  );

  await page.screenshot({ path: join(SHOTS, '05-coach.png'), fullPage: true });

  // The coach must advise on the exercise the trainee is ABOUT to do. It used to be pinned to
  // chest press, which made it wrong the moment anyone trained anything else -- telling you to
  // move up a notch on the press while you stood at the squat stand.
  //
  // No program and no prediction needed: the selector already says. This asserts the whole
  // path -- dropdown -> focus.ts -> change bus -> Blazor re-read.
  const named = await page.locator('#focus-exercise').innerText();
  check('coach names the selected exercise', /Chest Press/i.test(named), named.trim());

  // Option labels carry the required attachment ("Squat (Squat stand)"), so select by value.
  await page.selectOption('tg-set-logger #exercise', { value: 'squat' });
  await page.waitForFunction(
    () => /squat/i.test(document.getElementById('focus-exercise')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  );
  const switched = await page.locator('#focus-exercise').innerText();
  check('coach follows the exercise selector', /Squat/i.test(switched), switched.trim());

  // Nothing logged for squats, so it must say so rather than quoting chest-press numbers.
  const squatState = await page.locator('#empty-state').innerText().catch(() => '');
  check('advises from that exercise history, not another', /squat/i.test(squatState),
    squatState.replace(/\s+/g, ' ').slice(0, 60) + '…');

  await page.selectOption('tg-set-logger #exercise', { value: 'chest-press' });
  await page.waitForSelector('#rec-load', { timeout: 20_000 });
  check('switching back restores the recommendation', true);

  // Session-level coaching: weekly sets per muscle, the unit the hypertrophy literature uses.
  const weekly = await page.locator('#week-headline').innerText().catch(() => '');
  check('reports weekly volume per muscle', weekly.length > 20, weekly.replace(/\s+/g, ' ').slice(0, 70) + '…');

  await page.screenshot({ path: join(SHOTS, '10-coach-per-exercise.png'), fullPage: true });

  // ---- Programs ----
  //
  // A program is an ORDERED ROTATION, not a calendar (docs/adr/0007), and which session is next
  // is DERIVED from history rather than tracked by a cursor. Both of those are invisible until
  // something is logged against a plan, so this drives the whole loop: pick a program, log the
  // planned movement, watch it tick off, and confirm the rotation advanced.
  console.log('\nPrograms:');
  await page.locator('tg-program-panel #change').click().catch(() => {});
  await page.waitForSelector('tg-program-panel #use-0', { timeout: 15_000 });
  check('offers a program for every way of training',
    (await page.locator('tg-program-panel .choice h4').count()) >= 5,
    `${await page.locator('tg-program-panel .choice h4').count()} templates`);

  // Push/Pull/Legs -- its first session leads with chest press, which is already logged today,
  // so the tick list has something to show immediately.
  const pplIndex = await page.locator('tg-program-panel .choice h4').allInnerTexts()
    .then((names) => names.findIndex((n) => /push/i.test(n)));
  await page.locator(`tg-program-panel #use-${pplIndex}`).click();
  await page.waitForSelector('tg-program-panel #plan', { timeout: 15_000 });

  const sessionName = await page.locator('tg-program-panel #session-name').innerText();
  check('starts at the beginning of the rotation', /push/i.test(sessionName), sessionName.trim());

  const position = await page.locator('tg-program-panel #session-position').innerText();
  check('shows where you are in the rotation', /1 of 3/.test(position), position.replace(/\s+/g, ' '));

  // Sets logged earlier today count toward the plan, because closing the app mid-workout
  // starts a new session record but is obviously the same workout to the trainee.
  const firstItem = await page.locator('tg-program-panel #plan li').first().innerText();
  check('counts sets already logged today', /[1-9]\/\d/.test(firstItem), firstItem.replace(/\s+/g, ' '));

  // Tapping a planned movement selects it in the logger. The plan drives the picker; it never
  // replaces it.
  await page.locator('tg-program-panel #pick-1').click();
  const picked = await page.locator('tg-set-logger #exercise').inputValue();
  check('tapping the plan selects that exercise', picked === 'shoulder-press', picked);

  await page.locator('tg-set-logger #log').click();

  const afterLog = await waitForText(
    page.locator('tg-program-panel #plan li').nth(1),
    /1\/\d/,
  );
  check('logging ticks the plan along', /1\/\d/.test(afterLog), afterLog.replace(/\s+/g, ' '));

  // Browsing the rotation. A program with three sessions that only ever shows one of them is a
  // program the trainee cannot see the shape of.
  const before = await page.locator('tg-program-panel #session-name').innerText();
  await page.locator('tg-program-panel #next').click();
  const browsed = await waitForText(
    page.locator('tg-program-panel #session-name'),
    new RegExp(`^(?!${before.trim()}$).+`),
  );
  check('you can step through the rotation', browsed.trim() !== before.trim(),
    `${before.trim()} -> ${browsed.trim()}`);

  const browsingNote = await page.locator('tg-program-panel #browsing').count();
  check('and it says that is not the one you were due', browsingNote === 1);

  await page.locator('tg-program-panel #prev').click();
  const backAgain = await waitForText(
    page.locator('tg-program-panel #session-name'),
    new RegExp(`^${before.trim()}$`),
  );
  check('and step back', backAgain.trim() === before.trim(), backAgain.trim());

  const pairNote = await page.locator('tg-program-panel .pairnote').count();
  check('marks movements that can be alternated', pairNote > 0, `${pairNote} pairs`);

  const sessionMinutes = await page.locator('tg-program-panel #session-minutes').innerText();
  check('says how long the session takes', /~\d+ min/.test(sessionMinutes), sessionMinutes.trim());

  await page.screenshot({ path: join(SHOTS, '13-program.png'), fullPage: true });

  // The derived tier's half: is this program any good?
  await page.locator('.tg-nav a', { hasText: 'Program' }).click();
  await page.waitForSelector('#program-verdict', { timeout: 30_000 });

  const verdict = await page.locator('#program-verdict').innerText();
  check('critiques the program by weekly volume', verdict.length > 30,
    verdict.replace(/\s+/g, ' ').slice(0, 70) + '…');

  const bars = await page.locator('#program-volume li').count();
  check('charts planned volume for every muscle group', bars >= 10, `${bars} muscles`);

  const sessionsListed = await page.locator('#program-sessions li').count();
  check('lists the sessions', sessionsListed === 3, `${sessionsListed} sessions`);

  await page.screenshot({ path: join(SHOTS, '14-program-critique.png'), fullPage: true });

  // ---- Building a program ----
  //
  // The point of the editor is that the volume moves WHILE you choose, so the effective dose is
  // a dial rather than a verdict you get afterwards. That is only observable end to end: the
  // numbers come from the shell's own copy of the accounting, and they have to change on the
  // same tap that changes the plan.
  console.log('\nProgram editor:');
  await page.locator('.tg-nav a', { hasText: 'Log' }).click().catch(() => {});
  await page.waitForSelector('tg-program-panel #edit', { timeout: 30_000 });
  await page.locator('tg-program-panel #edit').click();
  await page.waitForSelector('tg-program-editor #volume', { timeout: 15_000 });

  check('opens on the program you are running',
    (await page.locator('tg-program-editor .session').count()) === 3,
    `${await page.locator('tg-program-editor .session').count()} sessions`);

  const chestBefore = await page.locator('tg-program-editor #volume li').first().innerText();
  check('shows sets per muscle while you build', /\d/.test(chestBefore),
    chestBefore.replace(/\s+/g, ' '));

  // A movement's set count is the dial. Bumping it has to move the bar it feeds.
  const setsBefore = await page.locator('tg-program-editor #sets-0-0').innerText();
  await page.locator('tg-program-editor #plus-0-0').click();
  await page.locator('tg-program-editor #plus-0-0').click();
  const setsAfter = await page.locator('tg-program-editor #sets-0-0').innerText();
  check('sets can be dialed up', Number(setsAfter) === Number(setsBefore) + 2,
    `${setsBefore} -> ${setsAfter}`);

  const chestAfter = await page.locator('tg-program-editor #volume li').first().innerText();
  check('the volume moves as you edit', chestAfter !== chestBefore,
    `${chestBefore.replace(/\s+/g, ' ')} -> ${chestAfter.replace(/\s+/g, ' ')}`);

  // Ranking, not filtering: for someone building muscle the stretch-loaded movements come first,
  // and everything else is still in the list.
  const firstOption = await page.locator('tg-program-editor #add-0 option').nth(1).innerText();
  check('offers stretch-loaded movements first for building muscle', /★/.test(firstOption),
    firstOption.trim());

  const optionCount = await page.locator('tg-program-editor #add-0 option').count();
  check('still offers everything else', optionCount > 60, `${optionCount} movements`);

  // Strip a session down to one arm movement: the gaps must be REPORTED and the save must
  // still work. A program that ignores a muscle group is a choice, not an error.
  for (const index of [2, 1]) {
    await page.locator(`tg-program-editor #skill-${index}`).click();
  }
  const exerciseRows = await page.locator('tg-program-editor li.ex').count();
  for (let i = exerciseRows - 1; i >= 1; i--) {
    await page.locator(`tg-program-editor #drop-0-${i}`).click();
  }

  const verdictText = await waitForText(
    page.locator('tg-program-editor #verdict'),
    /Nothing in here trains/,
  );
  check('names the muscle groups a program ignores', /Nothing in here trains/.test(verdictText),
    verdictText.replace(/\s+/g, ' ').slice(0, 80) + '…');

  const saveEnabled = await page.locator('tg-program-editor #save').isEnabled();
  check('a gap never blocks saving', saveEnabled);

  await page.screenshot({ path: join(SHOTS, '15-program-editor.png'), fullPage: true });

  await page.locator('tg-program-editor #save').click();
  await page.waitForSelector('tg-program-panel #plan', { timeout: 15_000 });

  const editedName = await page.locator('tg-program-panel #session-name').innerText();
  check('the edited program becomes the one you are running', editedName.trim().length > 0,
    editedName.trim());

  // The panel refreshes asynchronously after the save, so poll rather than read once -- the
  // stale row count is the old program, which looks exactly like the edit not sticking.
  let planRows = 0;
  for (let i = 0; i < 60; i++) {
    planRows = await page.locator('tg-program-panel #plan li').count();
    if (planRows === 1) break;
    await page.waitForTimeout(150);
  }
  check('the plan reflects the edit', planRows === 1, `${planRows} movements`);

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
  // the intended behavior and would otherwise read here as a boot failure.
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

  // Motion stops when the set is logged, exactly like voice. It used to keep running on the
  // theory that an idle accelerometer costs nothing -- but it does: a phone that keeps counting
  // while the trainee walks away adds reps to the next set before it starts, and they cannot see
  // it happening because they are not looking at the phone.
  const motionStatus = await waitForTextOn(
    phone,
    phone.locator('tg-rep-assist #status'),
    /Stopped counting/,
  );
  check('motion stops when the set is logged', /Stopped counting/.test(motionStatus),
    motionStatus.trim());

  const stopped = await phone.locator('tg-rep-assist #stop').count();
  check('and the Stop button goes with it', stopped === 0);

  check('no page errors during rep assist', phoneErrors.length === 0, phoneErrors.slice(0, 2).join(' | '));

  // ---- Equipment ----
  //
  // A hundred exercises is a long list to scroll past things you cannot do. The filter is a
  // stored setting, so it survives the session, and it must reshape the picker immediately
  // rather than at next launch.
  console.log('\nEquipment filter:');
  const allOptions = await phone.locator('tg-set-logger #exercise option').count();
  check('the picker starts unfiltered', allOptions > 50, `${allOptions} exercises`);

  const groups = await phone.locator('tg-set-logger #exercise optgroup').count();
  check('the picker is grouped by body part', groups >= 6, `${groups} groups`);

  await phone.locator('tg-equipment summary').click();
  const boxes = phone.locator('tg-equipment input[type=checkbox]');
  const boxCount = await boxes.count();
  check('lists every accessory the catalog needs', boxCount >= 11, `${boxCount} accessories`);

  const headings = await phone.locator('tg-equipment h4').allTextContents();
  check('separates what ships with the machine from what does not', headings.length === 2,
    headings.join(' / '));

  for (let i = 0; i < boxCount; i++) await boxes.nth(i).uncheck();

  // Wait on a specific option leaving. A plain document.querySelector cannot reach into
  // <tg-app-shell>'s shadow root from inside evaluate(), but Playwright's locator engine
  // pierces open roots -- so let it do the waiting.
  await phone.waitForSelector('tg-set-logger #exercise option[value="squat"]', {
    state: 'detached',
    timeout: 15_000,
  });

  // Every tick is its own async write, so with eleven boxes there are eleven saves in flight.
  // Reading the picker before the last one lands makes this check flaky rather than wrong --
  // so wait for the panel's own count, which it only updates once a save has resolved, to
  // agree with the picker twice running.
  const settled = async () => {
    let agreed = 0;
    for (let i = 0; i < 60; i++) {
      const label = await phone.locator('tg-equipment #count').innerText().catch(() => '');
      const claimed = Number(/(\d+) of/.exec(label)?.[1] ?? -1);
      const shown = await phone.locator('tg-set-logger #exercise option').count();
      if (claimed === shown && ++agreed === 2) return shown;
      if (claimed !== shown) agreed = 0;
      await phone.waitForTimeout(150);
    }
    return -1;
  };

  const filtered = await settled();
  check('unowned accessories drop out of the picker', filtered > 0 && filtered < allOptions,
    `${allOptions} -> ${filtered} exercises`);

  const stillListed = await phone.locator('tg-set-logger #exercise option[value="squat"]').count();
  check('a squat-stand movement is gone', stillListed === 0);

  // Vest and bar are accessories too, and they gate FIELDS rather than exercises. Two number
  // inputs that are always zero are two things to scroll past on the one screen that has to stay
  // fast, for someone who owns neither.
  const vestField = await phone.locator('tg-set-logger #vest').count();
  const barField = await phone.locator('tg-set-logger #bar').count();
  check('added-load fields disappear for someone who owns neither', vestField + barField === 0);

  await phone.locator('tg-equipment #att-weight-vest').check();
  await phone.waitForSelector('tg-set-logger #vest', { state: 'attached', timeout: 15_000 });
  check('and come back when they say they own one', true);
  await phone.locator('tg-equipment #att-weight-vest').uncheck();
  await phone.waitForSelector('tg-set-logger #vest', { state: 'detached', timeout: 15_000 });

  // An exercise names a CAPABILITY, not a product. The wing shipped as one piece and as two,
  // and either one has to unlock pull-ups -- which is only observable end to end, because the
  // capability lookup sits between the stored accessory id and the option list.
  const wingGone = await phone.locator('tg-set-logger #exercise option[value="pull-up"]').count();
  check('a wing movement is gone with no wing owned', wingGone === 0);

  await phone.locator('tg-equipment #att-wing-two-piece').check();
  // 'attached', not the default 'visible': an <option> inside a collapsed <select> never
  // reports visible, so the default state would wait out the timeout on a passing app.
  await phone.waitForSelector('tg-set-logger #exercise option[value="pull-up"]', {
    state: 'attached',
    timeout: 15_000,
  });
  check('the two-piece wing unlocks pull-ups', true);

  // Back to a bare machine, so the reload check below is comparing like with like.
  await phone.locator('tg-equipment #att-wing-two-piece').uncheck();
  await phone.waitForSelector('tg-set-logger #exercise option[value="pull-up"]', {
    state: 'detached',
    timeout: 15_000,
  });
  await settled();

  // The selection must not silently fall through to whatever ends up first in the list.
  const selected = await phone.locator('tg-set-logger #exercise').inputValue();
  const selectable = await phone
    .locator(`tg-set-logger #exercise option[value="${selected}"]`)
    .count();
  check('the selected exercise is still in the list', selectable === 1, selected);

  await phone.screenshot({ path: join(SHOTS, '11-equipment.png'), fullPage: true });

  // Survives a reload: it is a setting, not session state.
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('tg-set-logger #exercise', { timeout: 30_000 });
  const afterReload = await phone.locator('tg-set-logger #exercise option').count();
  check('the equipment choice is remembered', afterReload === filtered, `${afterReload} exercises`);

  await phoneCtx.close();

  // ---- Rep assist: voice ----
  //
  // Headless Chromium has no speech service, so a real SpeechRecognition either does nothing
  // or errors out -- neither of which tests OUR code. Stubbing the recognizer puts the whole
  // path under test instead: transcript parsing, the counter's guards, the reps field, and the
  // microphone actually being released when the set ends.
  console.log('\nRep assist (voice):');
  const voiceCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await voiceCtx.addInitScript(() => {
    class FakeRecognition extends EventTarget {
      constructor() {
        super();
        this.lang = '';
        this.continuous = false;
        this.interimResults = false;
        this.maxAlternatives = 1;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        window.__recognition = this;
      }
      start() { window.__listening = true; }
      stop() { window.__listening = false; this.onend?.(); }
      abort() { window.__listening = false; }
      say(transcript) {
        this.onresult?.({ resultIndex: 0, results: [[{ transcript, confidence: 0.9 }]] });
      }
    }
    window.__listening = false;
    // BOTH names. Chromium ships the unprefixed SpeechRecognition, and the source prefers it,
    // so stubbing only the webkit- name leaves the real (serviceless) recognizer in play.
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  });

  const voice = await voiceCtx.newPage();
  const voiceErrors = [];
  voice.on('pageerror', (e) => voiceErrors.push(e.message));

  await voice.goto(URL, { waitUntil: 'domcontentloaded' });
  await voice.waitForSelector('#bw', { timeout: 30_000 });
  await voice.selectOption('#notches', { label: '14 levels' });
  await voice.click('#start');
  await voice.waitForSelector('tg-set-logger #log', { timeout: 30_000 });

  await voice.locator('tg-rep-assist #mode-voice').click();
  // The click handler kicks off an async start, so the click resolving is not the same as
  // the microphone being live.
  await voice.waitForFunction(() => window.__listening === true, null, { timeout: 15_000 });
  check('voice assist starts listening', true);

  // Counting out loud, including a dropped word. The count still lands correctly, which is the
  // whole reason voice reports totals rather than events.
  for (const said of ['one', 'two', 'four']) {
    await voice.evaluate((text) => window.__recognition.say(text), said);
  }
  const heard = Number(await voice.locator('tg-set-logger #reps').inputValue());
  check('counts what the trainee says, over a dropped word', heard === 4, `${heard} reps`);

  // The misrecognition that matters: "four" through gritted teeth comes back as "forty".
  await voice.evaluate(() => window.__recognition.say('forty'));
  const afterWild = Number(await voice.locator('tg-set-logger #reps').inputValue());
  check('ignores a wildly wrong number', afterWild === heard, `${afterWild} reps`);

  await voice.locator('tg-set-logger #log').click();
  await voice.waitForSelector('tg-session-list li', { timeout: 10_000 });

  check('logging a set releases the microphone',
    await voice.evaluate(() => window.__listening === false));
  const voiceStatus = await voice.locator('tg-rep-assist #status').innerText();
  check('and says so', /stopped listening/i.test(voiceStatus), voiceStatus.trim());

  await voice.screenshot({ path: join(SHOTS, '12-voice.png'), fullPage: true });
  check('no page errors during voice assist', voiceErrors.length === 0, voiceErrors.slice(0, 2).join(' | '));
  await voiceCtx.close();

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
