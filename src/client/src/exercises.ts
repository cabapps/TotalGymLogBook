/**
 * The exercise catalogue, loaded from data/exercises.json.
 *
 * Lives in the instant tier because logging a set needs an exercise's `usesPulley` and
 * `bodyFraction` to compute the load, and that must happen before Blazor boots (docs/adr/0003).
 */

export interface MuscleInvolvement {
  readonly muscle: string;
  /** 1.0 = prime mover, 0.5 = meaningful secondary. See docs/adr/0010. */
  readonly fraction: number;
}

export interface Exercise {
  readonly id: string;
  readonly name: string;
  /** Cable movements are halved by the pulley (docs/adr/0004). */
  readonly usesPulley: boolean;
  /** Share of bodyweight riding the glideboard. Estimated, not measured. */
  readonly bodyFraction: number;
  readonly attachment: string | null;
  readonly cue: string;
  readonly muscles: readonly MuscleInvolvement[];
}

export class ExerciseCatalog {
  readonly #byId: ReadonlyMap<string, Exercise>;
  readonly all: readonly Exercise[];

  private constructor(exercises: readonly Exercise[]) {
    this.all = exercises;
    this.#byId = new Map(exercises.map((e) => [e.id, e]));
  }

  static parse(json: string | { exercises: Exercise[] }): ExerciseCatalog {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    return new ExerciseCatalog(doc.exercises);
  }

  static async load(url = 'data/exercises.json'): Promise<ExerciseCatalog> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
    return ExerciseCatalog.parse(await res.text());
  }

  get(id: string): Exercise {
    const exercise = this.#byId.get(id);
    if (!exercise) throw new Error(`No exercise '${id}'.`);
    return exercise;
  }

  tryGet(id: string): Exercise | undefined {
    return this.#byId.get(id);
  }

  /** Only what the trainee can actually do with the accessories they own. */
  available(ownedAttachments: readonly string[] = []): readonly Exercise[] {
    const owned = new Set(ownedAttachments);
    return this.all.filter((e) => e.attachment === null || owned.has(e.attachment));
  }

  /** Distinct attachments referenced by the catalogue, for the equipment picker. */
  get attachments(): readonly string[] {
    return [...new Set(this.all.map((e) => e.attachment).filter((a): a is string => a !== null))];
  }
}
