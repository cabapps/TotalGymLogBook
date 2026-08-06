/**
 * Export and import.
 *
 * With no server, this IS the durability story (docs/adr/0001). Storage eviction is a real
 * risk -- Safari clears script-writable storage after 7 days without interaction, and only an
 * installed home-screen PWA is exempt -- so backup is a first-class flow, not a settings-page
 * afterthought.
 *
 * Tombstones are included deliberately. A backup that silently resurrects deleted rows on
 * restore is worse than one that does not, and merge needs them to apply deletions.
 */

import { getAll, put, resetConnection, transact } from './database.js';
import { publishChange } from './events.js';
import { STORES, Store, type AnyRecord, type StoreName, type SyncFields } from './schema.js';

export const BACKUP_FORMAT = 1;

export interface Backup {
  format: number;
  app: 'totalgymlogbook';
  exportedAt: string;
  /** Schema version the export came from, so a future import can migrate. */
  dbVersion: number;
  records: Record<string, AnyRecord[]>;
}

export type ImportMode = 'merge' | 'replace';

export interface ImportResult {
  mode: ImportMode;
  inserted: number;
  updated: number;
  skipped: number;
}

export async function exportBackup(): Promise<Backup> {
  const names = STORES.map((s) => s.name);
  const records: Record<string, AnyRecord[]> = {};

  await transact(names, 'readonly', async (tx) => {
    for (const name of names) {
      records[name] = await getAll<AnyRecord>(tx, name);
    }
  });

  return {
    format: BACKUP_FORMAT,
    app: 'totalgymlogbook',
    exportedAt: new Date().toISOString(),
    dbVersion: (await import('./schema.js')).DB_VERSION,
    records,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await exportBackup(), null, 2);
}

function assertBackup(value: unknown): asserts value is Backup {
  const backup = value as Partial<Backup>;

  if (!backup || typeof backup !== 'object') throw new Error('Backup is not an object.');
  if (backup.app !== 'totalgymlogbook') {
    throw new Error('This file is not a Total Gym Logbook backup.');
  }
  if (typeof backup.format !== 'number' || backup.format > BACKUP_FORMAT) {
    throw new Error(
      `Backup format ${backup.format} is newer than this app understands (${BACKUP_FORMAT}). ` +
        'Update the app and try again.',
    );
  }
  if (!backup.records || typeof backup.records !== 'object') {
    throw new Error('Backup has no records.');
  }
}

/**
 * Restores a backup.
 *
 *   merge    last-write-wins on updatedAt. Safe to run twice, and safe against a backup that
 *            is older than the live data -- which is the common case when someone restores to
 *            recover one deleted session. This is the same conflict rule a future sync would
 *            use, so the code path gets exercised now.
 *   replace  clears every store first. For moving to a new device.
 */
export async function importBackup(input: string | Backup, mode: ImportMode = 'merge'): Promise<ImportResult> {
  const backup: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  assertBackup(backup);

  const names = STORES.map((s) => s.name);
  const result: ImportResult = { mode, inserted: 0, updated: 0, skipped: 0 };
  const touched = new Map<StoreName, string[]>();

  await transact(names, 'readwrite', async (tx) => {
    for (const name of names) {
      const incoming = backup.records[name] ?? [];
      const store = tx.objectStore(name);

      if (mode === 'replace') {
        store.clear();
      }

      const existing =
        mode === 'merge'
          ? new Map((await getAll<AnyRecord>(tx, name)).map((r) => [r.id, r]))
          : new Map<string, AnyRecord>();

      // Rows already here that hold a UNIQUE index value, so an incoming row claiming the same
      // value can be reconciled rather than aborting the whole restore. See uniqueKeysOf.
      const owners = uniqueOwners(name, [...existing.values()]);

      for (const record of incoming) {
        if (!isSyncRecord(record)) {
          result.skipped++;
          continue;
        }

        const current = existing.get(record.id);
        if (current && current.updatedAt >= record.updatedAt) {
          result.skipped++;
          continue;
        }

        // A DIFFERENT row already owns this record's unique key.
        //
        // One case, and it is the one every restore hits: bodyweight has a unique index on the
        // calendar day. Re-onboarding after a wipe writes today's weight under a fresh id, and
        // the backup then arrives with the same day under its old id. IndexedDB refuses the
        // second write, the transaction aborts, and NOTHING is restored -- which is exactly the
        // moment somebody most needs their data back.
        //
        // Resolved the same way as everything else here: last write wins. The older row goes.
        const key = uniqueKeyOf(name, record);
        const owner = key === undefined ? undefined : owners.get(key);

        if (owner && owner.id !== record.id) {
          if (owner.updatedAt >= record.updatedAt) {
            result.skipped++;
            continue;
          }

          store.delete(owner.id);
          existing.delete(owner.id);
          owners.delete(key!);
        }

        await put(tx, name, record);
        if (key !== undefined) owners.set(key, record);

        current ? result.updated++ : result.inserted++;
        touched.set(name, [...(touched.get(name) ?? []), record.id]);
      }
    }
  });

  for (const [name, ids] of touched) publishChange(name, ids);
  return result;
}

/**
 * The value a store's UNIQUE index would key this record by, if it has one.
 *
 * Read off STORES rather than hardcoded, so adding a unique index cannot quietly reintroduce the
 * aborted-restore bug: the reconciliation covers whatever the schema declares.
 */
function uniqueKeyOf(name: StoreName, record: AnyRecord): string | undefined {
  const index = STORES.find((s) => s.name === name)?.indexes.find((i) => i.unique);
  if (!index || typeof index.keyPath !== 'string') return undefined;

  const value = (record as unknown as Record<string, unknown>)[index.keyPath];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** Who currently holds each unique key, so a collision can be resolved rather than thrown. */
function uniqueOwners(name: StoreName, records: readonly AnyRecord[]): Map<string, SyncFields> {
  const owners = new Map<string, SyncFields>();

  for (const record of records) {
    const key = uniqueKeyOf(name, record);
    if (key !== undefined) owners.set(key, record);
  }

  return owners;
}

function isSyncRecord(value: unknown): value is SyncFields {
  const record = value as Partial<SyncFields>;
  return typeof record?.id === 'string' && typeof record?.updatedAt === 'number';
}

/** Wipes everything. Used by tests and by an explicit "delete my data" action. */
export async function clearAllData(): Promise<void> {
  const names = STORES.map((s) => s.name);
  await transact(names, 'readwrite', (tx) => {
    for (const name of names) tx.objectStore(name).clear();
  });
  for (const name of names) publishChange(name, []);
}

export { Store, resetConnection };
