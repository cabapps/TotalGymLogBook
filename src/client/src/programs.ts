/**
 * Training programs: the built-in templates, and working out which session is next.
 *
 * Lives in the instant tier because the answer drives the exercise picker, which has to be
 * usable before the .NET runtime exists (docs/adr/0003). The *analysis* of a program -- what
 * weekly volume per muscle it actually delivers -- is the complicated half and lives in
 * TotalGymLogBook.Domain, where it can reuse the volume machinery.
 */

import { toIsoDate } from './db/schema.js';
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

  // A workout already under way IS the current session. Without this the rotation advances on
  // the first logged set and the trainee watches the plan jump to tomorrow's session while they
  // are still working through today's -- the tick list they are reading disappears mid-set.
  const inProgress = sessions.find(
    (s) => s.programId === program.id && s.programSessionId !== undefined && s.status === 'active',
  );
  if (inProgress) {
    const current = program.sessions.find((s) => s.id === inProgress.programSessionId);
    if (current) return current;
  }

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
 * How much one LOGGED set counts toward a muscle's headline volume.
 *
 * A unilateral set trains one side, and the headline is the average of the two sides -- so it is
 * half. That is what makes three sets per leg read as three rather than six: three is what each
 * quad got, and it is the number comparable to three sets of a two-legged squat.
 *
 * Only the headline collapses this way. The per-side breakdown needs the side each set was
 * logged against, which is the one thing this cannot recover.
 */
export function setWeight(exercise: { readonly unilateral: boolean }): number {
  return exercise.unilateral ? 0.5 : 1;
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

/**
 * The plan a trainee should actually see today, ramped from what they have been doing.
 *
 * Template set counts are a CEILING, not a starting point. Someone new to training does not want
 * five sets of anything, and a plan that opens by asking for fifteen working sets is a plan they
 * bounce off — the app's first impression should be a session they can obviously finish.
 *
 * So the plan starts at one set per movement and grows as the trainee shows they want more: the
 * target is one more than the most they have done of that movement in a day, capped by the
 * template. Doing extra sets on your own is a request for more work, and it is a better signal
 * than anything the app could ask, because it is what they actually did rather than what they
 * think they will do.
 *
 * Derived from history, never stored. Same reasoning as the rotation (docs/adr/0007): a stored
 * ramp drifts silently the first time someone trains without the app, and it cannot be corrected
 * because nobody can see it.
 */
export function rampedSets(
  planned: readonly PlannedExercise[],
  best: ReadonlyMap<string, number>,
  /** Total sets there is room for at the trainee's own pace. Unlimited when unknown. */
  roomForSets = Number.POSITIVE_INFINITY,
  /**
   * Needed only to know which movements are one-limb-at-a-time. A planned set of those is two
   * sets on the board, so a plan trimmed by the written number would let a leg session run to
   * twice the time there is room for.
   */
  catalog?: ExerciseCatalog,
): PlannedExercise[] {
  const costPerSet = (exerciseId: string) =>
    catalog?.tryGet(exerciseId)?.unilateral ? 2 : 1;

  const wanted = planned.map((exercise) => ({
    ...exercise,
    sets: Math.max(1, Math.min(exercise.sets, (best.get(exercise.exerciseId) ?? 0) + 1)),
  }));

  // AND NO MORE THAN THERE IS TIME FOR.
  //
  // The ramp grows the plan toward the template; this is what stops it growing past the session
  // the trainee can actually finish. Someone who ran out of time last week gets a plan that
  // fits this week, rather than the same plan and the same two movements left undone -- and as
  // they get quicker, or train longer, the room grows back on its own.
  //
  // Trimmed from the END, because the session is ordered with the movements worth doing fresh
  // at the front (docs/adr/0007). Losing the last movement is the cheapest loss available, and
  // it is the one that was happening anyway.
  let total = wanted.reduce((sum, e) => sum + e.sets * costPerSet(e.exerciseId), 0);

  for (let i = wanted.length - 1; i >= 0 && total > roomForSets; i--) {
    const cost = costPerSet(wanted[i]!.exerciseId);
    const spare = Math.min(wanted[i]!.sets - 1, Math.ceil((total - roomForSets) / cost));
    if (spare <= 0) continue;

    wanted[i]!.sets -= spare;
    total -= spare * cost;
  }

  return wanted;
}

/**
 * How far back the ramp looks.
 *
 * Long enough that a fortnight off does not reset a trainee to one set, short enough that a
 * volume they abandoned a year ago is not still being asked of them.
 */
export const RAMP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The slice of history today's plan is built from -- and it STOPS YESTERDAY.
 *
 * Today's sets used to count, which meant the plan grew while the trainee was working through
 * it: log the third set of squats, bestDailySets rises to three, the ramp allows four, and the
 * total to do goes up while they are standing there doing it. A target that recedes as you
 * approach it is not a target.
 *
 * Ending the window yesterday makes today's plan a function of the days BEFORE today, so it
 * reads the same on the first set as on the last, and the same again after a reload mid-workout
 * -- without storing a cursor anywhere. Tomorrow it recomputes with today included, which is
 * when the ramp is supposed to move.
 */
export function rampWindow(now: number): { from: string; to: string } {
  const day = 24 * 60 * 60 * 1000;
  return { from: toIsoDate(now - RAMP_WINDOW_MS), to: toIsoDate(now - day) };
}

/**
 * The most sets of each movement the trainee has done in a single day.
 *
 * A day rather than a session, for the same reason the tick list counts a day: closing the app
 * mid-workout starts a new session record but is obviously the same workout to the trainee, and
 * a ramp that forgot half of it would stall.
 */
export function bestDailySets(
  sets: ReadonlyArray<{ exerciseId: string; on: string }>,
): Map<string, number> {
  const perDay = new Map<string, number>();

  for (const set of sets) {
    const key = `${set.on}|${set.exerciseId}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const best = new Map<string, number>();
  for (const [key, count] of perDay) {
    const exerciseId = key.slice(key.indexOf('|') + 1);
    best.set(exerciseId, Math.max(best.get(exerciseId) ?? 0, count));
  }

  return best;
}

/**
 * The level the trainee actually works each movement at, as a fraction of their rail.
 *
 * Their own answer to "how much can I handle on this?", which the catalog can only guess at. Used
 * to decide what can be alternated: two movements pair only if they run at about the same notch,
 * and whether a row and a press do is a fact about the person, not about the exercises.
 *
 * The MEDIAN of recent working levels, so one warm-up set does not speak for the movement.
 */
export function observedLevels(
  sets: ReadonlyArray<{ exerciseId: string; level: number }>,
  levelCount: number,
): Map<string, number> {
  const byExercise = new Map<string, number[]>();

  for (const set of sets) {
    const levels = byExercise.get(set.exerciseId);
    if (levels) levels.push(set.level);
    else byExercise.set(set.exerciseId, [set.level]);
  }

  const median = new Map<string, number>();

  for (const [exerciseId, levels] of byExercise) {
    // Two sets is not a working level, it is a first attempt.
    if (levels.length < 3) continue;

    levels.sort((a, b) => a - b);
    const middle = Math.floor(levels.length / 2);
    const value =
      levels.length % 2 === 0 ? (levels[middle - 1]! + levels[middle]!) / 2 : levels[middle]!;

    median.set(exerciseId, value / levelCount);
  }

  return median;
}
