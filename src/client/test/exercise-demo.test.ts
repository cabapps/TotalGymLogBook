import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';
import { demoCaption, demoSvg } from '../src/demo.js';

const dataDir = join(__dirname, '..', '..', '..', 'data');
const catalog = ExerciseCatalog.parse(readFileSync(join(dataDir, 'exercises.json'), 'utf8'));

describe('exercise demo', () => {
  it('draws every movement in the catalog', () => {
    // Generated rather than authored, so "does every exercise have one" is a real question with
    // a cheap answer -- and a movement with no drawing would be the one the trainee needed.
    for (const exercise of catalog.all) {
      const svg = demoSvg(exercise);

      expect(svg, exercise.id).toContain('<svg');
      expect(svg, exercise.id).toContain('viewBox');
      expect(demoCaption(exercise).length, exercise.id).toBeGreaterThan(20);
    }
  });

  it('moves the board further for a squat than for a calf raise', () => {
    // The thing a sentence cannot convey and a drawing can: how far the board actually travels.
    const travel = (id: string) =>
      Math.abs(Number(/--travel: translate\((-?[\d.]+)px/.exec(demoSvg(catalog.get(id)))![1]));

    expect(travel('squat')).toBeGreaterThan(travel('calf-raise'));
    expect(travel('calf-raise')).toBeGreaterThan(0);
  });

  it('puts the head at the end the setup says it is at', () => {
    // The demo and the written instructions come off the same field, so they cannot disagree --
    // but only if the drawing actually reads it. This is what checks that it does.
    const headX = (id: string) =>
      Number(/<circle class="head" cx="(-?[\d.]+)"/.exec(demoSvg(catalog.get(id)))![1]);

    // Negative x is up the rail toward the tower, in the board's own frame.
    expect(headX('squat')).toBeLessThan(0);
    expect(catalog.get('squat').setup.facing).toBe('tower');

    expect(headX('crunch')).toBeGreaterThan(0);
    expect(catalog.get('crunch').setup.facing).toBe('floor');
  });

  it('draws the squat stand at the bottom of the rail', () => {
    // Where it actually bolts on. Drawing it at the tower end would teach the exact thing the
    // catalog had wrong for a fortnight.
    const svg = demoSvg(catalog.get('squat'));
    const stand = /<line class="accessory" x1="([\d.]+)"/.exec(svg);

    expect(stand).not.toBeNull();
    expect(Number(stand![1])).toBeGreaterThan(100);
  });

  it('draws a cable only for cable movements', () => {
    expect(demoSvg(catalog.get('chest-press'))).toContain('class="cable"');
    expect(demoSvg(catalog.get('squat'))).not.toContain('class="cable"');
  });

  it('says what it is not', () => {
    // A stick figure shows which way to face and what moves. A trainee who takes it for a form
    // guide can hurt themselves being faithful to it.
    expect(demoSvg(catalog.get('squat'))).toContain('aria-label');
  });
});
