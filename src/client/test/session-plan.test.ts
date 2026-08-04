import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';
import { ProgramLibrary, bestDailySets, observedLevels, rampedSets } from '../src/programs.js';
import {
  SESSION_BUDGET_MINUTES,
  budgetMinutesFor,
  canSuperset,
  estimateMinutes,
  orderSession,
  observedSecondsPerSet,
  restSecondsFor,
  supersetPairs,
  totalTransitionCost,
  transitionCost,
} from '../src/session-plan.js';

const dataDir = join(__dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(dataDir, 'exercises.json'), 'utf8'));
const library = ProgramLibrary.parse(readFileSync(join(dataDir, 'programs.json'), 'utf8'));

const aimFor = {
  lengthened: 'build-muscle',
  'largest-muscles': 'lose-fat',
  'heavy-compounds': 'get-stronger',
  circuit: 'endurance',
  gentle: 'rehab',
} as const;

const plan = (...ids: string[]) => ids.map((exerciseId) => ({ exerciseId, sets: 3 }));

describe('transition cost', () => {
  it('charges most for fitting an attachment', () => {
    // The only change that means getting off the board and finding a pin. Everything else is
    // seconds, and that asymmetry is what the whole ordering turns on.
    const attachmentChange = transitionCost(catalog.get('chest-press'), catalog.get('squat'));
    const sitUp = transitionCost(catalog.get('chest-press'), catalog.get('seated-row'));

    expect(attachmentChange).toBeGreaterThan(sitUp);
  });

  it('charges nothing to put a curl in a block of pressing', () => {
    // A curl works sitting either way round, so it can sit in the middle of pressing work
    // without anybody turning around. A model that only knew the one direction would send the
    // trainee around and back for one exercise.
    expect(transitionCost(catalog.get('chest-press'), catalog.get('biceps-curl'))).toBe(0);
    // ...and it still belongs with the pulling work, which is the other half of the claim.
    expect(transitionCost(catalog.get('seated-row'), catalog.get('biceps-curl'))).toBe(0);
  });

  it('still charges for a movement that only works one way round', () => {
    expect(transitionCost(catalog.get('chest-press'), catalog.get('seated-row'))).toBeGreaterThan(0);
  });

  it('is free between movements that share a setup', () => {
    // The user's own example: both are done lying on the board with feet on the squat stand, so
    // the machine does not change at all between them.
    expect(transitionCost(catalog.get('squat'), catalog.get('calf-raise'))).toBe(0);
  });
});

describe('supersets', () => {
  it('pairs movements that share a setup and work different muscles', () => {
    expect(canSuperset(catalog.get('squat'), catalog.get('calf-raise'), 90)).toBe(true);
  });

  it('refuses to pair two movements that drive the same muscle', () => {
    // The second movement is meant to be the first one's rest. Two chest movements is a drop set
    // the trainee did not ask for.
    expect(canSuperset(catalog.get('chest-press'), catalog.get('incline-chest-fly'), 90)).toBe(false);
  });

  it('refuses to pair across an attachment change', () => {
    // Alternating would mean bolting the stand on and off once per set, which costs more time
    // than the pairing saves.
    expect(canSuperset(catalog.get('squat'), catalog.get('lat-pulldown'), 90)).toBe(false);
  });

  it('does not pair when rests are already short', () => {
    // A circuit is short rests by design; pairing on top of that is not a rest, it is a rush.
    expect(canSuperset(catalog.get('squat'), catalog.get('calf-raise'), 45)).toBe(false);
  });

  it('leaves a movement in at most one pair', () => {
    const pairs = supersetPairs(plan('squat', 'calf-raise', 'hip-bridge'), catalog, 90);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ first: 0, second: 1 });
  });
});

