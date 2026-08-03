#!/usr/bin/env node
/**
 * Re-fits data/programs.json to the current model. Run from the repo root:
 *
 *   node tools/fit-programs.mjs
 *
 * The shipped templates have to satisfy four claims at once, and every one of them is enforced
 * by a test:
 *
 *   - every session is in setup order, so nobody bolts the squat stand on twice
 *   - every session fits inside SESSION_BUDGET_MINUTES at its goal's rest periods
 *   - every muscle a volume-judged template trains clears the minimum effective dose
 *   - every movement runs on a stock machine
 *
 * Those constraints interact. Tightening what counts as a superset lengthens sessions, which
 * forces sets down, which drops muscles under the dose, which needs sets back somewhere the
 * ordering did not expect. Doing that by hand takes an afternoon and is wrong by the end of it,
 * which is why this exists: the model is the source of truth and the data is derived from it.
 *
 * It converges by alternating two passes -- trim until everything fits, then give sets back to
 * whatever fell under the dose -- because either one alone oscillates.
 *
 * Deliberately NOT run by the build. Re-fitting rewrites a data file that a human should read
 * before committing; a build step that quietly reshapes everyone's training program is not a
 * build step anyone should trust.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');

// The planner is TypeScript, and this is the one place a build step is worth it: reimplementing
// estimateMinutes here would give the tool its own opinion, and the whole point is that it has
// the app's.
const stage = mkdtempSync(join(tmpdir(), 'tg-fit-'));
const bundle = (entry, out) =>
  execFileSync(
    'npx',
    ['esbuild', '--bundle', '--format=esm', `--outfile=${join(stage, out)}`, entry],
    { cwd: join(ROOT, 'src/client'), stdio: 'pipe' },
  );

bundle('src/session-plan.ts', 'plan.mjs');
bundle('src/exercises.ts', 'catalog.mjs');

const {
  budgetMinutesFor,
  estimateMinutes,
  orderSession,
  restSecondsFor,
  supersetPairs,
  totalTransitionCost,
} = await import(join(stage, 'plan.mjs'));
const { ExerciseCatalog } = await import(join(stage, 'catalog.mjs'));

const catalog = ExerciseCatalog.parse(readFileSync(join(DATA, 'exercises.json'), 'utf8'));
const doc = JSON.parse(readFileSync(join(DATA, 'programs.json'), 'utf8'));

const AIM = {
  lengthened: 'build-muscle',
  'largest-muscles': 'lose-fat',
  'heavy-compounds': 'get-stronger',
  circuit: 'endurance',
  gentle: 'rehab',
};

/** The effective dose is a hypertrophy number; a circuit or a rehab plan is not held to it. */
const VOLUME_JUDGED = new Set(['lengthened', 'largest-muscles', 'heavy-compounds']);

const DOSE = 4;
const MIN_SETS = 3;

const common = new Set(catalog.accessories.filter((a) => a.common).flatMap((a) => a.provides));
const stock = catalog.all.filter(
  (e) => e.kind === 'strength' && (!e.attachment || common.has(e.attachment)),
);

const heaviness = (id) => {
  const mass = { Quadriceps: 1, Back: 0.9, Glutes: 0.8, Hamstrings: 0.6, Chest: 0.55,
    Shoulders: 0.4, Adductors: 0.3, Calves: 0.3, Triceps: 0.3, Core: 0.25, Biceps: 0.2 };
  return Math.min(
    1,
    catalog.get(id).muscles.reduce((sum, m) => sum + (mass[m.muscle] ?? 0.25) * m.fraction, 0),
  );
};

function volumes(template) {
  const total = {};
  for (const session of template.sessions) {
    for (const planned of session.exercises) {
      const exercise = catalog.get(planned.exerciseId);
      if (exercise.kind !== 'strength') continue;
      for (const m of exercise.muscles) {
        total[m.muscle] = (total[m.muscle] ?? 0) + planned.sets * m.fraction;
      }
    }
  }
  return total;
}

/** Trim until every session fits the budget: sets first, then the least useful movement. */
function trim(template, rest, BUDGET) {
  for (const session of template.sessions) {
    session.exercises = orderSession(session.exercises, catalog);

    for (let guard = 0; estimateMinutes(session.exercises, catalog, rest) > BUDGET; guard++) {
      if (guard > 60) throw new Error(`${template.id}/${session.name} will not fit`);

      const trimmable = session.exercises
        .filter((e) => e.sets > MIN_SETS)
        .sort((a, b) => b.sets - a.sets || heaviness(a.exerciseId) - heaviness(b.exerciseId));

      if (trimmable.length > 0) {
        trimmable[0].sets -= 1;
        continue;
      }

      // Nothing left to shave: drop the least useful movement and re-tidy, because removing one
      // changes which of the rest can be paired.
      const worst = [...session.exercises].sort(
        (a, b) => heaviness(a.exerciseId) - heaviness(b.exerciseId),
      )[0];
      session.exercises = orderSession(
        session.exercises.filter((e) => e !== worst),
        catalog,
      );
    }
  }
}

