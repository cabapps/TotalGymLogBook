/**
 * Counting reps from the phone's accelerometer.
 *
 * The signal is unusually clean for this kind of thing: a glideboard is near-perfect
 * one-dimensional reciprocating motion along a fixed rail (docs/adr/0006). The work is turning
 * three noisy axes into one signed scalar and then not counting the same rep twice.
 *
 * <tg-rep-assist> owns the "put the phone somewhere it can feel the movement" part. This owns
 * the arithmetic.
 */

import { MIN_REP_MS, type RepEvent, type RepSource } from './counter.js';

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Orientation tracker. Slow on purpose: a rep lasts 1-4 s, so anything fast enough to follow
 * the trainee's posture is also fast enough to follow the rep and cancel the signal being
 * measured. At 60 Hz this is a time constant of roughly eight seconds.
 */
const GRAVITY_ALPHA = 0.002;

/** Light smoothing on the projected signal -- kills sample jitter, keeps the rep waveform. */
const SIGNAL_ALPHA = 0.35;

/**
 * The adaptive threshold tracks the recent PEAK amplitude, decaying slowly, and triggers at a
 * fraction of it.
 *
 * The obvious alternative -- threshold as a multiple of the mean absolute signal -- is
 * self-defeating, and measurably so: for a sinusoid, peak is only π/2 ≈ 1.57× the mean
 * absolute value, so any multiplier above that puts the threshold permanently out of the
 * signal's reach. The first version used 1.7 and counted exactly one rep per set before the
 * "noise floor" it was measuring climbed above the reps it was supposed to detect.
 *
 * Tracking the peak instead means the threshold scales WITH the movement rather than against
 * it, so a gentle set and a violent one both count.
 */
const PEAK_FRACTION = 0.48;

/** Peak memory halves in roughly four seconds at 60 Hz -- about two reps. */
const PEAK_DECAY = 0.997;

/**
 * Thresholds are expressed as a FRACTION OF MEASURED GRAVITY rather than in m/s².
 *
 * The DeviceMotion spec says m/s², but implementations disagree in both scale and sign --
 * Safari's accelerationIncludingGravity is negated relative to Chrome's. Dividing by the
 * device's own resting magnitude makes the detector indifferent to the units it is handed, and
 * counting full cycles rather than directed peaks makes it indifferent to the sign convention.
 */
const MIN_THRESHOLD_G = 0.065;

/** Re-arming is easier than triggering, so a rep is one clean cycle, not two half ones. */
const REARM_FRACTION = 0.4;

/**
 * WHICH KNOB DOES WHICH JOB.
 *
 * These two were raised hard to stop the detector counting walking, and that was the wrong tool:
 * they set how BIG a movement has to be, and a footfall is not small. All the raise achieved was
 * to start dropping real reps -- gentle ones, the end of a hard set, anyone not slamming the
 * board -- while walking still got through on amplitude and was caught by the timing gate below
 * anyway.
 *
 * So they are back near where they started. Walking is rejected by CADENCE, in the crossing-
 * interval gate in feed(): footfalls arrive every 500-600 ms and nothing on this machine does,
 * so a stream of them counts nothing regardless of how hard the phone is being shaken.
 *
 * Amplitude thresholds are for separating movement from noise. Timing is for separating one kind
 * of movement from another. Using either for the other's job costs accuracy at both.
 */

/**
 * Turns a stream of accelerometer samples into rep events.
 *
 * Pure and synchronous, so the whole detector can be driven from a unit test with synthetic
 * waveforms instead of a phone strapped to a glideboard. See test/reps.test.ts, which feeds it
 * a sinusoid at realistic rep cadence and asserts the count, then feeds it noise and asserts
 * silence.
 */
export class RepDetector {
  #gravity: Vector3 | undefined;
  #signal = 0;
  #peak = 0;
  #armed = true;
  #lastCrossingAt = Number.NEGATIVE_INFINITY;
  #lastConfidence = 0;

  reset(): void {
    this.#gravity = undefined;
    this.#signal = 0;
    this.#peak = 0;
    this.#armed = true;
    this.#lastCrossingAt = Number.NEGATIVE_INFINITY;
    this.#lastConfidence = 0;
  }

  /** Confidence of the most recent rep, 0-1. Peak height relative to the trigger threshold. */
  get lastConfidence(): number {
    return this.#lastConfidence;
  }

  /**
   * Feeds one sample. Returns true when a rep completed.
   *
   * @param sample accelerationIncludingGravity, in whatever units the platform uses.
   * @param at     event timestamp in ms.
   */
  feed(sample: Vector3, at: number): boolean {
    // First sample seeds the orientation exactly, so the detector is usable within a rep or two
    // rather than after the EMA has crawled up from zero.
    this.#gravity ??= sample;

    const g = this.#gravity;
    this.#gravity = {
      x: g.x + GRAVITY_ALPHA * (sample.x - g.x),
      y: g.y + GRAVITY_ALPHA * (sample.y - g.y),
      z: g.z + GRAVITY_ALPHA * (sample.z - g.z),
    };

