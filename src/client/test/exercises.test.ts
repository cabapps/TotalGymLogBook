/**
 * The exercise catalogue is data, so these tests mostly guard its integrity: the fields the
 * resistance calculation and the volume ledger depend on must be present and sane for every
 * entry, or a single bad row produces silently wrong loads.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';

const DATA = join(import.meta.dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(DATA, 'exercises.json'), 'utf8'));

describe('exercise catalogue', () => {
  it('loads every exercise', () => {
    expect(catalog.all.length).toBeGreaterThan(10);
  });

  it('has unique ids', () => {
    const ids = catalog.all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every exercise the fields the load calculation needs', () => {
    for (const e of catalog.all) {
      expect(typeof e.usesPulley, e.id).toBe('boolean');
      expect(e.bodyFraction, e.id).toBeGreaterThan(0);
      expect(e.bodyFraction, e.id).toBeLessThanOrEqual(1);
      expect(e.name.length, e.id).toBeGreaterThan(0);
      expect(e.cue.length, e.id).toBeGreaterThan(0);
    }
  });

  it('gives every exercise at least one prime mover', () => {
    // Without a 1.0 involvement the volume ledger would credit no muscle group fully, and the
    // exercise would be invisible to "you haven't trained X" nudges.
    for (const e of catalog.all) {
      expect(e.muscles.some((m) => m.fraction === 1.0), e.id).toBe(true);
    }
  });

  it('uses only the direct and indirect involvement fractions', () => {
    for (const e of catalog.all) {
      for (const m of e.muscles) {
        expect([0.5, 1.0], `${e.id}/${m.muscle}`).toContain(m.fraction);
      }
    }
  });

  it('names muscle groups the domain recognises', () => {
    // Must match TotalGymLogBook.Domain.Training.MuscleGroup.
    const known = new Set([
      'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
      'Quadriceps', 'Hamstrings', 'Glutes', 'Calves', 'Core',
    ]);

    for (const e of catalog.all) {
      for (const m of e.muscles) {
        expect(known, `${e.id} references unknown muscle '${m.muscle}'`).toContain(m.muscle);
      }
    }
  });

  it('covers every muscle group with at least one exercise', () => {
    const covered = new Set(catalog.all.flatMap((e) => e.muscles.map((m) => m.muscle)));
    for (const muscle of ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
                          'Quadriceps', 'Glutes', 'Calves', 'Core']) {
      expect(covered, `nothing trains ${muscle}`).toContain(muscle);
    }
  });

  it('filters to what the trainee actually owns', () => {
    const bare = catalog.available([]);
    const withStand = catalog.available(['Squat stand']);

    expect(bare.every((e) => e.attachment === null)).toBe(true);
    expect(withStand.length).toBeGreaterThan(bare.length);
    expect(withStand.some((e) => e.id === 'squat')).toBe(true);
    expect(bare.some((e) => e.id === 'squat')).toBe(false);
  });

  it('lists its attachments for the equipment picker', () => {
    expect(catalog.attachments).toContain('Squat stand');
    expect(catalog.attachments.every((a) => a.length > 0)).toBe(true);
  });

  it('marks cable movements as using the pulley', () => {
    // These halve the load (docs/adr/0004), so getting the flag wrong doubles the recorded
    // resistance for that exercise.
    expect(catalog.get('chest-press').usesPulley).toBe(true);
    expect(catalog.get('seated-row').usesPulley).toBe(true);
    // Pressing off the squat stand is direct: no cable involved.
    expect(catalog.get('squat').usesPulley).toBe(false);
    expect(catalog.get('calf-raise').usesPulley).toBe(false);
  });

  it('throws a useful error for an unknown id', () => {
    expect(() => catalog.get('nope')).toThrow(/No exercise/);
    expect(catalog.tryGet('nope')).toBeUndefined();
  });
});
