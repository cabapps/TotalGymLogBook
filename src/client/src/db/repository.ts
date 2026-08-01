/**
 * The data-access layer. TypeScript owns IndexedDB exclusively (docs/adr/0003), so everything
 * -- the web-component shell and Blazor alike -- goes through here.
 *
 * The write path is deliberately dumb. Logging a set is an append of an immutable snapshot with
 * no domain logic, which is what lets it run milliseconds after first paint rather than waiting
 * 1-3 seconds for the .NET runtime. Everything requiring the domain model is a derivation, and
 * derivations can arrive late.
 */

import { getAll, getAllFromIndex, getById, promisify, put, transact } from './database.js';
import { publishChange } from './events.js';
import {
  Store,
  newId,
  toIsoDate,
  type BodyweightRecord,
  type Instant,
  type IsoDate,
  type CustomExerciseRecord,
  type MachineRecord,
  type ProgramRecord,
  type SessionRecord,
  type SetLogRecord,
  type SettingsRecord,
  type SyncFields,
} from './schema.js';

const now = (): Instant => Date.now();

/** Live rows only. Tombstones stay in the store for a future sync peer to observe. */
const alive = <T extends SyncFields>(rows: T[]): T[] => rows.filter((r) => !r.deletedAt);

// ---------------------------------------------------------------- sessions

export interface StartSessionInput {
  machineId: string;
  bodyweightRawLb?: number;
  bodyweightSmoothedLb?: number;
  routineId?: string;
  /** Stamped when the workout was started from a program, so the rotation can be derived. */
  programId?: string;
  programSessionId?: string;
}

/**
 * Starts a session, or returns the one already open.
 *
 * docs/adr/0005 requires the active session be found by QUERY rather than a cached id: two tabs
 * caching an id would each create their own envelope.
 */
export async function startSession(input: StartSessionInput): Promise<SessionRecord> {
  const existing = await getActiveSession();
  if (existing) return existing;

  const record: SessionRecord = {
    id: newId(),
    startedAt: now(),
    updatedAt: now(),
    status: 'active',
    machineId: input.machineId,
    ...(input.bodyweightRawLb !== undefined && { bodyweightRawLb: input.bodyweightRawLb }),
    ...(input.bodyweightSmoothedLb !== undefined && {
      bodyweightSmoothedLb: input.bodyweightSmoothedLb,
    }),
    ...(input.routineId !== undefined && { routineId: input.routineId }),
    ...(input.programId !== undefined && { programId: input.programId }),
    ...(input.programSessionId !== undefined && { programSessionId: input.programSessionId }),
  };

  await transact(Store.Sessions, 'readwrite', (tx) => put(tx, Store.Sessions, record));
  publishChange(Store.Sessions, [record.id]);
  return record;
}

export async function getActiveSession(): Promise<SessionRecord | undefined> {
  const rows = await transact(Store.Sessions, 'readonly', (tx) =>
    getAllFromIndex<SessionRecord>(tx, Store.Sessions, 'by-status', IDBKeyRange.only('active')),
  );
  return alive(rows).sort((a, b) => b.startedAt - a.startedAt)[0];
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return transact(Store.Sessions, 'readonly', (tx) =>
    getById<SessionRecord>(tx, Store.Sessions, id),
  );
}

export async function endSession(
  id: string,
  status: 'complete' | 'abandoned' = 'complete',
): Promise<SessionRecord | undefined> {
  const updated = await transact(Store.Sessions, 'readwrite', async (tx) => {
    const record = await getById<SessionRecord>(tx, Store.Sessions, id);
    if (!record) return undefined;

    const next: SessionRecord = { ...record, status, endedAt: now(), updatedAt: now() };
    await put(tx, Store.Sessions, next);
    return next;
  });

  if (updated) publishChange(Store.Sessions, [id]);
  return updated;
}

/** Soft-deletes a session and every set in it, so history stays consistent. */
export async function deleteSession(id: string): Promise<number> {
  const stamp = now();

  const count = await transact([Store.Sessions, Store.SetLogs], 'readwrite', async (tx) => {
    const session = await getById<SessionRecord>(tx, Store.Sessions, id);
    if (session && !session.deletedAt) {
      await put(tx, Store.Sessions, { ...session, deletedAt: stamp, updatedAt: stamp });
    }

    const sets = await getAllFromIndex<SetLogRecord>(
      tx, Store.SetLogs, 'by-session', IDBKeyRange.only(id));

    let deleted = 0;
    for (const set of sets) {
      if (set.deletedAt) continue;
      await put(tx, Store.SetLogs, { ...set, deletedAt: stamp, updatedAt: stamp });
      deleted++;
    }
    return deleted;
  });

  publishChange(Store.Sessions, [id]);
  publishChange(Store.SetLogs, []);
  return count;
}