    const magnitude = Math.hypot(g.x, g.y, g.z);
    if (magnitude < 1e-6) return false;

    // Project the dynamic part onto the gravity direction. The rail is inclined, so vertical
    // travel dominates every Total Gym movement -- this recovers most of the rep amplitude
    // from any phone orientation, without needing to know which pocket it is in.
    const dynamic =
      ((sample.x - g.x) * g.x + (sample.y - g.y) * g.y + (sample.z - g.z) * g.z) / magnitude;

    this.#signal += SIGNAL_ALPHA * (dynamic - this.#signal);
    this.#peak = Math.max(Math.abs(this.#signal), this.#peak * PEAK_DECAY);

    const threshold = Math.max(MIN_THRESHOLD_G * magnitude, PEAK_FRACTION * this.#peak);

    // A rep is one full cycle: the signal must fall back through the re-arm level before the
    // next peak can count. Without this the push and the return of a single rep both trigger.
    if (this.#signal < -threshold * REARM_FRACTION) this.#armed = true;

    if (!this.#armed || this.#signal < threshold) return false;

    // The gate is on the interval between CROSSINGS, not between counted reps -- and that
    // distinction is the whole defence against walking. Gating counted reps only throttles a
    // fast oscillation: footfalls arrive every ~550 ms, so a 1200 ms gate on output still lets
    // through every other step. Gating the input means a stream of fast crossings counts
    // nothing at all, while a genuinely slow set is untouched.
    const sinceLast = at - this.#lastCrossingAt;
    this.#armed = false;
    this.#lastCrossingAt = at;

    if (sinceLast < MIN_REP_MS) return false;
    this.#lastConfidence = Math.min(1, this.#signal / (threshold * 2));
    return true;
  }
}

type PermissionCapableDeviceMotion = {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

function deviceMotionCtor(): (typeof DeviceMotionEvent & PermissionCapableDeviceMotion) | undefined {
  return typeof DeviceMotionEvent === 'undefined' ? undefined : DeviceMotionEvent;
}

export class MotionRepSource implements RepSource {
  readonly id = 'motion';
  readonly label = 'Phone on the board';

  readonly #detector = new RepDetector();
  #sink: ((event: RepEvent) => void) | undefined;
  #listening = false;

  /**
   * Capability only, never a prompt (docs/adr/0006 rule 1).
   *
   * DeviceMotionEvent is defined in desktop browsers that will never fire it, so a bare typeof
   * check offers the trainee a mode that silently does nothing. Requiring either iOS's
   * permission gate or a touch screen keeps the option off laptops.
   */
  isAvailable(): Promise<boolean> {
    const ctor = deviceMotionCtor();
    const plausible =
      ctor !== undefined &&
      (typeof ctor.requestPermission === 'function' || navigator.maxTouchPoints > 0);

    return Promise.resolve(plausible && window.isSecureContext);
  }

  /** MUST be called from a user gesture: iOS throws otherwise (docs/adr/0006 rule 2). */
  async requestPermission(): Promise<boolean> {
    const ctor = deviceMotionCtor();
    if (!ctor) return false;

    // Only iOS gates this. Everywhere else motion is readable once the page is secure.
    if (typeof ctor.requestPermission !== 'function') return true;

    try {
      return (await ctor.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  start(sink: (event: RepEvent) => void, onError?: (message: string) => void): Promise<void> {
    this.#sink = sink;
    this.#detector.reset();

    if (!this.#listening) {
      window.addEventListener('devicemotion', this.#onMotion);
      this.#listening = true;
    }

    // Silence is the failure mode here -- permission granted, listener attached, no events,
    // because the phone is on a desk. Say so rather than showing a counter stuck at zero.
    this.#watchdog = window.setTimeout(() => {
      if (this.#samples === 0) onError?.('No movement detected. Is the phone on the board?');
    }, 8_000);

    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.#listening) {
      window.removeEventListener('devicemotion', this.#onMotion);
      this.#listening = false;
    }
    if (this.#watchdog !== undefined) window.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    this.#samples = 0;
    this.#sink = undefined;
    return Promise.resolve();
  }

  #samples = 0;
  #watchdog: number | undefined;

  #onMotion = (event: DeviceMotionEvent): void => {
    const a = event.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;

    this.#samples++;
    const at = Date.now();

    if (this.#detector.feed({ x: a.x, y: a.y, z: a.z }, at)) {
      this.#sink?.({
        kind: 'increment',
        sourceId: this.id,
        at,
        confidence: this.#detector.lastConfidence,
      });
    }
  };
}
