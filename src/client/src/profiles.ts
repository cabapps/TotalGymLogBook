/**
 * Loading and lookup for data/rail-profiles.json.
 *
 * Profiles key on level count rather than model name, because Total Gym publishes resistance
 * charts by level count and several models share a rail. Onboarding asks users to count the
 * notches on their rail for the same reason -- the FIT and FIT Anniversary share a name but
 * have 12 and 14 levels (docs/adr/0010).
 */

import type { AngleSource, RailProfile } from './resistance.js';

interface RailProfileFile {
  formulaVersion: number;
  profiles: Array<{
    id: string;
    levelCount: number;
    angleDeg: number[];
    boardWeightLb: number;
    angleSource: string;
    verified: boolean;
  }>;
}

export class RailProfileTable {
  readonly formulaVersion: number;
  readonly #byId: ReadonlyMap<string, RailProfile>;

  private constructor(profiles: readonly RailProfile[], formulaVersion: number) {
    this.formulaVersion = formulaVersion;
    this.#byId = new Map(profiles.map((p) => [p.id, p]));
  }

  static parse(json: string | RailProfileFile): RailProfileTable {
    const doc: RailProfileFile = typeof json === 'string' ? JSON.parse(json) : json;

    const profiles = doc.profiles.map((p): RailProfile => {
      if (p.angleDeg.length !== p.levelCount) {
        throw new Error(
          `Profile '${p.id}' declares levelCount ${p.levelCount} but has ` +
            `${p.angleDeg.length} angles.`,
        );
      }
      return {
        id: p.id,
        levelCount: p.levelCount,
        angleDeg: p.angleDeg,
        boardWeightLb: p.boardWeightLb,
        angleSource: p.angleSource as AngleSource,
        verified: p.verified,
      };
    });

    return new RailProfileTable(profiles, doc.formulaVersion);
  }

  get profiles(): readonly RailProfile[] {
    return [...this.#byId.values()];
  }

  get(id: string): RailProfile {
    const p = this.#byId.get(id);
    if (!p) throw new Error(`No rail profile '${id}'.`);
    return p;
  }

  tryGet(id: string): RailProfile | undefined {
    return this.#byId.get(id);
  }

  /** Profile matching a notch count, which is what onboarding asks for. */
  forLevelCount(levelCount: number): RailProfile {
    const matches = this.profiles.filter((p) => p.levelCount === levelCount);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one rail profile with ${levelCount} levels; found ${matches.length}.`,
      );
    }
    return matches[0]!;
  }
}
