/**
 * Exercises the IndexedDB layer against fake-indexeddb, which is a real implementation of the
 * spec rather than a stub -- so transaction semantics, index ranges, and key ordering all
 * behave as they will in a browser.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { exportBackup, importBackup } from '../src/db/backup.js';
import { resetConnection } from '../src/db/database.js';
import { onChange, resetEvents } from '../src/db/events.js';
import * as repo from '../src/db/repository.js';
import { Store, toIsoDate, type SetLogRecord } from '../src/db/schema.js';

/** A logged set with every snapshot field populated, as docs/adr/0004 requires. */
function setInput(over: Partial<Parameters<typeof repo.logSet>[0]> = {}) {
  return {
    sessionId: 'session-1',
    exerciseId: 'chest-press',
    reps: 10,
    level: 8,
    bodyweightRawLb: 181.2,
    bodyweightSmoothedLb: 180,
    angleDeg: 16.5,
    boardWeightLb: 19.8,
    pulleyFactor: 1,
    bodyFraction: 1,
    vestLb: 0,
    barLb: 0,
    directLoadLb: 0,
    computedLb: 56.7,
    formulaVersion: 1,
    ...over,
  };
}

beforeEach(async () => {
  // Fresh database per test. fake-indexeddb's IDBFactory has no persistence between instances.
  globalThis.indexedDB = new IDBFactory();
  resetConnection();
  resetEvents();
});

describe('sessions', () => {
  it('starts a session and finds it by query, not by cached id', async () => {
    const started = await repo.startSession({ machineId: 'm1', bodyweightSmoothedLb: 180 });
    const found = await repo.getActiveSession();

    expect(found?.id).toBe(started.id);
    expect(found?.status).toBe('active');
  });

  it('does not create a second envelope when one is already open', async () => {
    // docs/adr/0005: two tabs each caching a session id would double-create.
    const first = await repo.startSession({ machineId: 'm1' });
    const second = await repo.startSession({ machineId: 'm1' });

    expect(second.id).toBe(first.id);
    expect(await repo.listSessions()).toHaveLength(1);
  });

  it('ends a session', async () => {
    const session = await repo.startSession({ machineId: 'm1' });
    const ended = await repo.endSession(session.id);

    expect(ended?.status).toBe('complete');
    expect(ended?.endedAt).toBeGreaterThan(0);
    expect(await repo.getActiveSession()).toBeUndefined();
  });

  it('surfaces orphaned sessions rather than closing or resuming them', async () => {
    const session = await repo.startSession({ machineId: 'm1' });

    // Backdate to yesterday.
    const stale = { ...session, startedAt: Date.now() - 20 * 3_600_000 };
    await importBackup({
      format: 1, app: 'totalgymlogbook', exportedAt: '', dbVersion: 1,
      records: { [Store.Sessions]: [{ ...stale, updatedAt: Date.now() + 1 }] },
    });

    const orphans = await repo.findOrphanedSessions(6);
    expect(orphans.map((o) => o.id)).toContain(session.id);
    // Still active -- the caller prompts, the repository does not decide.
    expect((await repo.getActiveSession())?.id).toBe(session.id);
  });
});

