/**
 * Asserts the TypeScript resistance calculator matches the committed golden file.
 *
 * The mirrored C# implementation asserts against the same file in
 * tests/Domain.Tests/ParityTests.cs, so either side drifting fails its own suite, and an
 * intentional formula change appears as a reviewable diff. See docs/adr/0009.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RailProfileTable } from '../src/profiles.js';
import {
  FORMULA_VERSION,
  OUTPUT_DECIMALS,
  computeResistanceRounded,
  type ResistanceInputs,
} from '../src/resistance.js';

const DATA = join(import.meta.dirname, '..', '..', '..', 'data');
const read = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

interface CaseDto extends Required<ResistanceInputs> {
  id: string;
  profileId: string;
}

const profiles = RailProfileTable.parse(read('rail-profiles.json'));
const casesFile = read('resistance-cases.json') as { formulaVersion: number; cases: CaseDto[] };
const expectedFile = read('resistance-expected.json') as {
  formulaVersion: number;
  outputDecimals: number;
  expected: Record<string, number>;
};

describe('resistance parity with the golden file', () => {
  it('fixtures agree on formula version', () => {
    expect(casesFile.formulaVersion).toBe(FORMULA_VERSION);
    expect(expectedFile.formulaVersion).toBe(FORMULA_VERSION);
    expect(expectedFile.outputDecimals).toBe(OUTPUT_DECIMALS);
    expect(profiles.formulaVersion).toBe(FORMULA_VERSION);
  });

  it('every case has a golden value and vice versa', () => {
    const caseIds = new Set(casesFile.cases.map((c) => c.id));
    const goldenIds = new Set(Object.keys(expectedFile.expected));

    const missing = [...caseIds].filter((id) => !goldenIds.has(id));
    const orphaned = [...goldenIds].filter((id) => !caseIds.has(id));

    expect(missing, 'cases with no golden value; re-run tools/GenerateExpected').toEqual([]);
    expect(orphaned, 'golden values with no case; re-run tools/GenerateExpected').toEqual([]);
  });

  it('all cases match the golden file', () => {
    const failures: string[] = [];

    for (const c of casesFile.cases) {
      const actual = computeResistanceRounded(profiles.get(c.profileId), c);
      const expected = expectedFile.expected[c.id]!;
      if (actual !== expected) {
        failures.push(`${c.id}: expected ${expected}, got ${actual}`);
      }
    }

    expect(
      failures.slice(0, 20),
      `${failures.length}/${casesFile.cases.length} cases drifted. If the formula change was ` +
        'deliberate, re-run tools/GenerateExpected and review the diff.',
    ).toEqual([]);
  });

  it('cases cover every level of every profile', () => {
    for (const profile of profiles.profiles) {
      for (let level = 1; level <= profile.levelCount; level++) {
        const found = casesFile.cases.some(
          (c) => c.profileId === profile.id && c.level === level,
        );
        expect(found, `no case for ${profile.id} level ${level}`).toBe(true);
      }
    }
  });
});
