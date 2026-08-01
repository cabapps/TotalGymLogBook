/**
 * Behavioral tests for the resistance model. These assert the claims docs/adr/0004 makes,
 * so if the model changes, the documentation is provably wrong rather than quietly stale.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RailProfileTable } from '../src/profiles.js';
import { addedWeightEfficiency, computeResistance, roundAwayFromZero } from '../src/resistance.js';

const DATA = join(import.meta.dirname, '..', '..', '..', 'data');
const profiles = RailProfileTable.parse(readFileSync(join(DATA, 'rail-profiles.json'), 'utf8'));
const anniversary = profiles.get('rail-14');

describe('rail profiles', () => {
  it('exposes the FIT Anniversary as the 14-notch profile', () => {
    expect(profiles.forLevelCount(14).id).toBe('rail-14');
    expect(profiles.forLevelCount(12).id).toBe('rail-12');
  });

  it('flags rail-10 as unverified because its published angle column is corrupt', () => {
    expect(profiles.get('rail-10').verified).toBe(false);
    expect(profiles.get('rail-10').angleSource).toBe('derived');
  });

  it('rejects out-of-range levels', () => {
    expect(() => computeResistance(anniversary, { bodyweightLb: 180, level: 15 })).toThrow(
      RangeError,
    );
    expect(() => computeResistance(anniversary, { bodyweightLb: 180, level: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('the claims in ADR 0004', () => {
  it('a vest offsets bodyweight loss exactly one-for-one, at any level', () => {
    for (const profile of profiles.profiles) {
      for (let level = 1; level <= profile.levelCount; level++) {
        for (const lost of [5, 12, 20, 35]) {
          const before = computeResistance(profile, { bodyweightLb: 200, level });
          const after = computeResistance(profile, {
            bodyweightLb: 200 - lost,
            level,
            vestLb: lost,
          });
          expect(after).toBeCloseTo(before, 10);
        }
      }
    }
  });

  it('cable exercises are exactly half of direct ones', () => {
    for (let level = 1; level <= anniversary.levelCount; level++) {
      const direct = computeResistance(anniversary, { bodyweightLb: 180, level });
      const cable = computeResistance(anniversary, { bodyweightLb: 180, level, usesPulley: true });
      expect(cable).toBeCloseTo(direct / 2, 10);
    }
  });

  it('added weight is heavily discounted by the incline', () => {
    // ADR 0004: at level 8 (16.5 deg) a 10 lb vest adds only ~2.8 lb, and half again on cable.
    const perLb = addedWeightEfficiency(anniversary, 8);
    expect(roundAwayFromZero(perLb * 10, 1)).toBe(2.8);
    expect(roundAwayFromZero(addedWeightEfficiency(anniversary, 8, true) * 20, 1)).toBe(2.8);
  });

  it('level steps are near-uniform in pounds but not in percentage', () => {
    const ladder = Array.from({ length: anniversary.levelCount }, (_, i) =>
      computeResistance(anniversary, { bodyweightLb: 180, level: i + 1 }),
    );

    const steps = ladder.slice(1).map((v, i) => v - ladder[i]!);
    for (const step of steps) {
      expect(step).toBeGreaterThan(4.3);
      expect(step).toBeLessThan(5.3);
    }

    // ...but level 1->2 is a ~21% jump while 13->14 is ~6%, which is why the coach
    // micro-steps with added weight at the bottom of the range as well as the top.
    const firstPct = (steps[0]! / ladder[0]!) * 100;
    const lastPct = (steps.at(-1)! / ladder.at(-2)!) * 100;
    expect(firstPct).toBeGreaterThan(18);
    expect(lastPct).toBeLessThan(8);
  });

  it('bodyweight loss costs more than a full level at level 8', () => {
    const at180 = computeResistance(anniversary, { bodyweightLb: 180, level: 8 });
    const at160 = computeResistance(anniversary, { bodyweightLb: 160, level: 8 });
    const oneLevel =
      computeResistance(anniversary, { bodyweightLb: 180, level: 8 }) -
      computeResistance(anniversary, { bodyweightLb: 180, level: 7 });

    expect(at180 - at160).toBeGreaterThan(oneLevel);
    expect(roundAwayFromZero(at180 - at160, 1)).toBe(5.7);
  });

  it('bulking inflates absolute load while relative load stays flat', () => {
    const lean = computeResistance(anniversary, { bodyweightLb: 180, level: 10 });
    const bulked = computeResistance(anniversary, { bodyweightLb: 195, level: 10 });

    expect(bulked - lean).toBeGreaterThan(4.9); // roughly one whole level, from eating
    expect(bulked / 195).toBeCloseTo(lean / 180, 2); // ...but relative load is unchanged
  });
});

describe('roundAwayFromZero', () => {
  it('matches .NET MidpointRounding.AwayFromZero', () => {
    expect(roundAwayFromZero(2.25, 1)).toBe(2.3);
    expect(roundAwayFromZero(2.35, 1)).toBe(2.4);
    expect(roundAwayFromZero(-2.25, 1)).toBe(-2.3);
    expect(roundAwayFromZero(56.694, 1)).toBe(56.7);
  });
});
