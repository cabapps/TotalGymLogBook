/**
 * The exercise catalog, loaded from data/exercises.json.
 *
 * Lives in the instant tier because logging a set needs an exercise's `usesPulley` and
 * `bodyFraction` to compute the load, and that must happen before Blazor boots (docs/adr/0003).
 */

export interface MuscleInvolvement {
  readonly muscle: string;
  /** 1.0 = prime mover, 0.5 = meaningful secondary. See docs/adr/0010. */
  readonly fraction: number;
}

/**
 * Whether a logged set of this movement is TRAINING VOLUME.
 *
 * Without the distinction, the stretch catalog would silently inflate every muscle's weekly
 * set count and make the coach's volume advice wrong -- a stretch is not a hard set.
 */
export type ExerciseKind = 'strength' | 'stretch';

export interface Exercise {
  readonly id: string;
  readonly name: string;
  /** Grouping for the picker. Presentation only. */
  readonly category: string;
  readonly kind: ExerciseKind;
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

  /**
   * The built-in catalog plus the trainee's own movements.
   *
   * Custom exercises come LAST within their category, so the built-ins keep their order and a
   * new addition is where the trainee expects to find it -- at the bottom of the group they
   * filed it under.
   *
   * A custom exercise whose id collides with a built-in replaces it. That is how editing a
   * shipped entry works: same id, the trainee's values win.
   */
  withCustom(custom: readonly Exercise[]): ExerciseCatalog {
    if (custom.length === 0) return this;

    const overrides = new Map(custom.map((e) => [e.id, e]));
    const kept = this.all.map((e) => overrides.get(e.id) ?? e);
    const added = custom.filter((e) => !this.#byId.has(e.id));

    return new ExerciseCatalog([...kept, ...added]);
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

  /**
   * Only what the trainee can actually do with the accessories they own.
   *
   * UNDEFINED means unconfigured and filters nothing. An empty array means "configured, owns
   * no accessories" and filters hard. The distinction matters: treating unconfigured as
   * owns-nothing would hide squats from someone who has been logging squats for months.
   */
  available(ownedAttachments?: readonly string[]): readonly Exercise[] {
    if (ownedAttachments === undefined) return this.all;

    const owned = new Set(ownedAttachments);
    return this.all.filter((e) => e.attachment === null || owned.has(e.attachment));
  }

  /** Available movements grouped for the picker, in catalog order. */
  grouped(ownedAttachments?: readonly string[]): ReadonlyMap<string, readonly Exercise[]> {
    const groups = new Map<string, Exercise[]>();

    for (const exercise of this.available(ownedAttachments)) {
      const bucket = groups.get(exercise.category);
      if (bucket) bucket.push(exercise);
      else groups.set(exercise.category, [exercise]);
    }

    return groups;
  }

  /** Distinct attachments referenced by the catalog, for the equipment picker. */
  get attachments(): readonly string[] {
    return [...new Set(this.all.map((e) => e.attachment).filter((a): a is string => a !== null))]
      .sort();
  }
}
