import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EMA_ALPHA,
  MIN_READINGS,
  STALE_AFTER_DAYS,
  daysSince,
  describeCoverage,
  isStale,
  latestReading,
  readingsNeededForTrend,
  smoothedLb,
  toReadings,
} from '../src/bodyweight.js';

const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}`;

describe('smoothing', () => {
  it('returns undefined with no readings', () => {
    expect(smoothedLb([])).toBeUndefined();
  });

  it('returns the value itself for a single reading', () => {
    expect(smoothedLb([{ on: day(1), lb: 180 }])).toBe(180);
  });

  it('damps a single-day water swing', () => {
    // The point of smoothing: one 6 lb Tuesday must not rewrite every load figure.
    const steady = Array.from({ length: 10 }, (_, i) => ({ on: day(i + 1), lb: 180 }));
    const withSpike = [...steady.slice(0, 9), { on: day(10), lb: 186 }];

    const smoothed = smoothedLb(withSpike)!;
    expect(smoothed).toBeGreaterThan(180);
    expect(smoothed).toBeLessThan(182); // 6 lb of noise becomes under 2 lb of movement
  });

  it('tracks a genuine trend rather than lagging forever', () => {
    const losing = Array.from({ length: 30 }, (_, i) => ({ on: day(1), lb: 200 - i * 0.2 }))
      .map((r, i) => ({ on: `2026-0${i < 30 ? '3' : '4'}-${String((i % 28) + 1).padStart(2, '0')}`, lb: r.lb }));

    const smoothed = smoothedLb(losing)!;
    const finalRaw = losing[losing.length - 1]!.lb;
    expect(Math.abs(smoothed - finalRaw)).toBeLessThan(1.5);
  });

  it('is order-independent, since storage order is not guaranteed', () => {
    const readings = [
      { on: day(3), lb: 178 },
      { on: day(1), lb: 182 },
      { on: day(2), lb: 180 },
    ];
    const sorted = [
      { on: day(1), lb: 182 },
      { on: day(2), lb: 180 },
      { on: day(3), lb: 178 },
    ];
    expect(smoothedLb(readings)).toBeCloseTo(smoothedLb(sorted)!, 10);
  });

  it('matches the constants the C# side uses', () => {
    // Mirrors TotalGymLogBook.Domain.Training.BodyweightTrend. A parity fixture in
    // tests/Domain.Tests asserts the computed values agree; these guard the inputs.
    expect(EMA_ALPHA).toBe(0.25);
    expect(STALE_AFTER_DAYS).toBe(21);
    expect(MIN_READINGS).toBe(3);
  });
});

describe('staleness', () => {
  it('counts days between calendar dates', () => {
    expect(daysSince('2026-03-01', '2026-03-01')).toBe(0);
    expect(daysSince('2026-03-01', '2026-03-15')).toBe(14);
    // Across a month boundary, which naive arithmetic gets wrong.
    expect(daysSince('2026-02-25', '2026-03-05')).toBe(8);
  });

  it('treats no readings as stale', () => {
    expect(isStale([], '2026-03-01')).toBe(true);
  });

  it('flags a weight old enough to corrupt load figures', () => {
    const readings = [{ on: '2026-03-01', lb: 180 }];
    expect(isStale(readings, '2026-03-15')).toBe(false);
    expect(isStale(readings, '2026-04-30')).toBe(true);
  });
});

describe('coverage messages', () => {
  it('never names a phase', () => {
    // docs/adr/0010: the UI reports observations, not internal labels.
    const jargon = ['deficit', 'surplus', 'maintenance', 'phase', 'EMA'];
    const cases = [
      [],
      [{ on: day(1), lb: 180 }],
      [{ on: day(1), lb: 180 }, { on: day(8), lb: 179 }, { on: day(15), lb: 178 }],
    ];

    for (const readings of cases) {
      const text = describeCoverage(readings, day(15)).toLowerCase();
      for (const word of jargon) expect(text).not.toContain(word);
    }
  });

  it('asks for a weight when there is none', () => {
    expect(describeCoverage([], day(1))).toMatch(/add your weight/i);
  });

  it('says how many more weigh-ins are needed before a trend', () => {
    expect(readingsNeededForTrend([])).toBe(3);
    expect(readingsNeededForTrend([{ on: day(1), lb: 180 }])).toBe(2);
    expect(readingsNeededForTrend(Array(5).fill({ on: day(1), lb: 180 }))).toBe(0);

    expect(describeCoverage([{ on: day(1), lb: 180 }], day(2))).toMatch(/2 more weigh-ins/);
  });

  it('warns when the last weigh-in is old', () => {
    const text = describeCoverage([{ on: '2026-01-01', lb: 180 }], '2026-03-01');
    expect(text).toMatch(/59 days ago/);
    expect(text).toMatch(/accurate/);
  });

  it('acknowledges a weigh-in today', () => {
    const readings = [
      { on: day(1), lb: 180 },
      { on: day(8), lb: 179 },
      { on: day(15), lb: 178 },
    ];
    expect(describeCoverage(readings, day(15))).toMatch(/today/i);
  });
});

describe('toReadings', () => {
  it('drops tombstoned rows', () => {
    const rows = [
      { id: '1', on: day(1), lb: 180, updatedAt: 1 },
      { id: '2', on: day(2), lb: 999, updatedAt: 1, deletedAt: 2 },
    ];
    const readings = toReadings(rows);

    expect(readings).toHaveLength(1);
    expect(latestReading(readings)?.lb).toBe(180);
  });
});

describe('cross-language parity with BodyweightTrend', () => {
  // Smoothing is the second thing implemented in both languages, so it gets the same
  // golden-file treatment as the resistance calculator (docs/adr/0009). Either side drifting
  // fails its own suite; an intentional change shows as a reviewable diff.
  const DATA = join(import.meta.dirname, '..', '..', '..', 'data');
  const read = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

  const cases = read('bodyweight-cases.json') as {
    emaAlpha: number;
    cases: Array<{ id: string; readings: Array<{ on: string; lb: number }> }>;
  };
  const golden = read('bodyweight-expected.json') as {
    emaAlpha: number;
    decimals: number;
    expected: Record<string, number>;
  };

  it('agrees on the smoothing constant', () => {
    expect(cases.emaAlpha).toBe(EMA_ALPHA);
    expect(golden.emaAlpha).toBe(EMA_ALPHA);
  });

  it('every case has a golden value and vice versa', () => {
    const ids = new Set(cases.cases.map((c) => c.id));
    const goldenIds = new Set(Object.keys(golden.expected));
    expect([...ids].filter((i) => !goldenIds.has(i))).toEqual([]);
    expect([...goldenIds].filter((i) => !ids.has(i))).toEqual([]);
  });

  it('matches the C# smoothed values', () => {
    const failures: string[] = [];
    const factor = 10 ** golden.decimals;

    for (const c of cases.cases) {
      const actual = Math.round(smoothedLb(c.readings)! * factor) / factor;
      const expected = golden.expected[c.id]!;
      if (Math.abs(actual - expected) > 1e-6) {
        failures.push(`${c.id}: expected ${expected}, got ${actual}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
