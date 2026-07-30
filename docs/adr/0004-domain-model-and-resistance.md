# 0004 — Domain model and the resistance calculation

**Status:** Accepted

## Context

The Total Gym creates resistance by inclining a glideboard, so load is a function of bodyweight
and incline angle — unlike a barbell, where load is independent of the lifter. Users know only
two things: their machine and the level they set the rail to.

This is the app's central differentiator. Converting level → actual pounds makes progressive
overload meaningful across level changes *and* bodyweight changes, which no generic workout
tracker can do.

## The formula

```
inclineLoad = (bodyweight + vestLb) * bodyFraction + barLb + boardWeightLb
resistance  = inclineLoad * sin(angleDeg) * pulleyFactor + directLoadLb
```

- `pulleyFactor` = **0.5** for cable exercises, 1.0 for anything pressing directly off the
  board. Total Gym's charts state this explicitly: *"If the pulley cables are used in the
  exercise, use 50% of the charted numbers."*
- `bodyFraction` accounts for exercises that put only part of you on the board (seated,
  kneeling, one foot braced). A vest tracks `bodyFraction` because it is strapped to the body;
  the weight bar does not, because it is bolted to the glideboard.
- `directLoadLb` covers any accessory that loads the cable without riding the incline. Nothing
  in Total Gym's lineup appears to do this, so it defaults to 0 — the term exists so the model
  need not be reshaped if something does.

### How `boardWeightLb` was derived

Total Gym's published charts are **not** a flat percentage of bodyweight — the implied ratio
drifts across the row (on the 8-level chart at level 5, a 50 lb person gets 42% and a 250 lb
person 31%). Regressing each row against bodyweight gives:

- **slope == `sin(angleDeg)`** to three decimals at every level, and
- a **constant non-zero intercept**, whose value divided by `sin(angleDeg)` is stable across all
  levels of a profile.

That intercept is the glideboard's own mass riding the incline with the user. It is ~23 lb for
the 6/8/12-level profiles and ~19.8 lb for the 14-level — so **`boardWeightLb` belongs on the
rail profile, not as a global constant.** Accuracy is ±1 lb because the charts round to whole
pounds.

Verification, 14-level profile at 180 lb, level 14:
`(180 + 19.8) x sin(25.5°) = 86.0` — the published chart says 86.

### Copyright posture

We ship a **physical model validated against published figures as facts**, not a copy of their
tables. Facts and ideas are not copyrightable (17 U.S.C. § 102(b)), and *Feist v. Rural
Telephone* (1991) eliminated "sweat of the brow" protection for fact compilations. This also
extrapolates: any bodyweight, any angle, including calibrated angles from machines Total Gym
never charted.

Related: **exercise names** are unprotectable short phrases (37 C.F.R. § 202.1(a)), and exercise
*routines* are unprotectable systems or methods (*Bikram's Yoga College v. Evolation Yoga*,
9th Cir. 2015). **Do not** copy their photographs, illustrations, instructional prose, or a
curated program's selection and arrangement wholesale.

## Rail profiles

Data lives in [`data/rail-profiles.json`](../../data/rail-profiles.json).
**Profiles key on level count (rail geometry), not model name** — Total Gym publishes charts by
level count, and models are just labels pointing at a profile.

| Profile | Board (lb) | Angles |
|---|---|---|
| 6-level | 23.0 | 6.0 … 26.0 |
| 8-level | 23.0 | 5.2 … 25.8 |
| 10-level | 15.5 | **derived — see below** |
| 12-level (FIT) | 23.0 | 5.2 … 26.0 |
| 14-level (FIT Anniversary) | 19.8 | 6.6 … 25.5 |

### ⚠ The 10-level chart's angle column is wrong

Its printed angles (5.2, 10.6, 12.5, 14.3, 16.2, 18.0, 19.9, 21.8, 23.8, 25.8) are the
**12-level list with two entries deleted**, and they do not reproduce the chart's own resistance
numbers. Level 5 is printed as 16.2° (sin 0.279) but its row regresses to slope 0.240 (13.9°).
First and last levels match; the middle is misaligned — consistent with an editing error in the
PDF.