describe('set logs', () => {
  it('appends a set and reads it back on the session', async () => {
    const logged = await repo.logSet(setInput());
    const sets = await repo.getSessionSets('session-1');

    expect(sets).toHaveLength(1);
    expect(sets[0]!.id).toBe(logged.id);
    expect(sets[0]!.computedLb).toBe(56.7);
  });

  it('freezes the computation snapshot so history cannot be retroactively rewritten', async () => {
    // docs/adr/0004: a user who loses 20 lb must not watch their whole history drop.
    const logged = await repo.logSet(setInput());

    expect(logged.bodyweightSmoothedLb).toBe(180);
    expect(logged.angleDeg).toBe(16.5);
    expect(logged.boardWeightLb).toBe(19.8);
    expect(logged.formulaVersion).toBe(1);
  });

  it('generates client-side UUIDs, never autoincrement keys', async () => {
    const a = await repo.logSet(setInput());
    const b = await repo.logSet(setInput());

    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('corrects a mistyped rep count', async () => {
    const logged = await repo.logSet(setInput({ reps: 21 }));
    const fixed = await repo.updateSet(logged.id, { reps: 12 });

    expect(fixed?.reps).toBe(12);
    expect(fixed?.updatedAt).toBeGreaterThanOrEqual(logged.updatedAt);
  });

  it('soft-deletes, keeping the tombstone for a future sync peer', async () => {
    const logged = await repo.logSet(setInput());
    expect(await repo.deleteSet(logged.id)).toBe(true);

    expect(await repo.getSessionSets('session-1')).toHaveLength(0);

    // The row itself survives.
    const backup = await exportBackup();
    const rows = backup.records[Store.SetLogs] as SetLogRecord[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeGreaterThan(0);
  });

  it('returns per-exercise history in chronological order', async () => {
    const base = Date.now() - 10 * 86_400_000;
    await repo.logSet(setInput({ ts: base + 2 * 86_400_000, reps: 12 }));
    await repo.logSet(setInput({ ts: base, reps: 8 }));
    await repo.logSet(setInput({ ts: base + 86_400_000, reps: 10 }));
    await repo.logSet(setInput({ exerciseId: 'seated-row', ts: base, reps: 15 }));

    const history = await repo.getExerciseHistory('chest-press');

    expect(history.map((s) => s.reps)).toEqual([8, 10, 12]);
  });

  it('filters exercise history by date', async () => {
    const base = Date.now() - 30 * 86_400_000;
    await repo.logSet(setInput({ ts: base }));
    await repo.logSet(setInput({ ts: Date.now() }));

    const recent = await repo.getExerciseHistory('chest-press', Date.now() - 7 * 86_400_000);
    expect(recent).toHaveLength(1);
  });

  it('returns sets in a date range for the volume ledger', async () => {
    const day = 86_400_000;
    const now = Date.now();
    await repo.logSet(setInput({ ts: now - 20 * day }));
    await repo.logSet(setInput({ ts: now - 3 * day }));
    await repo.logSet(setInput({ ts: now }));

    const week = await repo.getSetsBetween(toIsoDate(now - 7 * day), toIsoDate(now));
    expect(week).toHaveLength(2);
  });
});

describe('bodyweight', () => {
  it('records a weigh-in', async () => {
    await repo.recordBodyweight('2026-03-01', 180.4);
    const readings = await repo.getBodyweightReadings();

    expect(readings).toHaveLength(1);
    expect(readings[0]!.lb).toBe(180.4);
  });

  it('replaces rather than accumulates when weighing in twice on one day', async () => {
    await repo.recordBodyweight('2026-03-01', 180.4);
    await repo.recordBodyweight('2026-03-01', 179.8);

    const readings = await repo.getBodyweightReadings();
    expect(readings).toHaveLength(1);
    expect(readings[0]!.lb).toBe(179.8);
  });

  it('returns readings in date order', async () => {
    await repo.recordBodyweight('2026-03-03', 179);
    await repo.recordBodyweight('2026-03-01', 181);
    await repo.recordBodyweight('2026-03-02', 180);

    expect((await repo.getBodyweightReadings()).map((r) => r.lb)).toEqual([181, 180, 179]);
    expect((await repo.getLatestBodyweight())?.lb).toBe(179);
  });
});

describe('settings', () => {
  it('returns a default record before anything is saved', async () => {
    const settings = await repo.getSettings();
    expect(settings.id).toBe('settings');
  });

  it('merges partial updates', async () => {
    await repo.saveSettings({ goalPrimary: 'Hypertrophy' });
    await repo.saveSettings({ units: 'lb' });

    const settings = await repo.getSettings();
    expect(settings.goalPrimary).toBe('Hypertrophy');
    expect(settings.units).toBe('lb');
  });
});

describe('change events', () => {
  it('announces writes so Blazor and other tabs can re-read', async () => {
    const seen: Array<{ store: string; ids: string[] }> = [];
    onChange((e) => seen.push({ store: e.store, ids: e.ids }));

    const logged = await repo.logSet(setInput());

    expect(seen).toContainEqual({ store: Store.SetLogs, ids: [logged.id] });
  });

  it('carries ids only, never record payloads', async () => {
    // docs/adr/0003 rule 2: the boundary carries ids, consumers re-read.
    let captured: unknown;
    onChange((e) => (captured = e));

    await repo.logSet(setInput());

    expect(Object.keys(captured as object).sort()).toEqual(['ids', 'remote', 'store']);
  });

  it('a throwing listener cannot fail a write', async () => {
    onChange(() => {
      throw new Error('subscriber exploded');
    });

    await expect(repo.logSet(setInput())).resolves.toBeDefined();
    expect(await repo.getSessionSets('session-1')).toHaveLength(1);
  });
});

describe('backup', () => {
  it('round-trips everything', async () => {
    await repo.startSession({ machineId: 'm1', bodyweightSmoothedLb: 180 });
    await repo.logSet(setInput());
    await repo.recordBodyweight('2026-03-01', 180);
    await repo.saveSettings({ goalPrimary: 'Hypertrophy' });

    const backup = await exportBackup();

    globalThis.indexedDB = new IDBFactory();
    resetConnection();

    const result = await importBackup(backup, 'replace');

    expect(result.inserted).toBeGreaterThan(0);
    expect(await repo.getSessionSets('session-1')).toHaveLength(1);
    expect((await repo.getBodyweightReadings())[0]!.lb).toBe(180);
    expect((await repo.getSettings()).goalPrimary).toBe('Hypertrophy');
  });

  it('merge is last-write-wins and safe to run twice', async () => {
    const logged = await repo.logSet(setInput({ reps: 10 }));
    const backup = await exportBackup();

    // Live data moves on after the backup was taken.
    await repo.updateSet(logged.id, { reps: 12 });

    const first = await importBackup(backup, 'merge');
    expect(first.skipped).toBeGreaterThan(0);
    expect((await repo.getSessionSets('session-1'))[0]!.reps).toBe(12);

    // Idempotent.
    const second = await importBackup(backup, 'merge');
    expect(second.updated).toBe(0);
    expect((await repo.getSessionSets('session-1'))[0]!.reps).toBe(12);
  });

  it('merge applies deletions rather than resurrecting rows', async () => {
    const logged = await repo.logSet(setInput());
    await repo.deleteSet(logged.id);
    const backupWithTombstone = await exportBackup();

    globalThis.indexedDB = new IDBFactory();
    resetConnection();
    await importBackup(backupWithTombstone, 'merge');

    expect(await repo.getSessionSets('session-1')).toHaveLength(0);
  });

  it('rejects a file that is not one of ours', async () => {
    await expect(importBackup('{"some":"other app"}')).rejects.toThrow(/not a Total Gym Logbook/);
  });

  it('refuses a backup from a newer app version instead of mangling it', async () => {
    const future = { format: 99, app: 'totalgymlogbook', exportedAt: '', dbVersion: 9, records: {} };
    await expect(importBackup(future as never)).rejects.toThrow(/newer than this app/);
  });

  it('exports valid JSON', async () => {
    await repo.logSet(setInput());
    const { exportBackupJson } = await import('../src/db/backup.js');

    const parsed = JSON.parse(await exportBackupJson());
    expect(parsed.app).toBe('totalgymlogbook');
    expect(parsed.records[Store.SetLogs]).toHaveLength(1);
  });
});
