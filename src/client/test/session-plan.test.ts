import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';
import { ProgramLibrary, bestDailySets, rampedSets } from '../src/programs.js';
import {
  SESSION_BUDGET_MINUTES,
  canSuperset,
  estimateMinutes,
  orderSession,
  restSecondsFor,
  supersetPairs,
  totalTransitionCost,
  transitionCost,
} from '../src/session-plan.js';

const dataDir = join(__dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(dataDir, 'exercises.json'), 'utf8'));
const library = ProgramLibrary.parse(readFileSync(join(dataDir, 'programs.json'), 'utf8'));

const restFor = {
  lengthened: restSecondsFor('build-muscle'),
  'largest-muscles': restSecondsFor('lose-fat'),
  'heavy-compounds': restSecondsFor('get-stronger'),
  circuit: restSecondsFor('endurance'),
  gentle: restSecondsFor('rehab'),
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
    // Two presses and a leg movement all done lying on the board: putting the presses next to
    // each other would waste the pairing the shared setup makes possible.
    const tidy = orderSession(plan('chest-press', 'lat-pulldown', 'overhead-cable-curl'), catalog);
    expect(supersetPairs(tidy, catalog, 90).length).toBeGreaterThan(0);
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

  it('every shipped session fits in half an hour', () => {
    // The constraint that shaped the templates. A program that quietly takes fifty minutes is a
    // program most people stop running, and they will blame themselves rather than the plan.
    for (const template of library.templates) {
      const rest = restFor[template.emphasis as keyof typeof restFor];

      for (const session of template.sessions) {
        const minutes = estimateMinutes(session.exercises, catalog, rest);
        expect(minutes, `${template.id}/${session.name} takes ${minutes} min`)
          .toBeLessThanOrEqual(SESSION_BUDGET_MINUTES);
      }
    }
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
