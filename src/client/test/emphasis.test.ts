import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';
import { ProgramLibrary, MINIMUM_EFFECTIVE_DOSE, plannedWeeklySets } from '../src/programs.js';
import { emphasisFor, explain, goalFor, relativeMass, score } from '../src/emphasis.js';

const dataDir = join(__dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(dataDir, 'exercises.json'), 'utf8'));
const library = ProgramLibrary.parse(readFileSync(join(dataDir, 'programs.json'), 'utf8'));

describe('what a stated aim implies', () => {
  it('still gives someone losing weight a muscle-building program', () => {
    // docs/adr/0010: losing weight is not a training style. What changes is which movements the
    // program is built out of, not whether it is a lifting program.
    expect(goalFor('lose-fat')).toBe('Hypertrophy');
    expect(emphasisFor('lose-fat')).toBe('largest-muscles');
  });

  it('treats an observed deficit the same as a stated one', () => {
    expect(emphasisFor('build-muscle')).toBe('lengthened');
    expect(emphasisFor('build-muscle', true)).toBe('largest-muscles');
  });

  it('maps every answer the onboarding question offers', () => {
    for (const aim of ['build-muscle', 'lose-fat', 'get-stronger', 'endurance', 'rehab'] as const) {
      expect(explain(emphasisFor(aim)).length).toBeGreaterThan(20);
    }
  });
});

describe('ranking movements for a goal', () => {
  it('puts a stretch movement above a squeeze for building muscle', () => {
    const fly = catalog.get('chest-fly');
    const raise = catalog.get('lateral-raise');

    expect(score('lengthened', fly)).toBeGreaterThan(score('lengthened', raise));
  });

  it('puts the biggest muscles first for losing fat', () => {
    // A squat builds more tissue than a curl, and more muscle is more resting metabolism.
    const squat = catalog.get('squat');
    const curl = catalog.get('concentration-curl');

    expect(score('largest-muscles', squat)).toBeGreaterThan(score('largest-muscles', curl));
  });

  it('does not lead a rehab trainee into a loaded stretch', () => {
    expect(score('gentle', catalog.get('seated-row'))).toBeGreaterThan(
      score('gentle', catalog.get('chest-fly')),
    );
  });

  it('ranks quads above biceps, which is the only claim the mass table has to get right', () => {
    expect(relativeMass('Quadriceps')).toBeGreaterThan(relativeMass('Biceps'));
    expect(relativeMass('Back')).toBeGreaterThan(relativeMass('Calves'));
    expect(relativeMass('Nonsense')).toBeGreaterThan(0);
  });
});

describe('planned volume', () => {
  it('counts a movement into every muscle it works, indirect work at half', () => {
    // Chest press is chest 1.0, triceps 0.5, shoulders 0.5.
    const volume = plannedWeeklySets(
      [{ id: 's', name: 'S', exercises: [{ exerciseId: 'chest-press', sets: 4 }] }],
      catalog,
    );

    expect(volume.get('Chest')).toBe(4);
    expect(volume.get('Triceps')).toBe(2);
    expect(volume.get('Shoulders')).toBe(2);
  });

  it('adds up across sessions', () => {
    const volume = plannedWeeklySets(
      [
        { id: 'a', name: 'A', exercises: [{ exerciseId: 'chest-press', sets: 3 }] },
        { id: 'b', name: 'B', exercises: [{ exerciseId: 'chest-press', sets: 2 }] },
      ],
      catalog,
    );

    expect(volume.get('Chest')).toBe(5);
  });

  it('ignores a movement the catalog no longer has', () => {
    // A plan outlives the exercise it names when a custom movement is deleted. Understating is
    // the safe direction: it can only make the app suggest more work, never less.
    const volume = plannedWeeklySets(
      [{ id: 's', name: 'S', exercises: [{ exerciseId: 'ghost-lift', sets: 5 }] }],
      catalog,
    );

    expect(volume.size).toBe(0);
  });

  it('does not count a stretch as planned volume', () => {
    const volume = plannedWeeklySets(
      [{ id: 's', name: 'S', exercises: [{ exerciseId: 'hamstring-stretch', sets: 5 }] }],
      catalog,
    );

    expect(volume.get('Hamstrings')).toBeUndefined();
  });

  it('agrees with the C# analyzer on a shipped template', () => {
    // The twin of Counts_planned_sets_per_muscle in ProgramAnalyzerTests. Two implementations of
    // the same accounting exist because the editor needs the numbers live in the shell and the
    // coach needs them in .NET (docs/adr/0009); this is what catches one drifting from the other.
    const volume = plannedWeeklySets(library.get('push-pull-legs').sessions, catalog);

    expect(volume.get('Chest')).toBe(6);
    expect(volume.get('Back')).toBe(12);
    expect(volume.get('Quadriceps')).toBe(6);
    expect(volume.get('Biceps')).toBe(6);
    expect(volume.get('Glutes')).toBe(10);
    // Muscles the split actually trains, not ones it brushes: adductors come out at 1.5 because
    // a wide-stance squat involves them, and no push/pull/legs was ever written for adductors.
    const direct = new Set(
      library
        .get('push-pull-legs')
        .sessions.flatMap((s) => s.exercises)
        .flatMap((e) => catalog.get(e.exerciseId).muscles)
        .filter((m) => m.fraction >= 1)
        .map((m) => m.muscle),
    );

    expect(
      [...volume].filter(([m]) => direct.has(m)).every(([, sets]) => sets >= MINIMUM_EFFECTIVE_DOSE),
    ).toBe(true);
  });
});
