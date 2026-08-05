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

### The catalog is ours, not a copy of the training deck

Total Gym sells a deck of 80 exercise cards. Reproducing the *names* would be fine on the
authority above; reproducing the deck's **selection and arrangement** is the one thing the
paragraph above says not to do, and it is also not possible — no public source enumerates the
deck. Searching finds the product listing and its advertised categories (chest, back,
shoulders, arms, legs, abs, total body, stretch) and nothing more.

So [`data/exercises.json`](../../data/exercises.json) is built from what the machine actually
supports, organized under those categories. Overlap with their deck is inevitable and expected
— a chest press is a chest press — but the selection is ours, every cue is written from
scratch, and the card numbering is not reproduced.

This is the honest position anyway: each entry needs `usesPulley` and `bodyFraction`, and a
transcribed name with a guessed pulley flag would silently halve or double the recorded load
for every set of that movement.

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
which produces a smooth, plausible progression, and stays `verified: false`.

**No longer an open item.** Back-solving from the resistance columns is the better source
anyway: the resistance numbers are what the trainee actually feels, and they reproduce exactly,
while the printed angle column demonstrably does not reproduce its own table. A tape measure
would confirm a figure the app does not use in preference to one it does. Anyone who owns a
10-level machine and disagrees with the numbers can measure their own rail with the angle
calibrator below, which is the general answer to this whole class of problem.

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
  computedLb,                              // denormalized result
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
Exercise    { id, name, usesPulley, peakTension, setup{position,facing,grip}, bodyFraction,
              typicalLevel, attachment?, muscles[] }
Accessory   { id, name, provides[], common, added, note? }
Equipment   { id, kind: 'vest'|'bar'|'plate', lb, ridesIncline, ownedQty }
```

### The generated demo, and why it is gone

`setup` once also drove a generated stick-figure animation, on the reasoning that a drawing
derived from the catalog costs nothing to ship and cannot drift from the instructions beside it.
It was withdrawn after four rounds of correction: limbs animating off the figure, the board
travelling the wrong way, a leg moving on its own, and finally a seated trainee drawn with their
legs behind them, which reversed the chest press.

The reasoning was not wrong — the last version was correct and had assertions over all 103
movements holding it that way. The problem is what it cost to get there. **A schematic is either
right enough to trust or worse than nothing**, because a trainee who believes the picture over
the sentence has been actively misled, and every round of review passed a drawing that looked
plausible and was wrong. The written setup carries the same four fields in a sentence, it has
been right longer, and nobody has to squint at it to check.

The lesson is narrower than "do not generate drawings": it is that a derived artifact needs a
cheap way to be *checked*, and for prose a human reading it once is that check, while for a
diagram it is not.

Seated, the direction follows the cable: you face the tower for what you **pull** and away for
what you **push**, because the cable comes off the top of the tower. That is a rule of thumb, not
a law — anything that moves where the cable meets the trainee breaks it, and the prone pushdown
does exactly that, facing the tower while still being a push. A test pins that exception, because
a table that never broke the rule would mean nobody had looked.

**The squat stand is at the bottom of the rail**, so feet on the stand puts the head at the tower
end — the same way round as the cable work, not the opposite way. That is a fact about the
machine rather than a judgment about a movement, so the generator asserts it: every squat-stand
exercise faces the tower, and a hand edit that says otherwise fails the build rather than quietly
adding a turnaround to every leg session.

**Nothing happens off the board.** There is no standing position — even the dips use the
glideboard — and a model with one in it would have the session ordering budget for a changeover
that never happens. Positions are face-up, face-down, seated, kneeling and side-lying; `facing`
is the tower end or the floor end, which reads as where the head points when lying and which way
the trainee turns when seated. Sitting, it follows the cable: you face the tower for everything
you **pull** and away from it for everything you **push**.

`setup` does two jobs from one field: it is what the app tells the trainee about arranging
themselves on the machine, and it is what decides which movements can be done back to back without
rebuilding it (docs/adr/0007). Keeping them off one field is the point — if the ordering believed
two movements shared a setup while the instructions said to turn around between them, one would be
lying and nothing would say which. Like `bodyFraction`, these are reviewable judgments rather than
measurements.

### Accessories are a separate vocabulary from `attachment`

An exercise names a **capability** (`"Wing attachment"`); the trainee owns a **product**
(`"Wing attachment (two-piece)"`). The wing shipped in one-piece and two-piece versions that do
exactly the same job, so an exercise naming the product would hide pull-ups from every owner of
the other one. `Accessory.provides` is the join, and it is many-to-one on purpose.

`Accessory.added` records the registry version an accessory first appeared in, and the stored
answer records the version it answered (`SettingsRecord.equipmentVersion`). **Silence is not a
no**: an accessory newer than the version the trainee answered counts as owned until they say
otherwise. Without that rule, adding an accessory retroactively reinterprets every stored answer
as a "no" to a question nobody was asked, and shipping a release quietly deletes exercises from
people's pickers — including ones they have logged for months and ones their own program plans.
This is the same reasoning that makes *unconfigured* mean "show everything" rather than
"owns nothing", applied to each subsequent addition.

An accessory may unlock **nothing** — the weighted vest and the weight bar add load to exercises
that already exist. They are accessories anyway, because the set logger asks for vest and bar
weight on every set, and asking someone who owns neither puts two permanently-zero fields on the
one screen that has to stay fast.

`Accessory.common` marks what ships with most machines. It never filters — it groups the picker,
and it is what the shipped program templates are held to, so a template is runnable on a stock
machine rather than being a plan the trainee discovers they cannot follow one exercise at a time.

`bodyFraction` values are estimated, not measured. They follow the position: lying work puts
essentially all of the trainee on the board, seated work about 85% of them. When a movement's
position is corrected, its `bodyFraction` has to move with it — the pressing family carried a
lying figure while it was assumed supine, which overstated every chest load by about an eighth.

Correcting one is a deliberate act, not a side effect. Logged sets keep the snapshot they were
computed with (above), so history is unaffected and correct; what changes is every load computed
*from now on*, which reads as a step down that the trainee did not train for. Worth doing when the
old figure was wrong, and worth doing knowingly.

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