/**
 * Discards sessions that were opened but never used.
 *
 * Sessions are created lazily now, but earlier builds created one on every app open, so plenty
 * of empty ones are already in people's logbooks. This clears them without touching anything
 * that has a set attached.
 */
export async function purgeEmptySessions(): Promise<number> {
  const sessions = await listSessions();
  let purged = 0;

  for (const session of sessions) {
    const sets = await getSessionSets(session.id);
    if (sets.length === 0) {
      await deleteSession(session.id);
      purged++;
    }
  }

  return purged;
}

/**
 * Sessions left 'active' for longer than `olderThanHours` AND holding at least one set.
 *
 * The set requirement matters: an empty session is not an unfinished workout, it is someone
 * who opened the app. Prompting about those is pure noise, which is what happened before
 * sessions became lazy.
 */
export async function findOrphanedSessions(olderThanHours = 6): Promise<SessionRecord[]> {
  const cutoff = now() - olderThanHours * 3_600_000;
  const rows = await transact(Store.Sessions, 'readonly', (tx) =>
    getAllFromIndex<SessionRecord>(tx, Store.Sessions, 'by-status', IDBKeyRange.only('active')),
  );

  const stale = alive(rows).filter((s) => s.startedAt < cutoff);

  const withSets: SessionRecord[] = [];
  for (const session of stale) {
    if ((await getSessionSets(session.id)).length > 0) withSets.push(session);
  }
  return withSets;
}

export async function listSessions(sinceMs?: Instant | null): Promise<SessionRecord[]> {
  const range = sinceMs == null ? undefined : IDBKeyRange.lowerBound(sinceMs);
  const rows = await transact(Store.Sessions, 'readonly', (tx) =>
    getAllFromIndex<SessionRecord>(tx, Store.Sessions, 'by-startedAt', range),
  );
  return alive(rows).sort((a, b) => b.startedAt - a.startedAt);
}

// ---------------------------------------------------------------- set logs

export type LogSetInput = Omit<SetLogRecord, keyof SyncFields | 'ts' | 'on'> &
  Partial<Pick<SetLogRecord, 'ts'>>;

/**
 * Appends one working set. This is the hot path: called on tap, never buffered in memory, and
 * durable before the button's animation finishes (docs/adr/0005).
 */
export async function logSet(input: LogSetInput): Promise<SetLogRecord> {
  const ts = input.ts ?? now();
  const record: SetLogRecord = { ...input, id: newId(), ts, on: toIsoDate(ts), updatedAt: now() };

  await transact(Store.SetLogs, 'readwrite', (tx) => put(tx, Store.SetLogs, record));
  publishChange(Store.SetLogs, [record.id]);
  return record;
}

/** Corrects a logged set -- a mistyped rep count, usually. */
export async function updateSet(
  id: string,
  changes: Partial<Omit<SetLogRecord, keyof SyncFields>>,
): Promise<SetLogRecord | undefined> {
  const updated = await transact(Store.SetLogs, 'readwrite', async (tx) => {
    const record = await getById<SetLogRecord>(tx, Store.SetLogs, id);
    if (!record) return undefined;

    const next: SetLogRecord = { ...record, ...changes, updatedAt: now() };
    if (changes.ts !== undefined) next.on = toIsoDate(changes.ts);

    await put(tx, Store.SetLogs, next);
    return next;
  });

  if (updated) publishChange(Store.SetLogs, [id]);
  return updated;
}

/** Soft-deletes. The row survives as a tombstone so a future peer can observe the deletion. */
export async function deleteSet(id: string): Promise<boolean> {
  const done = await transact(Store.SetLogs, 'readwrite', async (tx) => {
    const record = await getById<SetLogRecord>(tx, Store.SetLogs, id);
    if (!record || record.deletedAt) return false;

    await put(tx, Store.SetLogs, { ...record, deletedAt: now(), updatedAt: now() });
    return true;
  });

  if (done) publishChange(Store.SetLogs, [id]);
  return done;
}

export async function getSessionSets(sessionId: string): Promise<SetLogRecord[]> {
  const rows = await transact(Store.SetLogs, 'readonly', (tx) =>
    getAllFromIndex<SetLogRecord>(tx, Store.SetLogs, 'by-session', IDBKeyRange.only(sessionId)),
  );
  return alive(rows).sort((a, b) => a.ts - b.ts);
}

/** History for one exercise, newest last. What the progression engine reads. */
export async function getExerciseHistory(
  exerciseId: string,
  sinceMs?: Instant | null,
): Promise<SetLogRecord[]> {
  // Infinity is NOT a valid IndexedDB key -- only finite numbers, strings, dates, binary, and
  // arrays of those. Using +/-Infinity as sentinels throws DataError at runtime, which unit
  // tests miss whenever they pass a real timestamp.
  const lower = [exerciseId, sinceMs ?? 0] as [string, number];
  const upper = [exerciseId, Number.MAX_SAFE_INTEGER] as [string, number];

  const rows = await transact(Store.SetLogs, 'readonly', (tx) =>
    getAllFromIndex<SetLogRecord>(
      tx,
      Store.SetLogs,
      'by-exercise-ts',
      IDBKeyRange.bound(lower, upper),
    ),
  );
  return alive(rows).sort((a, b) => a.ts - b.ts);
}

