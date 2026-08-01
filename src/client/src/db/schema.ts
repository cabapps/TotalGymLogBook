/**
 * IndexedDB schema for Total Gym Logbook.
 *
 * TypeScript owns this database exclusively (docs/adr/0003). Blazor never opens it -- it calls
 * through bridge.ts and receives JSON. One data-access layer, one migration path, no
 * two-drivers-disagreeing class of bug.
 *
 * Every record carries the three things docs/adr/0001 requires so that sync can be added later
 * without a rewrite, even though no sync exists today:
 *
 *   id         client-generated UUID, never an autoincrement key
 *   updatedAt  epoch ms, bumped on every write
 *   deletedAt  tombstone; rows are soft-deleted so a future peer can observe the deletion
 *
 * That is last-write-wins, not event sourcing. Sets are cheap to append but still editable in
 * place -- a user who fat-fingers "21 reps" needs to fix it, not append a correction they then
 * have to understand.
 */

export const DB_NAME = 'totalgymlogbook';

/** Bump when adding a store or index, and add a matching step to MIGRATIONS. */
export const DB_VERSION = 1;

export const Store = {
  Sessions: 'sessions',
  SetLogs: 'setLogs',
  Bodyweight: 'bodyweight',
  Machines: 'machines',
  Settings: 'settings',
} as const;

export type StoreName = (typeof Store)[keyof typeof Store];

/** Epoch milliseconds. */
export type Instant = number;

/** Calendar date as 'YYYY-MM-DD' -- lexicographically sortable, so it indexes directly. */
export type IsoDate = string;

export interface SyncFields {
  id: string;
  updatedAt: Instant;
  /** Tombstone. Present means deleted; the row stays so sync can propagate the deletion. */
  deletedAt?: Instant;
}

export type SessionStatus = 'active' | 'complete' | 'abandoned';

/**
 * The session envelope (docs/adr/0005). Bodyweight is snapshotted here ONCE at session start
 * and copied down to each set -- re-reading it per set would let a mid-workout weigh-in make
 * sets within one session incomparable, which docs/adr/0004 assumes cannot happen.
 */
export interface SessionRecord extends SyncFields {
  startedAt: Instant;
  endedAt?: Instant;
  status: SessionStatus;
  machineId: string;
  bodyweightRawLb?: number;
  bodyweightSmoothedLb?: number;
  routineId?: string;
  notes?: string;
}

/**
 * One logged working set. Carries the full snapshot from docs/adr/0004: historical resistance
 * is never recomputed, because bodyweight, calibration, and our own profile data all drift
 * underneath it. Storing only {level, exerciseId} would make a user who lost 20 lb watch their
 * entire history retroactively drop.
 */
export interface SetLogRecord extends SyncFields {
  sessionId: string;
  exerciseId: string;
  ts: Instant;
  /** Calendar date of `ts`, denormalized so day-range queries can use an index. */
  on: IsoDate;

  reps: number;
  level: number;

  // --- computation inputs, frozen at log time ---
  bodyweightRawLb: number;
  bodyweightSmoothedLb: number;
  angleDeg: number;
  boardWeightLb: number;
  pulleyFactor: number;
  bodyFraction: number;
  vestLb: number;
  barLb: number;
  directLoadLb: number;

  /** Denormalized result. */
  computedLb: number;
  /** Lets a future formula change migrate history deliberately rather than drifting. */
  formulaVersion: number;

  /** Optional reps-in-reserve, if the trainee recorded it. */
  rir?: number;
}

export interface BodyweightRecord extends SyncFields {
  on: IsoDate;
  lb: number;
}

export interface MachineRecord extends SyncFields {
  name: string;
  railProfileId: string;
  /** Per-level overrides from the phone inclinometer (docs/adr/0004). */
  calibratedAngleDeg?: number[];
  isDefault?: boolean;
}

/** Single-row key/value store for user preferences. */
export interface SettingsRecord extends SyncFields {
  id: 'settings';
  goalPrimary?: string;
  goalSecondary?: string;
  /** 'auto' or a pinned phase -- the advanced override from docs/adr/0010. */
  phaseOverride?: string;
  experienceOverride?: string;
  units?: 'lb' | 'kg';
  defaultMachineId?: string;
  /**
   * Accessories the trainee actually owns, so the picker stops offering movements they cannot
   * do. UNDEFINED means never configured and filters nothing; an empty array means "I own
   * none of these" and filters hard. See ExerciseCatalog.available.
   */
  ownedAttachments?: string[];
  /**
   * Preferred rep-counting source, keyed by exercise id. Per-exercise and not global, because
   * motion counting works for chest press and not at all for standing cable work -- one global
   * setting would feel broken half the time (docs/adr/0006).
   */
  repAssist?: Record<string, string>;
}

export type AnyRecord =
  | SessionRecord
  | SetLogRecord
  | BodyweightRecord
  | MachineRecord
  | SettingsRecord;

interface IndexSpec {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

interface StoreSpec {
  name: StoreName;
  indexes: IndexSpec[];
}

/**
 * Store layout. Indexes exist for the queries the coach actually runs:
 * per-exercise history for progression, date ranges for the volume ledger, and the active
 * session lookup that docs/adr/0005 requires be a QUERY rather than a cached id.
 */
export const STORES: StoreSpec[] = [
  {
    name: Store.Sessions,
    indexes: [
      { name: 'by-startedAt', keyPath: 'startedAt' },
      { name: 'by-status', keyPath: 'status' },
    ],
  },
  {
    name: Store.SetLogs,
    indexes: [
      { name: 'by-session', keyPath: 'sessionId' },
      { name: 'by-ts', keyPath: 'ts' },
      { name: 'by-on', keyPath: 'on' },
      { name: 'by-exercise-ts', keyPath: ['exerciseId', 'ts'] },
    ],
  },
  {
    name: Store.Bodyweight,
    indexes: [{ name: 'by-on', keyPath: 'on', unique: true }],
  },
  {
    name: Store.Machines,
    indexes: [],
  },
  {
    name: Store.Settings,
    indexes: [],
  },
];

/**
 * Migrations run in order for versions above the existing one. Never edit a shipped migration
 * -- users already ran it. Add a new one and bump DB_VERSION.
 */
export const MIGRATIONS: Array<(db: IDBDatabase, tx: IDBTransaction) => void> = [
  // v1 -- initial schema
  (db) => {
    for (const spec of STORES) {
      const store = db.createObjectStore(spec.name, { keyPath: 'id' });
      for (const index of spec.indexes) {
        store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
      }
    }
  },
];

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The LOCAL calendar date of an instant.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC. Someone training at 8pm in
 * Chicago has a timestamp of 01:00 UTC the following day, so a UTC date files that set under
 * tomorrow -- splitting one evening workout across two dates, and shifting it out of the
 * trailing window the volume ledger counts.
 *
 * "Which day did I train?" is always a local-calendar question.
 */
export function toIsoDate(instant: Instant): IsoDate {
  const d = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