`rail-profiles.json` carries angles back-solved from the resistance columns via `asin(slope)`,
which produces a smooth, plausible progression. **Marked `verified: false` — needs tape-measure
confirmation on a real 10-level machine before shipping.**

### Angle calibration

Ship measured defaults; let users override via **phone-as-inclinometer** (`<tg-angle-calibrator>`,
lay the phone on the rail, read `DeviceOrientation`). This reuses the motion permission flow from
[0006](0006-rep-sources.md) and dissolves the data-sourcing problem for any machine, including
future models. Calibrations are user data on the sync-ready schema.

**Framing:** this is a *training-load index*, not a certified measurement. Repeatability matters
far more than absolute accuracy — a consistently 8%-high number still drives every progression
decision correctly.

## Snapshot rule

**Never compute historical resistance live.** Three inputs drift underneath you: the user's
bodyweight, their calibration, and our own profile data if corrected in an update. A `SetLog`
storing only `{level, exerciseId}` means a user who loses 20 lb sees their entire history
retroactively drop and every PR silently rewrite.

```
SetLog {
  id, ts, exerciseId, level, reps,
  bodyweightRawLb, bodyweightSmoothedLb,   // smoothed value feeds the calc
  angleDeg, boardWeightLb, pulleyFactor, bodyFraction,
  vestLb, barLb, directLoadLb,
  computedLb,                              // denormalised result
  formulaVersion                           // makes migration deliberate
}
```

Same reasoning as an invoice storing price at purchase rather than a foreign key to products.
Recalibration then affects future logs only, and "recompute my history" becomes an explicit
opt-in migration.

**Bodyweight is snapshotted once per session** on the session envelope, then copied down to each
set — otherwise a mid-workout weigh-in makes sets within one session incomparable.

## Schema

```
RailProfile { id, levelCount, angleDeg[], boardWeightLb, angleSource, verified }
Machine     { id, modelName, railProfileId, calibratedAngles? }
Exercise    { id, name, usesPulley, bodyFraction, attachment?, muscles[] }
Equipment   { id, kind: 'vest'|'bar'|'plate', lb, ridesIncline, ownedQty }
```

`bodyFraction` values are currently unmeasured and all default to 1.0.

## Consequences: what the unified `computedLb` unlocks

**Level step sizes are near-uniform in pounds but wildly non-uniform in percentage.** On the
14-level profile at 180 lb, every step is ~4.9 lb — but that's a **21% jump** from level 1→2 and
only **6%** from 13→14.

Progression lever selection therefore is:

- **Levels 1–4** — 15–21% per step, too coarse. Use added weight to micro-step.
- **Levels 5–13** — 7–10% per step. Prefer level increases.
- **Level 14 (max)** — no choice; added weight only.

**Added weight is heavily discounted by the incline**, and users will not expect it. At level 8
(16.5°) a 10 lb vest adds `10 x sin(16.5°)` = **2.8 lb**; a 20 lb vest adds 5.7 lb ≈ one level.
On a cable exercise, halve it again. The UI should just say so.

Plates on the weight bar are undiscounted relative to bodyweight in the sense that they are the
only *fine* increment available, so the coach can compute an achievable load ladder from owned
equipment and suggest the smallest real step.

**Bodyweight change moves load in both directions**, which is the sharpest problem in the app:

| Change | Absolute load | Relative load | Honest reading |
|---|---|---|---|
| Cut | ↓ | flat | maintained strength — success |
| Cut | flat | ↑ | genuinely stronger |
| Bulk | ↑ | flat | heavier, not stronger |
| Bulk | ↑ | ↑ | real gains |

Dropping 180 → 160 lb at level 8 costs 5.7 lb of resistance — **more than a full level, from
succeeding at a diet.** Gaining 180 → 195 lb at level 10 *adds* 5.0 lb while relative load
stays flat at 0.368 → 0.366.

**The compensation rule is exact and 1:1.** Bodyweight and added weight sit in the same term
multiplied by the same `sin(θ)`, so offsetting N lb of bodyweight loss takes exactly N lb of
vest or bar, at any level on any machine.

This makes the dual-axis load-and-bodyweight chart **required infrastructure, not a nice-to-have**
— it is the only honest read for anyone whose weight is deliberately changing. Handling is in
[0010](0010-goals-and-training-phase.md).