describe('ordering a session', () => {
  it('groups movements that share a setup', () => {
    // Scrambled on purpose: three setups interleaved is the worst case, and the shape it should
    // come back in is squat-stand work together, then cable work together.
    const scrambled = plan('squat', 'chest-press', 'calf-raise', 'seated-row', 'hip-bridge');
    const tidy = orderSession(scrambled, catalog);

    expect(totalTransitionCost(tidy, catalog)).toBeLessThan(
      totalTransitionCost(scrambled, catalog),
    );

    const standWork = tidy.map((p) => p.exerciseId)
      .map((id) => catalog.get(id).attachment === 'Squat stand');
    // All three squat-stand movements land in one run rather than three visits.
    expect(standWork.join('')).toMatch(/^(true,?)*(false,?)*$|^(false,?)*(true,?)*$/);
  });

  it('leads with the biggest movement', () => {
    const tidy = orderSession(plan('lateral-raise', 'squat', 'biceps-curl'), catalog);
    expect(tidy[0]!.exerciseId).toBe('squat');
  });

  it('alternates muscles inside a setup so neighbours can be paired', () => {
    // Putting two chest movements next to each other would waste the pairing the shared setup
    // makes possible. Crunches run at about the same notch as a press, which is the other half
    // of what makes a pair work.
    //
    // The oblique crunch rather than the plain one, because the plain crunch needs the wing
    // bolted on to anchor the feet -- and a pair that means fitting an attachment between rounds
    // is not a pair. That it stopped qualifying the moment the wing was recorded is the
    // transition model working, so this asks a movement that really does share the setup.
    const tidy = orderSession(plan('chest-press', 'incline-chest-fly', 'oblique-crunch'), catalog);
    expect(supersetPairs(tidy, catalog, 90).length).toBeGreaterThan(0);
  });

  it('will not pair a press with a row', () => {
    // The pairing that prompted all this. The notch that makes a chest press hard leaves a
    // seated row light enough for twenty reps, because the back is stronger than the chest --
    // so alternating them means moving the pin twice a round.
    expect(canSuperset(catalog.get('chest-press'), catalog.get('seated-row'), 90)).toBe(false);
  });

  it('pairs a squat with a calf raise', () => {
    // Same setup, same notch, different muscles: the pairing that works.
    expect(canSuperset(catalog.get('squat'), catalog.get('calf-raise'), 90)).toBe(true);
  });

  it('believes the trainee over the table', () => {
    // "Pretty sure I can row about as much as I can squat. Not sure if that's the same for
    // everyone though." It is not, which is why logged levels win: once the app has watched
    // someone actually train both movements, its own averages stop being the best answer.
    const observed = new Map([
      ['chest-press', 0.8],
      ['seated-row', 0.85],
    ]);

    expect(canSuperset(catalog.get('chest-press'), catalog.get('seated-row'), 90, observed))
      .toBe(true);
  });

  it('is stable — tidying an already tidy session changes nothing', () => {
    const once = orderSession(plan('squat', 'chest-press', 'calf-raise'), catalog);
    expect(orderSession(once, catalog)).toEqual(once);
  });

  it('keeps a movement the catalog no longer has', () => {
    // A tidy-up is not a deletion. The trainee put it there.
    const tidy = orderSession([...plan('squat'), { exerciseId: 'ghost-lift', sets: 2 }], catalog);
    expect(tidy.map((p) => p.exerciseId)).toContain('ghost-lift');
  });
});

describe('learning the trainee', () => {
  it('measures how long their sets actually take, end to end', () => {
    // Not the model's average of nobody. Elapsed time over sets logged, so it absorbs everything
    // the model cannot see -- moving the pin, answering the door, standing up slowly.
    const minute = 60_000;
    const pace = observedSecondsPerSet([
      { startedAt: 0, endedAt: 30 * minute, setCount: 10 },
      { startedAt: 0, endedAt: 36 * minute, setCount: 12 },
      { startedAt: 0, endedAt: 40 * minute, setCount: 10 },
    ]);

    expect(pace).toBe(180);
  });

  it('says nothing until it has seen enough', () => {
    // One session, and especially one interrupted session, is worse than the default.
    expect(observedSecondsPerSet([])).toBeUndefined();
    expect(observedSecondsPerSet([{ startedAt: 0, endedAt: 60_000, setCount: 10 }])).toBeUndefined();
  });

  it('ignores a session left open overnight', () => {
    const hour = 3_600_000;
    const pace = observedSecondsPerSet([
      { startedAt: 0, endedAt: 30 * 60_000, setCount: 10 },
      { startedAt: 0, endedAt: 32 * 60_000, setCount: 10 },
      { startedAt: 0, endedAt: 14 * hour, setCount: 10 },
    ]);

    // The overnight one is dropped rather than dragging the median toward an hour a set.
    expect(pace).toBeLessThan(200);
  });

  it('plans no more sets than there is time for', () => {
    // The trainee's report: "I wasn't able to complete all the exercises in the time I had."
    // A plan they abandon two movements short every week is wrong about them.
    const wanted = plan('squat', 'chest-press', 'seated-row', 'crunch');
    const best = new Map([
      ['squat', 3],
      ['chest-press', 3],
      ['seated-row', 3],
      ['crunch', 3],
    ]);

    const roomy = rampedSets(wanted, best);
    const cramped = rampedSets(wanted, best, 6);

    expect(roomy.reduce((n, e) => n + e.sets, 0)).toBeGreaterThan(6);
    expect(cramped.reduce((n, e) => n + e.sets, 0)).toBe(6);
  });

  it('trims from the end, and never below one set', () => {
    // The front of the session is what is worth doing fresh, and dropping the tail is what was
    // happening anyway -- this just stops pretending otherwise.
    const wanted = plan('squat', 'chest-press', 'crunch');
    const best = new Map([['squat', 3], ['chest-press', 3], ['crunch', 3]]);

    const cramped = rampedSets(wanted, best, 3);

    expect(cramped[0]!.sets).toBeGreaterThanOrEqual(cramped[2]!.sets);
    expect(cramped.every((e) => e.sets >= 1)).toBe(true);
  });

  it('reads a working level out of logged sets', () => {
    const sets = [
      { exerciseId: 'squat', level: 8 },
      { exerciseId: 'squat', level: 8 },
      { exerciseId: 'squat', level: 9 },
      // Two sets is a first attempt, not a working level.
      { exerciseId: 'chest-press', level: 3 },
      { exerciseId: 'chest-press', level: 4 },
    ];

    const levels = observedLevels(sets, 14);

    expect(levels.get('squat')).toBeCloseTo(8 / 14, 3);
    expect(levels.has('chest-press')).toBe(false);
  });
});

