import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { ExerciseCatalog } from '../src/exercises.js';
import {
  ProgramLibrary,
  nextExercise,
  nextSession,
  sessionPosition,
  sessionProgress,
} from '../src/programs.js';
import type { ProgramRecord, SessionRecord } from '../src/db/schema.js';
import * as repo from '../src/db/repository.js';
import { openDatabase, resetConnection } from '../src/db/database.js';
import { resetEvents } from '../src/db/events.js';

const dataDir = join(__dirname, '..', '..', '..', 'data');
const library = ProgramLibrary.parse(readFileSync(join(dataDir, 'programs.json'), 'utf8'));
const catalog = ExerciseCatalog.parse(readFileSync(join(dataDir, 'exercises.json'), 'utf8'));

function program(sessionIds: string[]): ProgramRecord {
  return {
    id: 'p1',
    updatedAt: 0,
    name: 'Test',
    description: '',
    isActive: true,
    sessions: sessionIds.map((id) => ({ id, name: id, exercises: [] })),
  };
}

function logged(programSessionId: string, startedAt: number): SessionRecord {
  return {
    id: `s-${programSessionId}-${startedAt}`,
    updatedAt: 0,
    startedAt,
    status: 'complete',
    machineId: 'm1',
    programId: 'p1',
    programSessionId,
  };
}

