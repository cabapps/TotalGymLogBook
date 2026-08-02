import { describe, expect, it, vi } from 'vitest';

import {
  MAX_REPS,
  MAX_SPOKEN_JUMP,
  MIN_REP_MS,
  RepCounter,
  type RepEvent,
} from '../src/reps/counter.js';
import { RepDetector } from '../src/reps/motion.js';
import { highestSpokenNumber, parseSpokenNumbers } from '../src/reps/numerals.js';

const increment = (at: number): RepEvent => ({
  kind: 'increment',
  sourceId: 'motion',
  at,
  confidence: 1,
});

const spoken = (count: number, at = 0): RepEvent => ({
  kind: 'count',
  sourceId: 'voice',
  at,
  count,
  confidence: 1,
});

describe('RepCounter — increments', () => {
  it('counts one rep per event', () => {
    const counter = new RepCounter();
    counter.accept(increment(0));
    counter.accept(increment(2000));
    counter.accept(increment(4000));
    expect(counter.count).toBe(3);
  });

  it('rejects reps faster than a Total Gym rep can be', () => {
    const counter = new RepCounter();
    counter.accept(increment(0));
    counter.accept(increment(MIN_REP_MS - 1));
    expect(counter.count).toBe(1);
  });

  it('coalesces two sources reporting the same rep', () => {
    const counter = new RepCounter();
    counter.accept({ kind: 'increment', sourceId: 'motion', at: 1000, confidence: 1 });
    counter.accept({ kind: 'increment', sourceId: 'stats', at: 1120, confidence: 1 });
    expect(counter.count).toBe(1);
  });

  it('notifies on change', () => {
    const onChange = vi.fn();
    const counter = new RepCounter(onChange);
    counter.accept(increment(0));
    counter.accept(increment(10)); // rejected, so no second call
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1);
  });
});

describe('RepCounter — spoken counts', () => {
  it('takes the number spoken', () => {
    const counter = new RepCounter();
    counter.accept(spoken(1));
    counter.accept(spoken(2));
    counter.accept(spoken(3));
    expect(counter.count).toBe(3);
  });

  it('self-heals over dropped words', () => {
    // "one, two, three, four, five" with the middle three misheard as nothing. The count still
    // lands correctly, which is the entire reason voice reports totals rather than events.
    const counter = new RepCounter();
    counter.accept(spoken(1));
    counter.accept(spoken(4));
    expect(counter.count).toBe(4);
  });

  it('never goes backwards', () => {
    // Counted up to five legitimately -- a cold counter cannot jump straight to five, which
    // the "will not start mid-air" case below pins down separately.
    const counter = new RepCounter();
    for (const n of [1, 2, 3, 4, 5]) counter.accept(spoken(n));
    expect(counter.count).toBe(5);

    counter.accept(spoken(2));
    expect(counter.count).toBe(5);
  });

  it('rejects a wild jump, which is what a misheard number looks like', () => {
    // "four" heard as "forty" is the classic. Bounded, so it does nothing.
    const counter = new RepCounter();
    counter.accept(spoken(3));
    counter.accept(spoken(40));
    expect(counter.count).toBe(3);
  });

  it('accepts a jump right up to the limit', () => {
    const counter = new RepCounter();
    counter.accept(spoken(MAX_SPOKEN_JUMP));
    expect(counter.count).toBe(MAX_SPOKEN_JUMP);
  });

  it('will not start mid-air', () => {
    // Counting starts at one. A first utterance of "twelve" is a misrecognition, not a rep.
    const counter = new RepCounter();
    counter.accept(spoken(12));
    expect(counter.count).toBe(0);
  });

  it('follows a manual correction', () => {
    // Rule 3: manual stays live. Tap to 5, say six, get six.
    const counter = new RepCounter();
    counter.setCount(5);
    counter.accept(spoken(6));
    expect(counter.count).toBe(6);
  });

  it('caps at a plausible number of reps', () => {
    const counter = new RepCounter();
    counter.setCount(MAX_REPS);
    counter.accept(spoken(MAX_REPS + 1));
    expect(counter.count).toBe(MAX_REPS);
  });

  it('counts rejections so a noisy source is visible', () => {
    const counter = new RepCounter();
    counter.accept(spoken(1));
    counter.accept(spoken(90));
    counter.accept(spoken(91));
    expect(counter.stats).toEqual({ accepted: 1, rejected: 2 });
  });
});

describe('parseSpokenNumbers', () => {
  it('reads digits', () => {
    expect(parseSpokenNumbers('1 2 3')).toEqual([1, 2, 3]);
  });

  it('reads words', () => {
    expect(parseSpokenNumbers('one two three')).toEqual([1, 2, 3]);
  });

  it('reads compounds', () => {
    expect(parseSpokenNumbers('twenty one')).toEqual([21]);
    expect(parseSpokenNumbers('twenty-one')).toEqual([21]);
  });

  it('reads a bare tens word', () => {
    expect(parseSpokenNumbers('thirty and then')).toEqual([30]);
  });

  it('survives what counting under load actually sounds like', () => {
    expect(highestSpokenNumber('won too free')).toBe(3);
    expect(highestSpokenNumber('for')).toBe(4);
    expect(highestSpokenNumber('ate')).toBe(8);
  });

  it('ignores speech with no numbers in it', () => {
    expect(highestSpokenNumber('come on, keep going')).toBeUndefined();
  });

  it('takes the highest, not the last, because interim results get revised', () => {
    expect(highestSpokenNumber('seven six')).toBe(7);
  });
});

