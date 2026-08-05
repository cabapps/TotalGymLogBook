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

/**
 * A thing the trainee can own, and what it lets them do.
 *
 * Deliberately not the same vocabulary as `Exercise.attachment`. An exercise names a CAPABILITY
 * ("Wing attachment"); an accessory is a PRODUCT that provides one. The wing shipped in one-piece
 * and two-piece versions that do exactly the same job, so an exercise naming the product would
 * hide pull-ups from every owner of the other one.
 */
export interface Accessory {
  readonly id: string;
  readonly name: string;
  /** Capabilities this unlocks — matched against `Exercise.attachment`. */
  readonly provides: readonly string[];
  /** Ships with most machines. Presentation only; it never filters. */
  readonly common: boolean;
  /** Registry version this first appeared in. See {@link ExerciseCatalog.resolveOwned}. */
  readonly added: number;
  readonly note?: string;
}

/**
 * Where in the range the muscle is most loaded.
 *
 * Loaded work at long muscle lengths grows a muscle more than the same sets through a shortened
 * range, and this machine is unusually good at it -- a cable holds tension at the bottom of a fly
 * where a dumbbell goes slack. So a hypertrophy program built here should lean on the lengthened
 * ones (docs/adr/0010).
 *
 * A judgment about mechanics, in the same class as bodyFraction: it changes which exercise gets
 * suggested first, never a recorded number.
 */
export type PeakTension = 'lengthened' | 'even' | 'shortened';

/**
 * How the trainee is arranged on the machine.
 *
 * Two jobs, one field: it is what the app tells the trainee about setting the movement up, and it
 * is what decides which movements can be done back to back without rebuilding the machine. Having
 * the instructions and the ordering read the same data is the point -- if they disagreed, one of
 * them would be lying to the trainee and there would be no way to tell which.
 */
export interface ExerciseSetup {
  /** supine, prone, seated, kneeling, side-lying, plank, standing. */
  readonly position: string;
  /** Which end of the rail the head points at. 'tower' is the pulley end, up the incline. */
  readonly facing: string;
  /**
   * A second facing this movement also works at, where one exists.
   *
   * A curl is the clear case: fine either way round. It matters to the ordering rather than to
   * the wording -- a movement that works both ways can sit in a block set up the other way
   * without anybody turning around.
   */
  readonly alsoFacing?: string;
  /** What is in the hands, or on the ankles. */
  readonly grip: string;
}

export interface Exercise {
  readonly id: string;
  readonly name: string;
  /** Grouping for the picker. Presentation only. */
  readonly category: string;
  readonly kind: ExerciseKind;
  /** Cable movements are halved by the pulley (docs/adr/0004). */
  readonly usesPulley: boolean;
  readonly peakTension: PeakTension;
  readonly setup: ExerciseSetup;
  /**
   * Roughly where on the rail this is done, as a fraction of it.
   *
   * Decides which movements can be alternated: a superset only saves time if both run at the
   * same notch. Derived from muscle group and the pulley, and overridden by the trainee's own
   * logged levels once they have any.
   */
  /**
   * True when one set trains ONE side.
   *
   * A logged set of these carries which side it was, volume is counted per side rather than
   * pooled, and one planned set costs two sets of time -- see workingSets.
   */
  readonly unilateral: boolean;
  readonly typicalLevel: number;
  /** Share of bodyweight riding the glideboard. Estimated, not measured. */
  readonly bodyFraction: number;
  readonly attachment: string | null;
  readonly cue: string;
  readonly muscles: readonly MuscleInvolvement[];
}

/**
 * What an answer with no recorded version answered.
 *
 * Version 1, not 0. Those answers came from the panel that stored capability labels, and that
 * panel offered exactly the version-1 accessories -- so a trainee who left the press-up bars
 * unticked meant it. Reading them as "answered nothing" would silently re-tick every box they
 * had deliberately cleared.
 */
const LEGACY_ANSWER_VERSION = 1;

export class ExerciseCatalog {
  readonly #byId: ReadonlyMap<string, Exercise>;
  readonly #accessoryById: ReadonlyMap<string, Accessory>;
  readonly all: readonly Exercise[];
  readonly accessories: readonly Accessory[];

  private constructor(exercises: readonly Exercise[], accessories: readonly Accessory[]) {
    this.all = exercises;
    this.accessories = accessories;
    this.#byId = new Map(exercises.map((e) => [e.id, e]));
    this.#accessoryById = new Map(accessories.map((a) => [a.id, a]));
  }

  static parse(
    json: string | { exercises: Exercise[]; accessories?: Accessory[] },
  ): ExerciseCatalog {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    return new ExerciseCatalog(doc.exercises, doc.accessories ?? []);
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

    return new ExerciseCatalog([...kept, ...added], this.accessories);
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

    const can = this.capabilities(ownedAttachments);
    return this.all.filter((e) => e.attachment === null || can.has(e.attachment));
  }

  /**
   * What a stored answer lets the trainee do.
   *
   * Entries are accessory ids. An entry that matches no accessory is taken as a capability name
   * verbatim, which is how answers stored before the accessory registry existed keep working:
   * back then the panel wrote the requirement label itself ("Squat stand"), and those labels are
   * still capability names today. Dropping that fallback would silently empty the picker for
   * anyone who configured their equipment before this release.
   */
  capabilities(ownedAttachments: readonly string[]): ReadonlySet<string> {
    const can = new Set<string>();

    for (const entry of ownedAttachments) {
      const accessory = this.#accessoryById.get(entry);
      if (accessory) for (const capability of accessory.provides) can.add(capability);
      else can.add(entry);
    }

    return can;
  }

  /** The newest accessory-registry version this catalog knows about. */
  get accessoryVersion(): number {
    return this.accessories.reduce((max, a) => Math.max(max, a.added), 0);
  }

  /**
   * A stored answer, brought up to date with accessories added since it was given.
   *
   * SILENCE IS NOT A NO. A trainee who ticked their equipment last year answered a shorter
   * question than the one being asked now; treating the accessories added since as "not owned"
   * would make an app update quietly delete exercises from their picker -- including movements
   * they have logged for months, and including ones their own program plans. So anything newer
   * than the version they answered counts as owned until they say otherwise, and the next save
   * records their real answer.
   *
   * Undefined in, undefined out: never configured still means "show everything", which is a
   * different state from this one and stays that way (see {@link available}).
   */
  resolveOwned(
    ownedAttachments: readonly string[] | undefined,
    answeredVersion?: number,
  ): readonly string[] | undefined {
    if (ownedAttachments === undefined) return undefined;

    const answered = answeredVersion ?? LEGACY_ANSWER_VERSION;
    const unanswered = this.accessories
      .filter((a) => a.added > answered)
      .map((a) => a.id);

    return unanswered.length === 0
      ? ownedAttachments
      : [...new Set([...ownedAttachments, ...unanswered])];
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

  /** Distinct capabilities the catalog's exercises ask for. */
  get attachments(): readonly string[] {
    return [...new Set(this.all.map((e) => e.attachment).filter((a): a is string => a !== null))]
      .sort();
  }
}
