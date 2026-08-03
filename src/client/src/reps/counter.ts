/**
 * Rep sources and the counter that merges them. See docs/adr/0006.
 *
 * Lives in TypeScript, not .NET, because the motion source is a 60 Hz stream needing low
 * latency and pre-boot availability. Marshalling 60 samples a second across the interop
 * boundary to save a hundred lines of filter code is the wrong trade (docs/adr/0003).
 */

/** One rep happened. What the motion source emits: it can see events, not totals. */
export interface RepIncrement {
  readonly kind: 'increment';
  readonly sourceId: string;
  readonly at: number;
  readonly confidence: number;
}

/**
 * "The trainee asserts they are at N." What the voice source emits, because someone counting
 * out loud is reporting a TOTAL, not signalling an event.
 *
 * This distinction is the whole reason the two sources cannot share one event type, and getting
 * it wrong undercounts every set: speech recognition drops words constantly under exertion, so
 * incrementing per word heard is lossy in a way that taking the highest number heard is not.
 */
export interface RepCount {
  readonly kind: 'count';
  readonly sourceId: string;
  readonly at: number;
  readonly count: number;
  readonly confidence: number;
}

export type RepEvent = RepIncrement | RepCount;

export interface RepSource {
  readonly id: string;
  readonly label: string;
  /** Pure capability detection. MUST NOT prompt -- docs/adr/0006 rule 1. */
  isAvailable(): Promise<boolean>;
  /** MUST be called from a user gesture -- docs/adr/0006 rule 2. */
  requestPermission?(): Promise<boolean>;
  start(sink: (event: RepEvent) => void, onError?: (message: string) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A Total Gym rep takes 1-4 seconds. Anything faster is noise, and this one check kills most
 * accelerometer false positives (docs/adr/0006). It also subsumes the cross-source dedupe
 * window the ADR specifies at ~300 ms: two sources reporting the same rep are necessarily
 * inside 600 ms of each other, so a single refractory period does both jobs.
 */
/**
 * Refractory period between counted reps.
 *
 * Walking is the failure case this exists for: a phone in a pocket sees a footfall every
 * 500-600 ms, and the original 600 ms floor let every one of them through, so a trainee who
 * logged a set and walked to the kitchen came back to a counter that had counted the walk.
 *
 * 900 ms, having tried 1200. The refractory period is a blunt instrument -- it cannot tell a
 * fast rep from a footstep, and set high enough to be sure of walking it starts dropping real
 * reps, which is what 1200 did. The actual defence is in the detector, which gates on the
 * interval between signal CROSSINGS rather than between counted reps: a stream of fast crossings
 * counts nothing at all, rather than counting every other one. That works at any threshold, so
 * this one only has to rule out a rep and its own echo.
 */
export const MIN_REP_MS = 900;

/**
 * How far a single spoken number may jump ahead of the running count.
 *
 * Someone counting increments by one. Recognition drops words, so gaps happen -- 1, 2, 3, 4
 * heard as "one ... four" is normal and must be accepted. What is NOT normal is "forty" when
 * you are at three, which is what "four" sounds like through gritted teeth. Bounding the jump
 * turns the most damaging misrecognition into a no-op while leaving the useful self-healing
 * property intact: miss two reps and the third still puts you at the right number.
 */
export const MAX_SPOKEN_JUMP = 3;

/** Beyond this, someone is reading a phone number at their phone, not doing reps. */
export const MAX_REPS = 100;

export interface CounterStats {
  /** Events the guards threw away. Surfaced so a source that is mostly noise is visible. */
  readonly rejected: number;
  readonly accepted: number;
}

/**
 * Owns the running count. Sources propose; this disposes.
 *
 * Deliberately the single owner, so that manual correction stays live alongside an automatic
 * source (docs/adr/0006 rule 3). Tapping + to 5 and then saying "six" works, because the voice
 * source has no count of its own to disagree with.
 */
export class RepCounter {
  #count = 0;
  /**
   * Negative infinity, not zero. The refractory period is measured against this, so seeding it
   * with a real timestamp makes the counter reject the FIRST rep of every set -- invisible in
   * casual use, because the second rep lands fine and the count is only one short.
   */
  #lastAcceptedAt = Number.NEGATIVE_INFINITY;
  #accepted = 0;
  #rejected = 0;

  constructor(private readonly onChange: (count: number) => void = () => {}) {}

  get count(): number {
    return this.#count;
  }

  get stats(): CounterStats {
    return { rejected: this.#rejected, accepted: this.#accepted };
  }

  /** A manual edit. Keeps automatic sources anchored to what the trainee actually sees. */
  setCount(count: number, at = Date.now()): void {
    this.#count = Math.max(0, Math.min(MAX_REPS, Math.floor(count)));
    this.#lastAcceptedAt = at;
  }

  reset(): void {
    this.#count = 0;
    this.#lastAcceptedAt = Number.NEGATIVE_INFINITY;
    this.#accepted = 0;
    this.#rejected = 0;
  }

  /** Returns true when the event moved the count. */
  accept(event: RepEvent): boolean {
    const ok = event.kind === 'increment' ? this.#increment(event) : this.#absolute(event);

    if (ok) {
      this.#accepted++;
      this.onChange(this.#count);
    } else {
      this.#rejected++;
    }
    return ok;
  }

  #increment(event: RepIncrement): boolean {
    if (event.at - this.#lastAcceptedAt < MIN_REP_MS) return false;
    if (this.#count >= MAX_REPS) return false;

    this.#count++;
    this.#lastAcceptedAt = event.at;
    return true;
  }

  #absolute(event: RepCount): boolean {
    const { count } = event;

    // Monotonic and bounded. Never backwards -- a trainee who says "three" after "five" was
    // misheard, and a rep already banked should not evaporate.
    if (count <= this.#count) return false;
    if (count > this.#count + MAX_SPOKEN_JUMP) return false;
    if (count > MAX_REPS) return false;

    this.#count = count;
    this.#lastAcceptedAt = event.at;
    return true;
  }
}
