/**
 * Converts a rail level into actual pounds of resistance.
 *
 *   inclineLoad = (bodyweight + vest) * bodyFraction + bar + boardWeight
 *   resistance  = inclineLoad * sin(angle) * pulleyFactor + directLoad
 *
 * MIRROR of src/TotalGymLogBook.Domain/ResistanceCalculator.cs. Both exist because this
 * calculation is on the instant path -- it updates live as the level selector moves, before
 * Blazor has booted (docs/adr/0003). The two are held in step by a golden-file parity test
 * (docs/adr/0009). Any change here must be made there too.
 *
 * See docs/adr/0004 for the derivation of boardWeightLb and the copyright note.
 */

export type AngleSource = 'published' | 'derived' | 'calibrated';

export interface RailProfile {
  readonly id: string;
  readonly levelCount: number;
  readonly angleDeg: readonly number[];
  /**
   * Effective mass of the glideboard assembly riding the incline. Derived, not published:
   * regressing a chart row against bodyweight yields slope == sin(angle) plus a constant
   * intercept, and intercept / sin(angle) is stable across every level of a profile.
   */
  readonly boardWeightLb: number;
  readonly angleSource: AngleSource;
  /** False when the angles have not been confirmed against a physical machine. */
  readonly verified: boolean;
}

export interface ResistanceInputs {
  readonly bodyweightLb: number;
  /** 1-based rail notch. */
  readonly level: number;
  /** True for cable exercises, which halve the load. */
  readonly usesPulley?: boolean;
  /**
   * Fraction of the body actually on the glideboard. Supine pressing is ~1.0; seated or
   * kneeling work is less. A vest tracks this because it is strapped to the body.
   */
  readonly bodyFraction?: number;
  /** Weighted vest. Rides the incline with the body, so it tracks bodyFraction. */
  readonly vestLb?: number;
  /** Weight bar plates. Bolted to the glideboard, so always fully loaded. */
  readonly barLb?: number;
  /** Load applied to the cable without riding the incline. */
  readonly directLoadLb?: number;
}

/**
 * Bump when the formula changes. Snapshotted onto every SetLog so historical rows can be
 * migrated deliberately rather than drifting (docs/adr/0004).
 */
export const FORMULA_VERSION = 1;

export const PULLEY_FACTOR_CABLE = 0.5;
export const PULLEY_FACTOR_DIRECT = 1.0;

/** Published charts round to whole pounds, so precision beyond this is noise. */
export const OUTPUT_DECIMALS = 1;

const DEG_TO_RAD = Math.PI / 180;

export function angleForLevel(profile: RailProfile, level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > profile.angleDeg.length) {
    throw new RangeError(
      `Profile '${profile.id}' has levels 1-${profile.angleDeg.length}; got ${level}.`,
    );
  }
  return profile.angleDeg[level - 1]!;
}

export function computeResistance(profile: RailProfile, inputs: ResistanceInputs): number {
  const bodyFraction = inputs.bodyFraction ?? 1;
  const vestLb = inputs.vestLb ?? 0;
  const barLb = inputs.barLb ?? 0;
  const directLoadLb = inputs.directLoadLb ?? 0;

  validate(inputs.bodyweightLb, 'bodyweightLb');
  validate(vestLb, 'vestLb');
  validate(barLb, 'barLb');
  validate(directLoadLb, 'directLoadLb');
  if (!(bodyFraction > 0) || bodyFraction > 1) {
    throw new RangeError(`bodyFraction must be in (0, 1]; got ${bodyFraction}.`);
  }

  const angleDeg = angleForLevel(profile, inputs.level);
  const inclineLoad =
    (inputs.bodyweightLb + vestLb) * bodyFraction + barLb + profile.boardWeightLb;
  const pulleyFactor = inputs.usesPulley ? PULLEY_FACTOR_CABLE : PULLEY_FACTOR_DIRECT;

  return inclineLoad * Math.sin(angleDeg * DEG_TO_RAD) * pulleyFactor + directLoadLb;
}

/**
 * computeResistance, rounded to OUTPUT_DECIMALS. Use for display and for cross-language
 * comparison, where two runtimes will not agree bit for bit.
 *
 * Rounds half away from zero to match .NET's MidpointRounding.AwayFromZero; JavaScript's
 * Math.round rounds half toward +Infinity, which disagrees on negatives.
 */
export function computeResistanceRounded(
  profile: RailProfile,
  inputs: ResistanceInputs,
): number {
  return roundAwayFromZero(computeResistance(profile, inputs), OUTPUT_DECIMALS);
}

/**
 * Pounds of resistance added per pound of extra mass riding the incline, at this level.
 * Added weight is heavily discounted by the incline and users do not expect it: at 16.5
 * degrees a 10 lb vest adds only 2.8 lb, and half that again on a cable exercise.
 */
export function addedWeightEfficiency(
  profile: RailProfile,
  level: number,
  usesPulley = false,
): number {
  return (
    Math.sin(angleForLevel(profile, level) * DEG_TO_RAD) *
    (usesPulley ? PULLEY_FACTOR_CABLE : PULLEY_FACTOR_DIRECT)
  );
}

export function roundAwayFromZero(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  // Nudge past the float representation of an exact .5 before truncating.
  const rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5 + Number.EPSILON * Math.abs(scaled));
  return rounded / factor;
}

function validate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number; got ${value}.`);
  }
}
