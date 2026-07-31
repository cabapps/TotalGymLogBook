/**
 * The Blazor boundary (docs/adr/0003).
 *
 * Blazor never opens IndexedDB. It calls these functions via [JSImport] and receives JSON
 * strings, per interop rule 2: the boundary carries ids and JSON, never live object references.
 * That keeps marshalling trivial and leaves exactly one data-access layer.
 *
 * Everything here is read-only. The write path belongs to the instant tier -- logging a set
 * must work before the .NET runtime exists, so Blazor has no business owning it.
 *
 * C# side (TotalGymLogBook.Interop):
 *
 *   [JSImport("tglbDb.getExerciseHistoryJson")]
 *   internal static partial Task<string> GetExerciseHistoryJson(string exerciseId, double sinceMs);
 */

import * as repo from './repository.js';
import * as backup from './backup.js';
import { onChange } from './events.js';
import { toIsoDate } from './schema.js';

/**
 * Global handle the C# side binds to. Must match the dotted path in the [JSImport] attributes.
 *
 * A valid JS identifier on purpose: [JSImport] can root a binding at a globalThis path, which
 * avoids JSHost.ImportAsync and the whole class of module-URL problems that came with it --
 * ImportAsync resolves relative to _framework/ rather than the app base, and the dev server
 * fingerprints static assets at serve time (dist/shell.<hash>.js) while publish does not, so
 * any URL written here is wrong in one environment or the other.
 */
export const GLOBAL_NAME = 'tglbDb';

const json = (value: unknown): string => JSON.stringify(value ?? null);

/** History for one exercise. `sinceMs` of 0 means everything. */
export async function getExerciseHistoryJson(exerciseId: string, sinceMs = 0): Promise<string> {
  return json(await repo.getExerciseHistory(exerciseId, sinceMs || undefined));
}

/** Every set in a trailing window, for the volume ledger. */
export async function getRecentSetsJson(days = 7): Promise<string> {
  const now = Date.now();
  return json(await repo.getSetsBetween(toIsoDate(now - days * 86_400_000), toIsoDate(now)));
}

/**
 * Sets in a window, grouped into the ExerciseHistory shape the domain expects, so C# can
 * deserialise straight into its own records without reshaping.
 */
export async function getHistoriesJson(days = 90): Promise<string> {
  const now = Date.now();
  const sets = await repo.getSetsBetween(toIsoDate(now - days * 86_400_000), toIsoDate(now));

  const byExercise = new Map<string, typeof sets>();
  for (const set of sets) {
    byExercise.set(set.exerciseId, [...(byExercise.get(set.exerciseId) ?? []), set]);
  }

  return json(
    [...byExercise].map(([exerciseId, rows]) => ({ exerciseId, sets: rows })),
  );
}

export async function getBodyweightReadingsJson(sinceOn?: string): Promise<string> {
  return json(await repo.getBodyweightReadings(sinceOn));
}

export async function getActiveSessionJson(): Promise<string> {
  return json(await repo.getActiveSession());
}

export async function getSessionSetsJson(sessionId: string): Promise<string> {
  return json(await repo.getSessionSets(sessionId));
}

export async function listSessionsJson(sinceMs = 0): Promise<string> {
  return json(await repo.listSessions(sinceMs || undefined));
}

export async function getSettingsJson(): Promise<string> {
  return json(await repo.getSettings());
}

export async function listMachinesJson(): Promise<string> {
  return json(await repo.listMachines());
}

/**
 * Lets Blazor subscribe to the change bus once. The callback receives only a store name and
 * ids; Blazor re-reads through the functions above rather than trusting a payload.
 */
export function subscribeToChanges(callback: (store: string, ids: string) => void): () => void {
  return onChange((event) => callback(event.store, event.ids.join(',')));
}

/**
 * Publishes the bridge on globalThis so [JSImport] can resolve it. Called from main.ts during
 * shell boot, well before Blazor.start().
 */
export function installBridge(): void {
  (globalThis as Record<string, unknown>)[GLOBAL_NAME] = {
    // The repository and backup APIs are exposed here as a deliberate debugging affordance.
    // This is a local-first app with no server and no account, so nothing is being exposed that
    // console access does not already grant. It also gives the run driver a stable handle that
    // does not depend on resolving the bundle's URL -- the dev server fingerprints static
    // assets at serve time while publish does not, so any re-derived URL risks evaluating a
    // second copy of the module and colliding on customElements.define.
    repo,
    backup,
    getExerciseHistoryJson,
    getRecentSetsJson,
    getHistoriesJson,
    getBodyweightReadingsJson,
    getActiveSessionJson,
    getSessionSetsJson,
    listSessionsJson,
    getSettingsJson,
    listMachinesJson,
    subscribeToChanges,
  };
}
