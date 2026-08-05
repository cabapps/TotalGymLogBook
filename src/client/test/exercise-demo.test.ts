import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExerciseCatalog } from '../src/exercises.js';
import { demoCaption, demoSvg, figureFor } from '../src/demo.js';

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

  it('never lets a limb leave the body', () => {
    // The bug this replaced: the limb group sat inside the board's animated group, so it
    // inherited the board's travel AND added its own -- arms slid off the figure and a squatting
    // stick man's leg walked away on its own. A rotation about the joint cannot detach, whatever
    // the angle, so what this checks is that no limb is translated.
    for (const exercise of catalog.all) {
      const svg = demoSvg(exercise);
      const limbs = [...svg.matchAll(/<g class="limb">(.*?)<\/g>/gs)];

      for (const [, body] of limbs) {
        // Every moving segment starts at its own origin, which its parent has put on the joint.
        expect(body, exercise.id).toContain('x1="0" y1="0"');
      }
    }
  });

  it('swings the working joint, and not for a hold', () => {
    const swing = (id: string) => /--swing: (-?\d+)deg/.exec(demoSvg(catalog.get(id)))![1];

    expect(Number(swing('biceps-curl'))).not.toBe(0);
    expect(Number(swing('squat'))).not.toBe(0);
    // A plank has nothing to swing, and a limb waving through one would be teaching the opposite
    // of what it is for.
    expect(Number(swing('plank-hold'))).toBe(0);
  });

  it('travels up the rail, always', () => {
    // The machine's whole principle: resistance is the board's weight on the incline, so the
    // working phase always drags it UP toward the tower -- pressing, pulling or squatting. A demo
    // that ran a movement downhill would be showing the trainee the easy half of the rep.
    for (const exercise of catalog.all) {
      const [, dx, dy] = /--travel: translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        demoSvg(exercise),
      )!;

      expect(Number(dx), exercise.id).toBeLessThanOrEqual(0);
      expect(Number(dy), exercise.id).toBeLessThanOrEqual(0);
    }
  });

  it('says what it is not', () => {
    // A stick figure shows which way to face and what moves. A trainee who takes it for a form
    // guide can hurt themselves being faithful to it.
    expect(demoSvg(catalog.get('squat'))).toContain('aria-label');
  });
});

describe('joints', () => {
  it('gives every limb a knee or an elbow', () => {
    // Two segments per limb, and the far one hangs off a translate to the midpoint -- that is
    // what makes the joint a joint rather than a kink drawn into a single line.
    const svg = demoSvg(catalog.get('chest-press'));

    expect(svg).toContain('class="joint"');
    expect(svg).toContain('--bend-from');
  });

  it('bends the elbow the opposite way for a curl and a press', () => {
    // The whole point of drawing joints: these two trace nearly the same arc, and what the elbow
    // does is the only thing that distinguishes them.
    const bend = (id: string) => {
      const match = /--bend-from: (-?\d+)deg; --bend-to: (-?\d+)deg/.exec(demoSvg(catalog.get(id)))!;
      return { from: Number(match[1]), to: Number(match[2]) };
    };

    const press = bend('chest-press');
    const curl = bend('biceps-curl');

    expect(press.to).toBeLessThan(press.from);
    expect(curl.to).toBeGreaterThan(curl.from);
  });

  it('keeps the knee still on a calf raise', () => {
    // The caption says a moving knee means the knees are helping. The drawing must not contradict
    // it by showing exactly that.
    const match = /--bend-from: (-?\d+)deg; --bend-to: (-?\d+)deg/.exec(
      demoSvg(catalog.get('calf-raise')),
    )!;

    expect(Number(match[1])).toBe(Number(match[2]));
  });
});

/**
 * The geometry, measured rather than eyeballed.
 *
 * Every mistake this drawing has made has been in the figure's coordinates, and every one of them
 * survived review because a stick figure looks plausible from any angle unless you check it
 * against something. These check it against the setup the movement already declares -- the same
 * field the written instructions and the session ordering read, so the drawing cannot disagree
 * with the sentence beside it.
 */
describe('figure geometry', () => {
  const seated = catalog.all.filter(
    (e) => e.setup.position === 'seated' || e.setup.position === 'kneeling',
  );
  const lying = catalog.all.filter(
    (e) => e.setup.position !== 'seated' && e.setup.position !== 'kneeling',
  );

  it('has movements in both postures to check', () => {
    expect(seated.length).toBeGreaterThan(5);
    expect(lying.length).toBeGreaterThan(5);
  });

  it('sits everyone with their legs in front of them', () => {
    // The bug that shipped three times. A chest press is done sitting with your back to the
    // tower, so the legs run DOWN the board -- and the drawing had them up the rail, under a
    // figure facing the wrong way entirely.
    for (const exercise of seated) {
      const f = figureFor(exercise);
      expect(Math.sign(f.foot[0] - f.hip[0]), exercise.id).toBe(f.facing);
    }
  });

  it('puts a seated trainee\'s hands in front of them too', () => {
    for (const exercise of seated) {
      const f = figureFor(exercise);
      expect(Math.sign(f.hand[0] - f.shoulder[0]), exercise.id).toBe(f.facing);
    }
  });

  it('faces a seated trainee the way the setup says', () => {
    const facing = (id: string) => figureFor(catalog.get(id)).facing;

    // Chest press: back to the tower, so facing down the rail, which is positive x.
    expect(facing('chest-press')).toBe(1);
    // Seated row: facing the tower, which is where the cable is.
    expect(facing('seated-row')).toBe(-1);
  });

  it('lays everyone down head-first toward the end the setup names', () => {
    for (const exercise of lying) {
      const f = figureFor(exercise);
      expect(Math.sign(f.head[0]), exercise.id).toBe(f.facing);
      // ...and the feet at the other end, which is what makes it a body rather than a heap.
      expect(Math.sign(f.foot[0]), exercise.id).toBe(-f.facing);
    }
  });

  it('keeps the head above the hips in every posture', () => {
    // y is height above the board, so "above" is more negative.
    for (const exercise of catalog.all) {
      const f = figureFor(exercise);
      expect(f.head[1], exercise.id).toBeLessThan(f.hip[1]);
    }
  });

  it('gives everyone shoulders between the neck and the arm', () => {
    for (const exercise of catalog.all) {
      const f = figureFor(exercise);
      const spine = Math.hypot(f.neck[0] - f.hip[0], f.neck[1] - f.hip[1]);
      const girdle = Math.hypot(f.shoulder[0] - f.neck[0], f.shoulder[1] - f.neck[1]);

      // A real segment, and a short one -- shoulders, not a second spine.
      expect(girdle, exercise.id).toBeGreaterThan(1);
      expect(girdle, exercise.id).toBeLessThan(spine / 2);
    }
  });

  it('draws one spine, not two', () => {
    // A crunch used to get a second torso line drawn from the hip so it could be animated. The
    // upper body pivots at the hip as one piece now.
    const spines = (demoSvg(catalog.get('crunch')).match(/class="figure"/g) ?? []).length;
    const press = (demoSvg(catalog.get('chest-press')).match(/class="figure"/g) ?? []).length;

    expect(spines).toBe(press);
  });
});
