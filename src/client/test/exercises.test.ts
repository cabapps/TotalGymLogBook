/**
 * The exercise catalog is data, so these tests mostly guard its integrity: the fields the
 * resistance calculation and the volume ledger depend on must be present and sane for every
 * entry, or a single bad row produces silently wrong loads.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';

const DATA = join(import.meta.dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(DATA, 'exercises.json'), 'utf8'));

describe('exercise catalog', () => {
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

  it('names muscle groups the domain recognizes', () => {
    // Must match TotalGymLogBook.Domain.Training.MuscleGroup.
    const known = new Set([
      'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
      'Quadriceps', 'Hamstrings', 'Adductors', 'Glutes', 'Calves', 'Core',
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

  it('shows everything until the trainee says what they own', () => {
    // Undefined is UNCONFIGURED, not owns-nothing. Conflating them would hide squats from
    // someone who has been logging squats for months.
    expect(catalog.available()).toHaveLength(catalog.all.length);
    expect(catalog.available([]).length).toBeLessThan(catalog.all.length);
  });

  it('groups exercises for the picker', () => {
    const groups = catalog.grouped();

    expect(groups.size).toBeGreaterThan(3);
    expect([...groups.values()].flat()).toHaveLength(catalog.all.length);
    expect([...groups.keys()].every((c) => c.length > 0)).toBe(true);
  });

  it('groups only what the trainee owns', () => {
    const groups = catalog.grouped([]);
    expect([...groups.values()].flat().every((e) => e.attachment === null)).toBe(true);
  });

  it('marks stretches so they cannot count as training volume', () => {
    // A stretch is not a hard set. Counting them would tell a trainee their hamstrings are
    // covered because they stretched them (docs/adr/0010).
    const stretches = catalog.all.filter((e) => e.kind === 'stretch');

    expect(stretches.length).toBeGreaterThan(0);
    expect(catalog.all.every((e) => e.kind === 'strength' || e.kind === 'stretch')).toBe(true);
    expect(stretches.every((e) => /stretch|twist/i.test(e.name))).toBe(true);
  });

  describe('setup', () => {
    it('says how every movement is set up', () => {
      for (const exercise of catalog.all) {
        expect(exercise.setup.position.length, exercise.id).toBeGreaterThan(0);
        expect(['tower', 'floor'], exercise.id).toContain(exercise.setup.facing);
      }
    });

    it('never puts the trainee off the board', () => {
      // There is no standing exercise on this machine -- even the dips use the board. A position
      // the machine does not have would have the session ordering budgeting for a changeover
      // that never happens.
      expect(catalog.all.every((e) => e.setup.position !== 'standing')).toBe(true);
    });

    it('has no cue that contradicts the position it is set up in', () => {
      // The setup line and the cue are rendered together. A cue that says "lie face up" under a
      // setup line that says "sit facing away from the tower" leaves the trainee to guess which
      // half of their own app is wrong.
      const positional = /\b(lie|lying|sit|sitting|seated|kneel|kneeling|face up|face down)\b/i;

      for (const exercise of catalog.all) {
        const said = positional.exec(exercise.cue)?.[0]?.toLowerCase();
        if (!said) continue;

        const position = exercise.setup.position;
        const agrees =
          ((said.startsWith('l') || said === 'face up') &&
            (position === 'face-up' || position === 'side-lying')) ||
          (said === 'face down' && position === 'face-down') ||
          (said.startsWith('s') && position === 'seated') ||
          (said.startsWith('k') && position === 'kneeling');

        expect(agrees, `${exercise.id} is ${position} but its cue says "${said}"`).toBe(true);
      }
    });
  });

  it('gives every exercise a category', () => {
    expect(catalog.all.every((e) => e.category.length > 0)).toBe(true);
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

  describe('accessories', () => {
    it('lets either wing attachment unlock the wing exercises', () => {
      // The whole reason an exercise names a capability instead of a product. Total Gym shipped
      // the wing in one-piece and two-piece versions that do exactly the same job; a model
      // where the exercise named the product hides pull-ups from half the owners in the world.
      const onePiece = catalog.available(['wing-one-piece']);
      const twoPiece = catalog.available(['wing-two-piece']);

      expect(onePiece.some((e) => e.id === 'pull-up')).toBe(true);
      expect(twoPiece.some((e) => e.id === 'pull-up')).toBe(true);
      expect(onePiece.map((e) => e.id)).toEqual(twoPiece.map((e) => e.id));
    });

    it('unlocks nothing extra for an accessory the trainee does not own', () => {
      const owned = catalog.available(['triceps-rope']);

      expect(owned.some((e) => e.id === 'rope-pushdown')).toBe(true);
      expect(owned.some((e) => e.id === 'chest-dip')).toBe(false);
      expect(owned.some((e) => e.id === 'squat')).toBe(false);
    });

    it('still understands answers stored before accessories had ids', () => {
      // The panel used to store the requirement label itself. Those strings are still
      // capability names, and they must keep working -- anyone who configured their equipment
      // before this release would otherwise open the app to an empty picker.
      const legacy = catalog.available(['Squat stand', 'Ankle straps']);

      expect(legacy.some((e) => e.id === 'squat')).toBe(true);
      expect(legacy.some((e) => e.id === 'hamstring-curl')).toBe(true);
      expect(legacy.some((e) => e.id === 'pull-up')).toBe(false);
    });

    it('every capability an exercise asks for can actually be bought', () => {
      // An exercise requiring something no accessory provides is unreachable for everyone, and
      // invisible in a way no trainee can diagnose or fix.
      const provided = new Set(catalog.accessories.flatMap((a) => a.provides));

      for (const exercise of catalog.all) {
        if (exercise.attachment !== null) expect(provided).toContain(exercise.attachment);
      }
    });

    it('knows which accessories ship with most machines', () => {
      const common = catalog.accessories.filter((a) => a.common).map((a) => a.id);

      expect(common).toContain('squat-stand');
      expect(common).toContain('wing-one-piece');
      expect(common).toContain('wing-two-piece');
      expect(common).not.toContain('pilates-kit');
    });
  });

  describe('resolveOwned', () => {
    it('treats accessories added since the trainee answered as unanswered, not as no', () => {
      // SILENCE IS NOT A NO. Someone who ticked their equipment against version 1 was never
      // shown the wing, so reading their answer as "no wing" would delete pull-ups from an app
      // they have been logging pull-ups in.
      const resolved = catalog.resolveOwned(['squat-stand'], 1)!;

      expect(resolved).toContain('squat-stand');
      expect(resolved).toContain('wing-two-piece');
      expect(catalog.available(resolved).some((e) => e.id === 'pull-up')).toBe(true);
    });

    it('keeps the exclusions in an answer that predates the version stamp', () => {
      // An answer with no version came from the panel that stored capability labels, and that
      // panel offered exactly the version-1 accessories. So "Squat stand and nothing else" was
      // a real answer about the press-up bars, and re-ticking them would overrule the trainee.
      const resolved = catalog.resolveOwned(['Squat stand'])!;
      const shown = catalog.available(resolved);

      expect(shown.some((e) => e.id === 'squat')).toBe(true);
      expect(shown.some((e) => e.id === 'pull-up')).toBe(true);
      expect(shown.some((e) => e.id === 'decline-push-up')).toBe(false);
      expect(shown.some((e) => e.id === 'hamstring-curl')).toBe(false);
    });

    it('leaves a current answer exactly as given', () => {
      const resolved = catalog.resolveOwned(['squat-stand'], catalog.accessoryVersion);

      expect(resolved).toEqual(['squat-stand']);
      expect(catalog.available(resolved).some((e) => e.id === 'pull-up')).toBe(false);
    });

    it('keeps never-configured meaning show everything', () => {
      // A different state from "answered an older question", and it has to stay one: it is the
      // reason a trainee who has never opened the panel sees the whole catalog.
      expect(catalog.resolveOwned(undefined, 0)).toBeUndefined();
      expect(catalog.available(catalog.resolveOwned(undefined, 0))).toHaveLength(
        catalog.all.length,
      );
    });

    it('does not resurrect an accessory the trainee has explicitly declined', () => {
      const resolved = catalog.resolveOwned([], catalog.accessoryVersion)!;

      expect(resolved).toHaveLength(0);
      expect(catalog.available(resolved).every((e) => e.attachment === null)).toBe(true);
    });
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
