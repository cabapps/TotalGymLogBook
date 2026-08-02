/**
 * Ordering a session so it can actually be done in the time a person has.
 *
 * THIS IS THE MACHINE'S ACTUAL ADVANTAGE. A Total Gym is one station that becomes a different
 * station in about five seconds -- but only if the next movement is set up like the last one.
 * Order the same exercises badly and the trainee spends the session bolting the squat stand on
 * and off; order them well and the session is half as long for identical work.
 *
 * So the plan is ordered by SETUP, not by muscle. Movements that share a position, a direction
 * and a grip sit together, and where two of them also work unrelated muscles they are marked as a
 * pair to alternate -- which is where the rest of the time saving comes from, because the rest
 * between one movement's sets is spent doing the other's.
 *
 * Everything here reads `Exercise.setup`, the same field the setup instructions are rendered
 * from. If the ordering thought two movements shared a setup while the instructions told the
 * trainee to turn around between them, one of them would be lying.
 */

import type { Exercise, ExerciseCatalog } from './exercises.js';
import type { PlannedExercise } from './db/schema.js';
import { relativeMass, type TrainingAim } from './emphasis.js';

/** Seconds of actual work in a set. A set of 8-12 at a controlled tempo, plus getting into it. */
export const SET_SECONDS = 40;

/** Seconds per unit of transition cost — roughly what one change to the machine costs. */
export const TRANSITION_SECONDS = 20;

/**
 * A paired movement is not free: you still sit up, turn round or pick the cables up between the
 * two halves of every round.
 */
export const PAIR_SWITCH_SECONDS = 10;

/** What most people will actually give a session. See docs/adr/0007. */
export const SESSION_BUDGET_MINUTES = 30;

/**
 * Rest between sets, mirroring GoalParameters in .NET. Kept short here because the shell needs it
 * to estimate a session before .NET exists, and a session estimate that only appears once Blazor
 * boots is not much use to someone deciding whether they have time to train.
 */
export function restSecondsFor(aim: TrainingAim): number {
  switch (aim) {
    case 'get-stronger':
      return 180;
    case 'endurance':
      return 45;
    case 'rehab':
      return 60;
    default:
      return 90;
  }
}

/**
 * What it costs to go from one movement to the next, in units of "one change to the machine".
 *
 * Weighted by what each change actually takes. Bolting an attachment on means getting off the
 * board, finding the pin and fitting it; turning around is a few seconds; picking up the cables
 * is almost free.
 */
export function transitionCost(from: Exercise, to: Exercise): number {
  if (from.id === to.id) return 0;

  // Weighted by what each change actually costs on this machine. Fitting an attachment means
  // getting off the board, finding the pin and bolting it on. Sitting up, turning round or
  // picking the cables up are all a few seconds -- which is exactly why the machine is quick to
  // train on, and why the attachment is the only change worth ordering a session around.
  let cost = 0;
  if (from.attachment !== to.attachment) cost += 3;
  if (from.setup.position !== to.setup.position) cost += 1;
  if (from.setup.facing !== to.setup.facing) cost += 1;
  if (from.usesPulley !== to.usesPulley) cost += 1;

  return cost;
}

/** Muscles the movement drives directly. Shared prime movers are what rules a pair out. */
function primeMovers(exercise: Exercise): Set<string> {
  return new Set(exercise.muscles.filter((m) => m.fraction >= 1).map((m) => m.muscle));
}

/**
 * Whether two movements can be alternated set for set.
 *
 * Two conditions, both necessary. The setup must be identical, or alternating means rebuilding
 * the machine twice per set and costs more time than it saves. And they must not drive the same
 * muscle, or the second movement is not rest — it is a drop set the trainee did not ask for.
 */
export function canSuperset(a: Exercise, b: Exercise, restSeconds: number): boolean {
  if (a.id === b.id) return false;
  // Anything short of an attachment change is quick enough to do between alternating sets.
  // Requiring an IDENTICAL setup rules out the pairs people actually run -- press against row,
  // squat against a pull -- for the sake of a few seconds of sitting up.
  if (transitionCost(a, b) >= 3) return false;
  // Below about a minute the pair has no room to breathe; the trainee is just rushing.
  if (restSeconds < 60) return false;

  const first = primeMovers(a);
  return ![...primeMovers(b)].some((muscle) => first.has(muscle));
}

/** How much machine this movement is worth doing while fresh. */
function heaviness(exercise: Exercise): number {
  const mass = exercise.muscles.reduce((sum, m) => sum + relativeMass(m.muscle) * m.fraction, 0);
  // Cable work is halved by the pulley, so the same effort is a lighter absolute load and a
  // cheaper thing to do late in a session.
  return Math.min(1, mass) * (exercise.usesPulley ? 0.8 : 1);
}

function setupKey(exercise: Exercise): string {
  return [
    exercise.attachment ?? '-',
    exercise.setup.position,
    exercise.setup.facing,
    exercise.usesPulley ? 'cable' : 'direct',
  ].join('|');
}

/**
 * Reorders a session to spend as little time rebuilding the machine as possible.
 *
 * Movements are grouped by setup, groups are walked nearest-first from the heaviest one, and
 * within a group the heaviest goes first. That keeps the two rules that matter in tension with
 * each other honestly: the biggest movements are still done while fresh, but not at the price of
 * bolting the squat stand on and off three times.
 *
 * Pure and order-stable, so the same session always tidies to the same plan.
 */