/** Every set in a date range. What the volume ledger reads. */
export async function getSetsBetween(from: IsoDate, to: IsoDate): Promise<SetLogRecord[]> {
  const rows = await transact(Store.SetLogs, 'readonly', (tx) =>
    getAllFromIndex<SetLogRecord>(tx, Store.SetLogs, 'by-on', IDBKeyRange.bound(from, to)),
  );
  return alive(rows).sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------- bodyweight

/** Records a weigh-in. One per calendar day: a re-weigh replaces, never accumulates. */
export async function recordBodyweight(on: IsoDate, lb: number): Promise<BodyweightRecord> {
  const record = await transact(Store.Bodyweight, 'readwrite', async (tx) => {
    const index = tx.objectStore(Store.Bodyweight).index('by-on');
    const existing = await promisify(
      index.get(IDBKeyRange.only(on)) as IDBRequest<BodyweightRecord | undefined>,
    );

    let next: BodyweightRecord;
    if (existing) {
      // Re-weighing an entry that was deleted revives it. The tombstone key is dropped
      // rather than set to undefined, which exactOptionalPropertyTypes correctly rejects.
      const { deletedAt: _tombstone, ...revived } = existing;
      next = { ...revived, lb, updatedAt: now() };
    } else {
      next = { id: newId(), on, lb, updatedAt: now() };
    }

    await put(tx, Store.Bodyweight, next);
    return next;
  });

  publishChange(Store.Bodyweight, [record.id]);
  return record;
}

export async function getBodyweightReadings(
  sinceOn?: IsoDate | null,
): Promise<BodyweightRecord[]> {
  // `== null` deliberately, to catch BOTH null and undefined. C# marshals an absent argument
  // as null, and `=== undefined` would let it through to IDBKeyRange, which rejects null as an
  // invalid key with an opaque DataError.
  const range = sinceOn == null ? undefined : IDBKeyRange.lowerBound(sinceOn);
  const rows = await transact(Store.Bodyweight, 'readonly', (tx) =>
    getAllFromIndex<BodyweightRecord>(tx, Store.Bodyweight, 'by-on', range),
  );
  return alive(rows).sort((a, b) => a.on.localeCompare(b.on));
}

export async function getLatestBodyweight(): Promise<BodyweightRecord | undefined> {
  const all = await getBodyweightReadings();
  return all[all.length - 1];
}

// ---------------------------------------------------------------- machines

export async function saveMachine(
  machine: Omit<MachineRecord, keyof SyncFields> & Partial<SyncFields>,
): Promise<MachineRecord> {
  const record: MachineRecord = { ...machine, id: machine.id ?? newId(), updatedAt: now() };
  await transact(Store.Machines, 'readwrite', (tx) => put(tx, Store.Machines, record));
  publishChange(Store.Machines, [record.id]);
  return record;
}

export async function listMachines(): Promise<MachineRecord[]> {
  return alive(await transact(Store.Machines, 'readonly', (tx) => getAll<MachineRecord>(tx, Store.Machines)));
}

export async function getDefaultMachine(): Promise<MachineRecord | undefined> {
  const machines = await listMachines();
  return machines.find((m) => m.isDefault) ?? machines[0];
}

// ---------------------------------------------------------------- settings

const SETTINGS_ID = 'settings' as const;

export async function getSettings(): Promise<SettingsRecord> {
  const existing = await transact(Store.Settings, 'readonly', (tx) =>
    getById<SettingsRecord>(tx, Store.Settings, SETTINGS_ID),
  );
  return existing ?? { id: SETTINGS_ID, updatedAt: 0 };
}

export async function saveSettings(
  changes: Partial<Omit<SettingsRecord, 'id' | 'updatedAt'>>,
): Promise<SettingsRecord> {
  const record = await transact(Store.Settings, 'readwrite', async (tx) => {
    const current =
      (await getById<SettingsRecord>(tx, Store.Settings, SETTINGS_ID)) ??
      ({ id: SETTINGS_ID, updatedAt: 0 } as SettingsRecord);

    const next: SettingsRecord = { ...current, ...changes, id: SETTINGS_ID, updatedAt: now() };
    await put(tx, Store.Settings, next);
    return next;
  });

  publishChange(Store.Settings, [SETTINGS_ID]);
  return record;
}

// ---------------------------------------------------------------- programs

export async function listPrograms(): Promise<ProgramRecord[]> {
  return alive(await transact(Store.Programs, 'readonly', (tx) => getAll<ProgramRecord>(tx, Store.Programs)));
}

export async function getActiveProgram(): Promise<ProgramRecord | undefined> {
  return (await listPrograms()).find((p) => p.isActive);
}

export async function getProgram(id: string): Promise<ProgramRecord | undefined> {
  const record = await transact(Store.Programs, 'readonly', (tx) =>
    getById<ProgramRecord>(tx, Store.Programs, id),
  );
  return record && !record.deletedAt ? record : undefined;
}

export type SaveProgramInput = Omit<ProgramRecord, keyof SyncFields | 'isActive'> &
  Partial<Pick<ProgramRecord, 'id' | 'isActive'>>;

/**
 * Creates or updates a program.
 *
 * Activating one deactivates the rest in the SAME transaction. Two active programs would make
 * "which session is next" ambiguous, and the ambiguity would only surface as the app quietly
 * naming the wrong day.
 */
export async function saveProgram(input: SaveProgramInput): Promise<ProgramRecord> {
  const record = await transact(Store.Programs, 'readwrite', async (tx) => {
    const existing = input.id ? await getById<ProgramRecord>(tx, Store.Programs, input.id) : undefined;

    const next: ProgramRecord = {
      ...existing,
      ...input,
      id: input.id ?? newId(),
      isActive: input.isActive ?? existing?.isActive ?? false,
      updatedAt: now(),
    };

    if (next.isActive) {
      for (const other of await getAll<ProgramRecord>(tx, Store.Programs)) {
        if (other.id === next.id || !other.isActive) continue;
        await put(tx, Store.Programs, { ...other, isActive: false, updatedAt: now() });
      }
    }

    await put(tx, Store.Programs, next);
    return next;
  });

  publishChange(Store.Programs, [record.id]);
  return record;
}

export async function setActiveProgram(id: string | undefined): Promise<void> {
  const programs = await listPrograms();
  const touched: string[] = [];

  await transact(Store.Programs, 'readwrite', async (tx) => {
    for (const program of programs) {
      const shouldBeActive = program.id === id;
      if (program.isActive === shouldBeActive) continue;

      await put(tx, Store.Programs, { ...program, isActive: shouldBeActive, updatedAt: now() });
      touched.push(program.id);
    }
  });

  if (touched.length > 0) publishChange(Store.Programs, touched);
}

/** Soft delete, so a future sync peer sees the removal rather than resurrecting the row. */
export async function deleteProgram(id: string): Promise<boolean> {
  const removed = await transact(Store.Programs, 'readwrite', async (tx) => {
    const existing = await getById<ProgramRecord>(tx, Store.Programs, id);
    if (!existing || existing.deletedAt) return false;

    await put(tx, Store.Programs, { ...existing, isActive: false, deletedAt: now(), updatedAt: now() });
    return true;
  });

  if (removed) publishChange(Store.Programs, [id]);
  return removed;
}

// ------------------------------------------------------- custom exercises

export async function listCustomExercises(): Promise<CustomExerciseRecord[]> {
  return alive(
    await transact(Store.CustomExercises, 'readonly', (tx) =>
      getAll<CustomExerciseRecord>(tx, Store.CustomExercises),
    ),
  );
}

export type SaveCustomExerciseInput = Omit<CustomExerciseRecord, keyof SyncFields> &
  Partial<Pick<CustomExerciseRecord, 'id'>>;

export async function saveCustomExercise(
  input: SaveCustomExerciseInput,
): Promise<CustomExerciseRecord> {
  const record = await transact(Store.CustomExercises, 'readwrite', async (tx) => {
    const existing = input.id
      ? await getById<CustomExerciseRecord>(tx, Store.CustomExercises, input.id)
      : undefined;

    const next: CustomExerciseRecord = {
      ...existing,
      ...input,
      id: input.id ?? newId(),
      updatedAt: now(),
    };

    await put(tx, Store.CustomExercises, next);
    return next;
  });

  publishChange(Store.CustomExercises, [record.id]);
  return record;
}

/**
 * Soft delete. The exercise disappears from the picker; sets already logged against it keep
 * their id and stay in the history, and ExerciseCatalog.nameOf falls back to a de-slugged name
 * so they remain readable.
 */
export async function deleteCustomExercise(id: string): Promise<boolean> {
  const removed = await transact(Store.CustomExercises, 'readwrite', async (tx) => {
    const existing = await getById<CustomExerciseRecord>(tx, Store.CustomExercises, id);
    if (!existing || existing.deletedAt) return false;

    await put(tx, Store.CustomExercises, { ...existing, deletedAt: now(), updatedAt: now() });
    return true;
  });

  if (removed) publishChange(Store.CustomExercises, [id]);
  return removed;
}
