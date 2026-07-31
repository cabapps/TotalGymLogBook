/**
 * Bodyweight smoothing for the instant tier.
 *
 * MIRROR of the smoothing half of TotalGymLogBook.Domain.Training.BodyweightTrend. Only the
 * EMA and staleness live here, deliberately:
 *
 *   - The SMOOTHED weight is needed at log time, because it feeds the resistance calculation
 *     (docs/adr/0004) and that has to work before Blazor boots. So it must be in TypeScript.
 *   - PHASE INFERENCE -- the least-squares rate, the hysteresis, the significance gate -- is
 *     derived, not instant-path. It stays in C# only, where it is properly tested. Duplicating
 *     it here would double the surface area of the subtlest logic in the app for no benefit.
 *
 * The constants below must match BodyweightTrend. A parity test asserts the EMA agrees.
 */

import type { BodyweightRecord } from './db/schema.js';

/** Matches BodyweightTrend.EmaAlpha. ~1 week of effective window at daily weigh-ins. */
export const EMA_ALPHA = 0.25;

/** Matches BodyweightTrend.StaleAfterDays. */
export const STALE_AFTER_DAYS = 21;

/** Matches BodyweightTrend.MinReadings / MinSpanDays -- when C# can call a phase at all. */
export const MIN_READINGS = 3;
export const MIN_SPAN_DAYS = 14;

export interface Reading {
  readonly on: string;
  readonly lb: number;
}

/**
 * Exponentially smoothed bodyweight, oldest reading first.
 *
 * Daily weight swings 2-4 lb on water and glycogen alone. Feeding a raw scale reading into the
 * load calculation would let a Tuesday bloat rewrite every number the user sees, so the raw
 * value is stored for auditability and this is what actually computes.
 */
export function smoothedLb(readings: readonly Reading[]): number | undefined {
  if (readings.length === 0) return undefined;

  const sorted = [...readings].sort((a, b) => a.on.localeCompare(b.on));
  let ema = sorted[0]!.lb;
  for (let i = 1; i < sorted.length; i++) {
    ema = EMA_ALPHA * sorted[i]!.lb + (1 - EMA_ALPHA) * ema;
  }
  return ema;
}

export function latestReading(readings: readonly Reading[]): Reading | undefined {
  if (readings.length === 0) return undefined;
  return [...readings].sort((a, b) => a.on.localeCompare(b.on))[readings.length - 1];
}

export function daysSince(on: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * A bodyweight three months old silently corrupts every load figure computed from it
 * (docs/adr/0004), so the app carries the last value forward but says so.
 */
export function isStale(readings: readonly Reading[], today: string): boolean {
  const latest = latestReading(readings);
  return latest ? daysSince(latest.on, today) > STALE_AFTER_DAYS : true;
}

/** How many more weigh-ins, roughly, before the coach can call a trend. */
export function readingsNeededForTrend(readings: readonly Reading[]): number {
  return Math.max(0, MIN_READINGS - readings.length);
}

/**
 * Plain-language status for the weigh-in prompt. Never names a phase -- that is C#'s job and
 * docs/adr/0010 requires the UI describe observations instead of labels.
 */
export function describeCoverage(readings: readonly Reading[], today: string): string {
  const latest = latestReading(readings);
  if (!latest) return 'Add your weight so your load numbers are accurate.';

  const days = daysSince(latest.on, today);
  const stale = days > STALE_AFTER_DAYS;

  if (stale) {
    return `Last weigh-in was ${days} days ago. A current weight keeps your load numbers accurate.`;
  }

  const needed = readingsNeededForTrend(readings);
  if (needed > 0) {
    return `${needed} more weigh-in${needed === 1 ? '' : 's'} over a couple of weeks and the coach can spot your trend.`;
  }

  return days === 0 ? 'Weighed in today.' : `Last weigh-in ${days} day${days === 1 ? '' : 's'} ago.`;
}

/** Convenience over stored rows, which carry tombstones the caller should not see. */
export function toReadings(rows: readonly BodyweightRecord[]): Reading[] {
  return rows.filter((r) => !r.deletedAt).map((r) => ({ on: r.on, lb: r.lb }));
}