describe('ProgramLibrary', () => {
  it('ships a program for every way of training the app asks about', () => {
    // One per emphasis, because the onboarding question offers five answers and an answer with
    // no program behind it is a question the app had no business asking.
    const emphases = new Set(library.templates.map((t) => t.emphasis));

    expect(emphases).toEqual(
      new Set(['lengthened', 'largest-muscles', 'heavy-compounds', 'circuit', 'gentle']),
    );
    expect(library.templates.map((t) => t.id)).toContain('full-body');
  });

  it('offers the templates built for what the trainee is training for first', () => {
    // Ordered, never filtered: someone training for strength who wants a hypertrophy split is
    // allowed to have one, and hiding it would be the app overruling their decision.
    const forFatLoss = library.forEmphasis('largest-muscles');

    expect(forFatLoss[0]!.emphasis).toBe('largest-muscles');
    expect(forFatLoss).toHaveLength(library.templates.length);
  });

  it('only plans exercises that exist', () => {
    // A typo here would leave a session with a movement the picker cannot offer, and the
    // trainee staring at a plan item they cannot log.
    for (const template of library.templates) {
      for (const session of template.sessions) {
        for (const planned of session.exercises) {
          expect(catalog.tryGet(planned.exerciseId), `${template.id}/${planned.exerciseId}`)
            .toBeDefined();
        }
      }
    }
  });

  it('never plans a stretch as a working set', () => {
    for (const template of library.templates) {
      for (const session of template.sessions) {
        for (const planned of session.exercises) {
          expect(catalog.get(planned.exerciseId).kind).toBe('strength');
        }
      }
    }
  });

  it('gives every session a positive set count', () => {
    for (const template of library.templates) {
      for (const session of template.sessions) {
        expect(session.exercises.length).toBeGreaterThan(0);
        expect(session.exercises.every((e) => e.sets > 0)).toBe(true);
      }
    }
  });

  it('uses ids unique within a program', () => {
    for (const template of library.templates) {
      const ids = template.sessions.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('nextSession', () => {
  it('starts at the beginning when nothing has been logged', () => {
    expect(nextSession(program(['a', 'b', 'c']), [])?.id).toBe('a');
  });

  it('advances one place', () => {
    expect(nextSession(program(['a', 'b', 'c']), [logged('a', 100)])?.id).toBe('b');
  });

  it('wraps at the end of the rotation', () => {
    expect(nextSession(program(['a', 'b', 'c']), [logged('c', 100)])?.id).toBe('a');
  });

  it('follows the most recent session, not the first in the list', () => {
    // Sessions arrive newest-first.
    const history = [logged('b', 300), logged('a', 200)];
    expect(nextSession(program(['a', 'b', 'c']), history)?.id).toBe('c');
  });

  it('ignores workouts logged outside the program', () => {
    const freestyle: SessionRecord = {
      id: 'free', updatedAt: 0, startedAt: 500, status: 'complete', machineId: 'm1',
    };
    const history = [freestyle, logged('a', 200)];
    expect(nextSession(program(['a', 'b', 'c']), history)?.id).toBe('b');
  });

  it('recovers when the last session was edited out of the program', () => {
    // Rather than getting stuck pointing at a session that no longer exists.
    expect(nextSession(program(['a', 'b']), [logged('gone', 100)])?.id).toBe('a');
  });

  it('stays on the session being worked right now', () => {
    // The rotation advances when a workout is DONE, not when it starts. Advancing on the first
    // logged set made the tick list jump to tomorrow's session mid-workout.
    const active: SessionRecord = {
      id: 'now', updatedAt: 0, startedAt: 900, status: 'active',
      machineId: 'm1', programId: 'p1', programSessionId: 'b',
    };

    expect(nextSession(program(['a', 'b', 'c']), [active, logged('a', 200)])?.id).toBe('b');
  });

  it('advances once that workout is finished', () => {
    expect(nextSession(program(['a', 'b', 'c']), [logged('b', 900)])?.id).toBe('c');
  });

  it('has nothing to suggest for an empty program', () => {
    expect(nextSession(program([]), [])).toBeUndefined();
  });
});

describe('sessionProgress', () => {
  const planned = {
    id: 'push',
    name: 'Push',
    exercises: [
      { exerciseId: 'chest-press', sets: 3 },
      { exerciseId: 'shoulder-press', sets: 2 },
    ],
  };

  it('counts what has been logged today', () => {
    const progress = sessionProgress(planned, [
      { exerciseId: 'chest-press' },
      { exerciseId: 'chest-press' },
    ]);

    expect(progress[0]).toMatchObject({ logged: 2, done: false });
    expect(progress[1]).toMatchObject({ logged: 0, done: false });
  });

  it('marks a movement done once the planned sets are in', () => {
    const progress = sessionProgress(planned, [
      { exerciseId: 'chest-press' },
      { exerciseId: 'chest-press' },
      { exerciseId: 'chest-press' },
    ]);

    expect(progress[0]).toMatchObject({ done: true });
  });

  it('counts extra sets without complaining', () => {
    // Doing four when the plan said three is not an error.
    const sets = Array.from({ length: 4 }, () => ({ exerciseId: 'chest-press' }));
    expect(sessionProgress(planned, sets)[0]).toMatchObject({ logged: 4, done: true });
  });

  it('ignores movements that are not in the plan', () => {
    const progress = sessionProgress(planned, [{ exerciseId: 'biceps-curl' }]);
    expect(progress.every((p) => p.logged === 0)).toBe(true);
  });

  it('points at the first movement still owing sets', () => {
    const progress = sessionProgress(planned, [
      { exerciseId: 'chest-press' },
      { exerciseId: 'chest-press' },
      { exerciseId: 'chest-press' },
    ]);

    expect(nextExercise(progress)?.exerciseId).toBe('shoulder-press');
  });

  it('has nothing left once every movement is done', () => {
    const sets = [
      ...Array.from({ length: 3 }, () => ({ exerciseId: 'chest-press' })),
      ...Array.from({ length: 2 }, () => ({ exerciseId: 'shoulder-press' })),
    ];

    expect(nextExercise(sessionProgress(planned, sets))).toBeUndefined();
  });
});

describe('sessionPosition', () => {
  it('is one-based for display', () => {
    expect(sessionPosition(program(['a', 'b', 'c']), 'b')).toBe(2);
  });
});

describe('program storage', () => {
  beforeEach(() => {
    // Fresh database per test. fake-indexeddb's IDBFactory has no persistence between instances.
    globalThis.indexedDB = new IDBFactory();
    resetConnection();
    resetEvents();
  });

  it('round-trips a program', async () => {
    const template = library.get('push-pull-legs');
    const saved = await repo.saveProgram({
      name: template.name,
      description: template.description,
      templateId: template.id,
      sessions: template.sessions.map((s) => ({ ...s, exercises: [...s.exercises] })),
      isActive: true,
    });

    const loaded = await repo.getActiveProgram();
    expect(loaded?.id).toBe(saved.id);
    expect(loaded?.sessions).toHaveLength(3);
  });

  it('keeps exactly one program active', async () => {
    // Two active programs would make "which session is next" ambiguous, and the ambiguity
    // would only ever surface as the app confidently naming the wrong day.
    const base = { description: '', sessions: [], isActive: true };
    const first = await repo.saveProgram({ ...base, name: 'A' });
    const second = await repo.saveProgram({ ...base, name: 'B' });

    const programs = await repo.listPrograms();
    expect(programs.filter((p) => p.isActive).map((p) => p.id)).toEqual([second.id]);
    expect(programs.find((p) => p.id === first.id)?.isActive).toBe(false);
  });

  it('can switch the active program', async () => {
    const base = { description: '', sessions: [], isActive: false };
    const a = await repo.saveProgram({ ...base, name: 'A' });
    await repo.saveProgram({ ...base, name: 'B' });

    await repo.setActiveProgram(a.id);
    expect((await repo.getActiveProgram())?.id).toBe(a.id);

    await repo.setActiveProgram(undefined);
    expect(await repo.getActiveProgram()).toBeUndefined();
  });

  it('soft-deletes so a sync peer sees the removal', async () => {
    const saved = await repo.saveProgram({
      name: 'A', description: '', sessions: [], isActive: true,
    });

    expect(await repo.deleteProgram(saved.id)).toBe(true);
    expect(await repo.listPrograms()).toHaveLength(0);
    expect(await repo.getActiveProgram()).toBeUndefined();
    expect(await repo.deleteProgram(saved.id)).toBe(false);
  });
});

describe('custom exercises', () => {
  beforeEach(() => {
    // Fresh database per test. fake-indexeddb's IDBFactory has no persistence between instances.
    globalThis.indexedDB = new IDBFactory();
    resetConnection();
    resetEvents();
  });

  const curl = {
    name: 'Cable Woodchop High',
    category: 'Core',
    kind: 'strength' as const,
    usesPulley: true,
    peakTension: 'even' as const,
    setup: { position: 'seated', facing: 'tower', grip: 'handles' },
    bodyFraction: 0.85,
    attachment: null,
    cue: 'Pull across your body.',
    muscles: [{ muscle: 'Core', fraction: 1.0 }],
  };

  it('round-trips a user-added exercise', async () => {
    const saved = await repo.saveCustomExercise(curl);
    const all = await repo.listCustomExercises();

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: saved.id, name: curl.name, usesPulley: true });
  });

  it('merges into the catalog', async () => {
    const saved = await repo.saveCustomExercise(curl);
    const merged = catalog.withCustom([{ ...curl, id: saved.id }]);

    expect(merged.all).toHaveLength(catalog.all.length + 1);
    expect(merged.get(saved.id).name).toBe(curl.name);
  });

  it('lets a custom entry override a built-in of the same id', async () => {
    // Which is how editing a shipped exercise works: same id, the trainee's values win.
    const merged = catalog.withCustom([
      { ...curl, id: 'chest-press', name: 'My Chest Press', usesPulley: false },
    ]);

    expect(merged.all).toHaveLength(catalog.all.length);
    expect(merged.get('chest-press').name).toBe('My Chest Press');
    expect(merged.get('chest-press').usesPulley).toBe(false);
  });

  it('soft-deletes, leaving logged sets readable', async () => {
    const saved = await repo.saveCustomExercise(curl);

    expect(await repo.deleteCustomExercise(saved.id)).toBe(true);
    expect(await repo.listCustomExercises()).toHaveLength(0);

    // The set history keeps the id; the catalog falls back to a de-slugged name.
    expect(catalog.tryGet(saved.id)).toBeUndefined();
  });
});

/**
 * The v1 -> v2 upgrade, on a database that already has data in it.
 *
 * Every other test opens at the current version, where migration 1 and migration 2 run
 * back-to-back on an empty database -- which is the one path no shipped install will ever take.
 * Real users are on v1 with months of sets in it, and a migration that drops those is not a bug
 * you can fix afterwards.
 */
describe('v1 to v2 upgrade', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetConnection();
    resetEvents();
  });

  it('adds the new stores without touching what is already there', async () => {
    // A v1 database with a logged set in it.
    const v1 = await openDatabase('upgrade-test', 1);
    expect([...v1.objectStoreNames]).not.toContain('programs');

    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction('setLogs', 'readwrite');
      tx.objectStore('setLogs').put({ id: 'set-1', exerciseId: 'chest-press', reps: 10 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v1.close();

    const v2 = await openDatabase('upgrade-test', 2);

    expect([...v2.objectStoreNames]).toContain('programs');
    expect([...v2.objectStoreNames]).toContain('customExercises');

    const survived = await new Promise((resolve, reject) => {
      const request = v2.transaction('setLogs', 'readonly').objectStore('setLogs').get('set-1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(survived).toMatchObject({ id: 'set-1', reps: 10 });
    v2.close();
  });

  it('creates both stores on a first-ever open', async () => {
    const fresh = await openDatabase('fresh-test', 2);

    expect([...fresh.objectStoreNames].sort()).toEqual([
      'bodyweight', 'customExercises', 'machines', 'programs', 'sessions', 'setLogs', 'settings',
    ]);
    fresh.close();
  });
});