export function orderSession(
  planned: readonly PlannedExercise[],
  catalog: ExerciseCatalog,
): PlannedExercise[] {
  const known = planned.filter((p) => catalog.tryGet(p.exerciseId));
  const unknown = planned.filter((p) => !catalog.tryGet(p.exerciseId));

  const groups = new Map<string, PlannedExercise[]>();
  for (const item of known) {
    const key = setupKey(catalog.get(item.exerciseId));
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  // Within a setup, heaviest first -- but alternating muscles where there is a choice, so that
  // adjacent movements can be run as a pair. Two chest movements back to back cannot be
  // alternated, and putting them there costs the session a rest period per round for nothing.
  for (const [key, bucket] of groups) {
    bucket.sort((a, b) => heaviness(catalog.get(b.exerciseId)) - heaviness(catalog.get(a.exerciseId)));
    groups.set(key, alternate(bucket, catalog));
  }

  const remaining = [...groups.values()];
  remaining.sort(
    (a, b) => heaviness(catalog.get(b[0]!.exerciseId)) - heaviness(catalog.get(a[0]!.exerciseId)),
  );

  const ordered: PlannedExercise[] = [];
  let current = remaining.shift();

  while (current) {
    ordered.push(...current);

    const last = catalog.get(current[current.length - 1]!.exerciseId);
    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const [index, group] of remaining.entries()) {
      const cost = transitionCost(last, catalog.get(group[0]!.exerciseId));
      // Ties go to the heavier group, which is already first in `remaining`.
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }

    current = remaining.splice(bestIndex, 1)[0];
  }

  // Movements the catalog no longer has keep their place at the end rather than vanishing: the
  // trainee put them there, and a tidy-up is not a deletion.
  return [...ordered, ...unknown];
}

/**
 * Reorders a heaviness-sorted list so neighbours drive different muscles where possible.
 *
 * Greedy and stable: take the heaviest, then the heaviest remaining that shares no prime mover
 * with it, and fall back to the heaviest remaining when every candidate overlaps. Falling back
 * rather than forcing the split matters -- a session of nothing but chest work should stay in
 * heaviness order rather than be shuffled for a pairing that cannot exist.
 */
function alternate(
  bucket: readonly PlannedExercise[],
  catalog: ExerciseCatalog,
): PlannedExercise[] {
  const remaining = [...bucket];
  const ordered: PlannedExercise[] = [];

  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1];
    let index = 0;

    if (previous) {
      const used = primeMovers(catalog.get(previous.exerciseId));
      const found = remaining.findIndex(
        (item) => ![...primeMovers(catalog.get(item.exerciseId))].some((m) => used.has(m)),
      );
      if (found >= 0) index = found;
    }

    ordered.push(remaining.splice(index, 1)[0]!);
  }

  return ordered;
}

export interface SupersetPair {
  readonly first: number;
  readonly second: number;
}

/** Adjacent movements in an ordered session that can be alternated set for set. */
export function supersetPairs(
  planned: readonly PlannedExercise[],
  catalog: ExerciseCatalog,
  restSeconds: number,
): SupersetPair[] {
  const pairs: SupersetPair[] = [];

  for (let i = 0; i + 1 < planned.length; i++) {
    // A movement can only be in one pair — alternating three ways is a circuit, and it needs
    // saying so rather than being inferred.
    if (pairs.some((p) => p.second === i)) continue;

    const a = catalog.tryGet(planned[i]!.exerciseId);
    const b = catalog.tryGet(planned[i + 1]!.exerciseId);

    if (a && b && canSuperset(a, b, restSeconds)) pairs.push({ first: i, second: i + 1 });
  }

  return pairs;
}

/**
 * Roughly how long this session takes, in minutes.
 *
 * Work, rest, and the time spent changing the machine between movements. Paired movements spend
 * their rest doing each other, which is most of what a superset buys.
 *
 * An estimate, and it says so wherever it is shown. Its job is to tell someone with half an hour
 * whether this session fits, and it is accurate enough for that.
 */
export function estimateMinutes(
  planned: readonly PlannedExercise[],
  catalog: ExerciseCatalog,
  restSeconds: number,
): number {
  if (planned.length === 0) return 0;

  const pairs = supersetPairs(planned, catalog, restSeconds);
  const paired = new Set(pairs.flatMap((p) => [p.first, p.second]));

  let seconds = 0;

  for (const [index, item] of planned.entries()) {
    seconds += item.sets * SET_SECONDS;

    // Rest after every set except the last of the session; near enough at this resolution.
    if (!paired.has(index)) seconds += item.sets * restSeconds;
  }

  // A pair rests once per round rather than twice, and the round is both movements' work.
  for (const pair of pairs) {
    const rounds = Math.max(planned[pair.first]!.sets, planned[pair.second]!.sets);
    seconds += rounds * (restSeconds + PAIR_SWITCH_SECONDS);
  }

  for (let i = 0; i + 1 < planned.length; i++) {
    const a = catalog.tryGet(planned[i]!.exerciseId);
    const b = catalog.tryGet(planned[i + 1]!.exerciseId);
    if (a && b) seconds += transitionCost(a, b) * TRANSITION_SECONDS;
  }

  return Math.round(seconds / 60);
}

/** Total transitions in a session — what the ordering is trying to minimize. */
export function totalTransitionCost(
  planned: readonly PlannedExercise[],
  catalog: ExerciseCatalog,
): number {
  let cost = 0;

  for (let i = 0; i + 1 < planned.length; i++) {
    const a = catalog.tryGet(planned[i]!.exerciseId);
    const b = catalog.tryGet(planned[i + 1]!.exerciseId);
    if (a && b) cost += transitionCost(a, b);
  }

  return cost;
}