describe('how long a session takes', () => {
  it('counts work, rest and the time spent changing the machine', () => {
    const minutes = estimateMinutes(plan('squat'), catalog, 90);
    // Three sets of forty seconds plus three rests of ninety.
    expect(minutes).toBe(7);
  });

  it('makes a session shorter by pairing', () => {
    const paired = estimateMinutes(plan('squat', 'calf-raise'), catalog, 90);
    const unpaired = estimateMinutes(plan('squat', 'lat-pulldown'), catalog, 90);

    expect(paired).toBeLessThan(unpaired);
  });

  it('every shipped session fits the time its goal is given', () => {
    // The constraint that shaped the templates. A program that quietly takes fifty minutes is a
    // program most people stop running, and they will blame themselves rather than the plan.
    //
    // Half an hour for everyone but strength, which gets forty-five. Three minutes of rest is
    // the method rather than a delay, so holding strength to thirty produced not a faster
    // program but one with the chest press deleted to make room.
    for (const template of library.templates) {
      const aim = aimFor[template.emphasis as keyof typeof aimFor];
      const budget = budgetMinutesFor(aim);

      for (const session of template.sessions) {
        const minutes = estimateMinutes(session.exercises, catalog, restSecondsFor(aim));
        expect(minutes, `${template.id}/${session.name} takes ${minutes} min against ${budget}`)
          .toBeLessThanOrEqual(budget);
      }
    }

    // ...and the general budget still means what it says for everything else.
    expect(budgetMinutesFor('build-muscle')).toBe(SESSION_BUDGET_MINUTES);
  });

  it('every shipped session is already in setup order', () => {
    // Tidying must find nothing to improve. This is what stops a hand edit to the data quietly
    // adding five minutes of bolting the squat stand on and off.
    for (const template of library.templates) {
      for (const session of template.sessions) {
        const tidy = orderSession(session.exercises, catalog);
        expect(
          totalTransitionCost(tidy, catalog),
          `${template.id}/${session.name} could be tidier`,
        ).toBeGreaterThanOrEqual(totalTransitionCost(session.exercises, catalog));
      }
    }
  });
});

describe('ramping sets up', () => {
  it('starts a new trainee at one set of everything', () => {
    // Fifteen working sets is not a first session, it is a reason to stop using the app.
    const ramped = rampedSets(plan('squat', 'chest-press'), new Map());
    expect(ramped.every((e) => e.sets === 1)).toBe(true);
  });

  it('offers one more than the trainee has been doing', () => {
    const ramped = rampedSets(plan('squat'), new Map([['squat', 2]]));
    expect(ramped[0]!.sets).toBe(3);
  });

  it('never asks for more than the program plans', () => {
    // The template is the ceiling. Someone who does eight sets on their own is not told to do
    // nine next time; volume is programming, not progression (docs/adr/0010).
    const ramped = rampedSets(plan('squat'), new Map([['squat', 8]]));
    expect(ramped[0]!.sets).toBe(3);
  });

  it('reads what the trainee did in a day, not in a session', () => {
    // Closing the app mid-workout starts a new session record but is obviously the same workout.
    const best = bestDailySets([
      { exerciseId: 'squat', on: '2026-08-01' },
      { exerciseId: 'squat', on: '2026-08-01' },
      { exerciseId: 'squat', on: '2026-08-02' },
    ]);

    expect(best.get('squat')).toBe(2);
  });
});
