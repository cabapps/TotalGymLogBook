/**
 * Training programs: the built-in templates, and working out which session is next.
 *
 * Lives in the instant tier because the answer drives the exercise picker, which has to be
 * usable before the .NET runtime exists (docs/adr/0003). The *analysis* of a program -- what
 * weekly volume per muscle it actually delivers -- is the complicated half and lives in
 * TotalGymLogBook.Domain, where it can reuse the volume machinery.
 */

import type { PlannedExercise, ProgramRecord, ProgramSession, SessionRecord } from './db/schema.js';
import type { ExerciseCatalog } from './exercises.js';
import type { ProgramEmphasis } from './emphasis.js';

export interface ProgramTemplate {
  readonly id: string;
  readonly name: string;
  /** What the template is built out of, matched against what the trainee is training for. */
  readonly emphasis: ProgramEmphasis;
  readonly description: string;
  readonly bestFor: string;
  readonly sessions: readonly ProgramSession[];
}

export class ProgramLibrary {
  readonly templates: readonly ProgramTemplate[];

  private constructor(templates: readonly ProgramTemplate[]) {
    this.templates = templates;
  }

  static parse(json: string | { templates: ProgramTemplate[] }): ProgramLibrary {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    return new ProgramLibrary(doc.templates);
  }

  static async load(url = 'data/programs.json'): Promise<ProgramLibrary> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
    return ProgramLibrary.parse(await res.text());
  }

  get(id: string): ProgramTemplate {
    const template = this.templates.find((t) => t.id === id);
    if (!template) throw new Error(`No program template '${id}'.`);
    return template;
  }

  /**
   * Templates ordered for this trainee: the ones built for what they are training for first.
   *
   * Ordered, never filtered. Someone training for strength who wants to run a hypertrophy split
   * is allowed to, and hiding it would be the app overruling a decision that is theirs. The
   * ordering is the recommendation; the list is still the list.
   */
  forEmphasis(emphasis: ProgramEmphasis): readonly ProgramTemplate[] {
    return [...this.templates].sort(
      (a, b) => Number(b.emphasis === emphasis) - Number(a.emphasis === emphasis),
    );
  }
}

/**
 * The session the trainee should do next.
 *
 * DERIVED FROM HISTORY, never from a stored cursor. A cursor drifts the moment anyone trains
 * out of order, skips a session, or logs on a second device, and it drifts silently -- the app
 * would keep confidently naming the wrong day. History is what actually happened, so reading
 * the rotation off it cannot disagree with reality.
 *
 * Rules, in order:
 *   - Nothing logged against this program yet: start at the beginning.
 *   - The last program session logged was session N: next is N+1, wrapping.
 *   - The last one logged is no longer in the program (it was edited out): start again.
 *
 * `sessions` must be newest-first.
 */
export function nextSession(
  program: ProgramRecord,
  sessions: readonly SessionRecord[],
): ProgramSession | undefined {
  if (program.sessions.length === 0) return undefined;

  const lastLogged = sessions.find(
    (s) => s.programId === program.id && s.programSessionId !== undefined,
  );
  if (!lastLogged) return program.sessions[0];

  const index = program.sessions.findIndex((s) => s.id === lastLogged.programSessionId);
  if (index < 0) return program.sessions[0];

  return program.sessions[(index + 1) % program.sessions.length];
}

/** How far through the rotation the trainee is, for "Push · 1 of 3". */
export function sessionPosition(program: ProgramRecord, sessionId: string): number {
  return program.sessions.findIndex((s) => s.id === sessionId) + 1;
}

export interface PlannedProgress {
  readonly planned: PlannedExercise;
  readonly logged: number;
  readonly done: boolean;
}

/**
 * Progress through today's planned session.
 *
 * Counts sets logged TODAY for each planned movement, not sets logged against this session
 * record -- the trainee may have closed the app and come back, which starts a new session
 * record but is obviously the same workout to them.
 */
export function sessionProgress(
  planned: ProgramSession,
  setsToday: ReadonlyArray<{ exerciseId: string }>,
): PlannedProgress[] {
  const counts = new Map<string, number>();
  for (const set of setsToday) {
    counts.set(set.exerciseId, (counts.get(set.exerciseId) ?? 0) + 1);
  }

  return planned.exercises.map((exercise) => {
    const logged = counts.get(exercise.exerciseId) ?? 0;
    return { planned: exercise, logged, done: logged >= exercise.sets };
  });
}

/** The next movement in the plan that still has sets owing, or undefined when the session is done. */
export function nextExercise(progress: readonly PlannedProgress[]): PlannedExercise | undefined {
  return progress.find((p) => !p.done)?.planned;
}

/**
 * Sets per muscle for one full rotation, indirect work counted fractionally.
 *
 * The same accounting the volume ledger applies to logged history, applied to a PLAN. Mirrored
 * from ProgramAnalyzer.WeeklySets in .NET, which computes it for the coach's critique; this copy
 * exists because the program editor needs the numbers to move as the trainee edits, and editing
 * is a write surface, which makes it the shell's (docs/adr/0003 and 0009). The tests on both
 * sides assert the same figures for the same shipped template.
 *
 * One rotation is treated as one week -- the convention a program is written to, and what makes
 * these figures comparable to a weekly target.
 */
export function plannedWeeklySets(
  sessions: readonly ProgramSession[],
  catalog: ExerciseCatalog,
): Map<string, number> {
  const totals = new Map<string, number>();

  for (const session of sessions) {
    for (const planned of session.exercises) {
      const exercise = catalog.tryGet(planned.exerciseId);

      // A plan can outlive the movement it names. Skipping understates the total, which is the
      // safe direction: it can only make the app suggest more work, never less.
      if (!exercise || exercise.kind !== 'strength') continue;

      for (const involvement of exercise.muscles) {
        totals.set(
          involvement.muscle,
          (totals.get(involvement.muscle) ?? 0) + planned.sets * involvement.fraction,
        );
      }
    }
  }

  return totals;
}

/**
 * Sets per muscle per week below which growth is not meaningfully driven.
 *
 * Mirrors VolumeTarget.MinimumEffectiveDose. A floor, not a target, and deliberately reachable
 * for someone training a couple of times a week.
 */
export const MINIMUM_EFFECTIVE_DOSE = 4.0;

/** Every muscle the app knows about, in the order a trainee expects to read them. */
export const MUSCLES: readonly string[] = [
  'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
  'Quadriceps', 'Hamstrings', 'Glutes', 'Adductors', 'Calves', 'Core',
];
