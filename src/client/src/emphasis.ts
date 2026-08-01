/**
 * What a program should be BUILT out of, given what the trainee is training for.
 *
 * The goal already changes reps, rest and how load progresses; that lives in .NET and reaches
 * the trainee through the coach. This is the other half -- which movements belong in the program
 * at all -- and it lives here because the program editor is a write surface, and writes are the
 * shell's (docs/adr/0003 and 0009). Mirrored from TotalGymLogBook.Domain.Training.ProgramEmphasis;
 * the tests on both sides assert the same rankings.
 */

import type { Exercise } from './exercises.js';

/**
 * What the trainee said they were training for, as they said it.
 *
 * Stored alongside the derived goal rather than instead of it. "Lose weight" and "build muscle"
 * both produce a hypertrophy program -- that is settled in docs/adr/0010 -- but they are not the
 * same request, and flattening one into the other at the door means the program can never act on
 * the difference.
 */
export type TrainingAim = 'build-muscle' | 'lose-fat' | 'get-stronger' | 'endurance' | 'rehab';

export type ProgramEmphasis =
  | 'lengthened'
  | 'largest-muscles'
  | 'heavy-compounds'
  | 'circuit'
  | 'gentle';

/** The training style a stated aim implies. Matches TrainingAim.ToGoal in .NET. */
export function goalFor(aim: TrainingAim): string {
  switch (aim) {
    case 'get-stronger':
      return 'Strength';
    case 'endurance':
      return 'Aerobic';
    case 'rehab':
      return 'Rehab';
    // Losing fat is not a training style: in a deficit, resistance training's job is preserving
    // and adding lean mass, and that takes mechanical tension.
    default:
      return 'Hypertrophy';
  }
}

/**
 * Roughly how much trainable muscle each group is, relative to the largest.
 *
 * Ranking only -- never a load or a set count. It is what lets a fat-loss program lead with the
 * movements that build the most tissue: more muscle is more resting metabolism, and in a deficit
 * the training's job is to keep and add lean mass rather than to burn calories during the set.
 *
 * Approximate on purpose. That quads outrank calves is not controversial and is all this needs
 * to get right. Mirrors MuscleGroups.RelativeMass.
 */
const RELATIVE_MASS: Readonly<Record<string, number>> = {
  Quadriceps: 1.0,
  Back: 0.9,
  Glutes: 0.8,
  Hamstrings: 0.6,
  Chest: 0.55,
  Shoulders: 0.4,
  Adductors: 0.3,
  Calves: 0.3,
  Triceps: 0.3,
  Core: 0.25,
  Biceps: 0.2,
};

export function relativeMass(muscle: string): number {
  return RELATIVE_MASS[muscle] ?? 0.25;
}

/**
 * How to build the program.
 *
 * An OBSERVED deficit counts the same as a stated fat-loss aim: someone who set out to build
 * muscle but has been losing weight for a month is, whatever they intended, training in a
 * deficit. The trend is evidence, the stated aim is intent, and either is enough.
 */
export function emphasisFor(aim: TrainingAim, losingWeight = false): ProgramEmphasis {
  switch (aim) {
    case 'get-stronger':
      return 'heavy-compounds';
    case 'endurance':
      return 'circuit';
    case 'rehab':
      return 'gentle';
    case 'lose-fat':
      return 'largest-muscles';
    default:
      return losingWeight ? 'largest-muscles' : 'lengthened';
  }
}

/** Total muscle a movement works, secondary involvement counted fractionally. Capped at 1. */
function compoundness(exercise: Exercise): number {
  const mass = exercise.muscles.reduce((sum, m) => sum + relativeMass(m.muscle) * m.fraction, 0);
  return Math.min(1, mass);
}

/**
 * How well a movement serves this emphasis, 0-1. Ranking only: it decides which exercise the
 * builder offers first, never a load, a set count, or anything recorded.
 */
export function score(emphasis: ProgramEmphasis, exercise: Exercise): number {
  const compound = compoundness(exercise);

  switch (emphasis) {
    case 'lengthened':
      return exercise.peakTension === 'lengthened'
        ? 0.7 + 0.3 * compound
        : exercise.peakTension === 'even'
          ? 0.4 + 0.3 * compound
          : 0.15 + 0.3 * compound;
    case 'largest-muscles':
    case 'heavy-compounds':
    case 'circuit':
      return compound;
    // Nothing that demands a hard loaded stretch.
    case 'gentle':
      return exercise.peakTension === 'lengthened' ? 0.35 : 0.7;
    default:
      return 0.5;
  }
}

/** One line a trainee can act on, explaining what the builder is ranking by. */
export function explain(emphasis: ProgramEmphasis): string {
  switch (emphasis) {
    case 'lengthened':
      return (
        'Movements that load the muscle stretched are listed first — that is where this ' +
        "machine's constant cable tension does the most for growth."
      );
    case 'largest-muscles':
      return (
        'The biggest muscles are listed first. Training barely dents the calories, so its job ' +
        'while you are losing weight is to keep and add muscle — and muscle on your legs and ' +
        'back does the most for what you burn at rest.'
      );
    case 'heavy-compounds':
      return 'Big compound movements first, with fewer exercises and more sets on each.';
    case 'circuit':
      return 'Whole-body movements first, to keep working sets close together.';
    case 'gentle':
      return 'Controlled movements first, and nothing that pulls hard into a stretch.';
    default:
      return '';
  }
}