/**
 * Synthetic accelerometer traces. A glideboard is near-perfect one-dimensional reciprocating
 * motion (docs/adr/0006), so a sinusoid along one axis on top of a constant gravity vector is a
 * fair model of a set -- and it means the detector is testable without a phone.
 */
function sweep(
  detector: RepDetector,
  options: { cycles: number; periodMs: number; amplitude: number; noise?: number; seed?: number },
): number {
  const { cycles, periodMs, amplitude, noise = 0 } = options;
  const hz = 60;
  const step = 1000 / hz;
  const samples = Math.round((cycles * periodMs) / step);

  // Deterministic pseudo-noise: a seeded LCG, so a failure is reproducible.
  let seed = options.seed ?? 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  let reps = 0;
  for (let i = 0; i < samples; i++) {
    const t = i * step;
    const motion = amplitude * Math.sin((2 * Math.PI * t) / periodMs);

    const sample = {
      x: 0 + noise * random(),
      y: 0 + noise * random(),
      // The rail is inclined, so travel shows up along the gravity axis.
      z: 9.81 + motion + noise * random(),
    };

    if (detector.feed(sample, t)) reps++;
  }
  return reps;
}

describe('RepDetector', () => {
  it('counts a clean set at realistic cadence', () => {
    const reps = sweep(new RepDetector(), { cycles: 10, periodMs: 2500, amplitude: 2.5 });
    // The first cycle is spent settling the orientation estimate, so one short is expected and
    // fine -- the trainee sees the count catch up, and the stepper corrects it either way.
    expect(reps).toBeGreaterThanOrEqual(9);
    expect(reps).toBeLessThanOrEqual(10);
  });

  it('counts one rep per cycle, not two', () => {
    // The failure this guards: |acceleration| peaks on BOTH the push and the return, so a
    // detector without the re-arm gate reports double.
    const reps = sweep(new RepDetector(), { cycles: 8, periodMs: 2000, amplitude: 3 });
    expect(reps).toBeLessThanOrEqual(8);
  });

  it('does not count walking', () => {
    // The bug this exists for: a trainee logs a set, walks to the kitchen with the phone in a
    // pocket, and comes back to a counter that counted the walk. Footfalls land every 500-600 ms
    // and are not gentle -- amplitude is comparable to a real rep, so only the cadence separates
    // them.
    const reps = sweep(new RepDetector(), { cycles: 30, periodMs: 550, amplitude: 3, noise: 0.5 });

    expect(reps).toBeLessThanOrEqual(1);
  });

  it('still counts a deliberately slow set', () => {
    // The other side of the same gate: raising the refractory period must not start rejecting
    // real reps. Four seconds a rep is a slow tempo, not an implausible one.
    const reps = sweep(new RepDetector(), { cycles: 8, periodMs: 4000, amplitude: 2 });

    expect(reps).toBeGreaterThanOrEqual(7);
  });

  it('stays silent on a phone that is just sitting there', () => {
    const reps = sweep(new RepDetector(), {
      cycles: 20,
      periodMs: 2500,
      amplitude: 0,
      noise: 0.35,
    });
    expect(reps).toBe(0);
  });

  it('survives noise on top of real movement', () => {
    const reps = sweep(new RepDetector(), {
      cycles: 10,
      periodMs: 2500,
      amplitude: 2.5,
      noise: 0.4,
    });
    expect(reps).toBeGreaterThanOrEqual(8);
    expect(reps).toBeLessThanOrEqual(11);
  });

  it('ignores motion too fast to be a rep', () => {
    // Walking with the phone in a pocket, roughly. The plausibility floor is what kills it.
    const cycles = 40;
    const reps = sweep(new RepDetector(), { cycles, periodMs: 400, amplitude: 3 });
    const maxPossible = Math.ceil((cycles * 400) / MIN_REP_MS);
    expect(reps).toBeLessThanOrEqual(maxPossible);
  });

  it('is indifferent to the sign convention', () => {
    // Safari negates accelerationIncludingGravity relative to Chrome. Counting full cycles
    // rather than directed peaks means the same trace counts the same either way.
    const upright = sweep(new RepDetector(), { cycles: 10, periodMs: 2500, amplitude: 2.5 });

    const detector = new RepDetector();
    let inverted = 0;
    const hz = 60;
    const step = 1000 / hz;
    for (let i = 0; i < Math.round((10 * 2500) / step); i++) {
      const t = i * step;
      const motion = 2.5 * Math.sin((2 * Math.PI * t) / 2500);
      if (detector.feed({ x: 0, y: 0, z: -(9.81 + motion) }, t)) inverted++;
    }

    expect(inverted).toBe(upright);
  });

  it('is indifferent to which pocket the phone is in', () => {
    // Same movement, device rotated so the motion lands on a different axis.
    const detector = new RepDetector();
    let reps = 0;
    const step = 1000 / 60;
    for (let i = 0; i < Math.round((10 * 2500) / step); i++) {
      const t = i * step;
      const motion = 2.5 * Math.sin((2 * Math.PI * t) / 2500);
      if (detector.feed({ x: 9.81 + motion, y: 0, z: 0 }, t)) reps++;
    }
    expect(reps).toBeGreaterThanOrEqual(9);
  });

  it('resets cleanly between sets', () => {
    const detector = new RepDetector();
    sweep(detector, { cycles: 5, periodMs: 2500, amplitude: 2.5 });
    detector.reset();
    const reps = sweep(detector, { cycles: 5, periodMs: 2500, amplitude: 2.5 });
    expect(reps).toBeGreaterThanOrEqual(4);
  });
});