/** Give sets back to whatever fell under the dose, wherever there is room. */
function topUp(template, rest, BUDGET) {
  for (let guard = 0; guard < 40; guard++) {
    const volume = volumes(template);
    const short = Object.entries(volume)
      .filter(([, sets]) => sets > 0 && sets < DOSE)
      .sort((a, b) => a[1] - b[1])[0];
    if (!short) return;

    const [muscle] = short;
    const trains = (id) =>
      catalog.get(id).muscles.some((m) => m.muscle === muscle && m.fraction >= 1);

    // Cheapest fix: one more set of something already in the program.
    let fixed = false;
    for (const session of template.sessions) {
      const hit = session.exercises.find((e) => trains(e.exerciseId));
      if (!hit) continue;

      hit.sets += 1;
      if (estimateMinutes(session.exercises, catalog, rest) <= BUDGET) {
        fixed = true;
        break;
      }
      hit.sets -= 1;
    }
    if (fixed) continue;

    // Otherwise add the movement that fits some session's existing setup most cheaply.
    let best;
    for (const session of template.sessions) {
      for (const candidate of stock.filter((e) => trains(e.id))) {
        if (session.exercises.some((e) => e.exerciseId === candidate.id)) continue;

        const trial = orderSession(
          [...session.exercises, { exerciseId: candidate.id, sets: MIN_SETS }],
          catalog,
        );
        const minutes = estimateMinutes(trial, catalog, rest);
        if (minutes <= BUDGET && (!best || minutes < best.minutes)) best = { session, trial, minutes };
      }
    }

    if (!best) return; // No room. The test will say so, and a human decides what gives.
    best.session.exercises = best.trial;
  }
}

for (const template of doc.templates) {
  const rest = restSecondsFor(AIM[template.emphasis]);
  const BUDGET = budgetMinutesFor(AIM[template.emphasis]);

  // Alternating, because trimming can drop a muscle under the dose and topping up can push a
  // session over the budget. Three rounds settles every template we ship; the check below is
  // what actually decides whether it worked.
  for (let round = 0; round < 3; round++) {
    trim(template, rest, BUDGET);
    if (VOLUME_JUDGED.has(template.emphasis)) topUp(template, rest, BUDGET);
  }
  trim(template, rest, BUDGET);
}

// One-line planned exercises: they are two fields and there are ninety of them.
const json = JSON.stringify(doc, null, 2).replace(
  /\{\s*\n\s*"exerciseId": ("[^"]+"),\s*\n\s*"sets": (\d+)\s*\n\s*\}/g,
  '{ "exerciseId": $1, "sets": $2 }',
);
writeFileSync(join(DATA, 'programs.json'), json + '\n');

let problems = 0;
for (const template of doc.templates) {
  const rest = restSecondsFor(AIM[template.emphasis]);
  const BUDGET = budgetMinutesFor(AIM[template.emphasis]);
  let pairs = 0;

  for (const session of template.sessions) {
    const minutes = estimateMinutes(session.exercises, catalog, rest);
    pairs += supersetPairs(session.exercises, catalog, rest).length;

    if (minutes > BUDGET) {
      console.log(`  OVER   ${template.id}/${session.name} ${minutes} min`);
      problems++;
    }
    if (
      totalTransitionCost(orderSession(session.exercises, catalog), catalog) <
      totalTransitionCost(session.exercises, catalog)
    ) {
      console.log(`  UNTIDY ${template.id}/${session.name}`);
      problems++;
    }
  }

  const under = Object.entries(volumes(template))
    .filter(([, sets]) => sets > 0 && sets < DOSE)
    .map(([muscle]) => muscle);

  if (VOLUME_JUDGED.has(template.emphasis) && under.length > 0) {
    console.log(`  UNDER  ${template.id}: ${under.join(', ')}`);
    problems++;
  }

  console.log(
    `${template.id.padEnd(22)} ${template.sessions.length} sessions, ${pairs} pairs` +
      (under.length ? `, thin: ${under.join(', ')}` : ''),
  );
}

console.log(problems === 0 ? '\nAll templates fit.' : `\n${problems} problems.`);
process.exit(problems === 0 ? 0 : 1);
