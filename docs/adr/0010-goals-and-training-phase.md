# 0010 — Training goals and energy phase

**Status:** Accepted

## Context

Coaching guidance is meaningless without knowing what the user is training for. But
[0004](0004-domain-model-and-resistance.md) established that bodyweight change moves computed load
in both directions, so the coach also needs to know whether bodyweight is *deliberately* changing —
otherwise it misreads a successful diet as regression, or a bulk as strength gain.

The audience includes complete beginners. Fitness jargon is a retention risk.

## Decision

### Two orthogonal axes, not one goal list

**Training goal** — what the program is *for*. **Energy phase** — what the body is *doing*.

```csharp
record TrainingGoal(GoalType Primary, GoalType? Secondary);  // hypertrophy | strength | aerobic | rehab
record Phase(EnergyBalance Balance, DateOnly StartedOn, decimal? TargetRateLbPerWk);
enum EnergyBalance { Unknown, Deficit, Maintenance, Surplus }
```

Hypertrophy + deficit is a cut. Hypertrophy + surplus is a bulk. Bulk/cut cycling is just phase
history — no special-casing.

**Goals are not mutually exclusive.** "Lose fat and build muscle" is the most common real-world
pairing, so primary drives the rule set and secondary adjusts emphasis.

**Rehab is a first-class goal.** Total Gym has a large physical-therapy install base, and that
user wants range-of-motion and consistency tracking with progression explicitly *de-emphasized* —
a coach nagging them to add load would be actively harmful.

### Weight loss is a phase, not a training style

Circuit training buys slightly higher session energy expenditure, but fat loss is driven by the
energy deficit, not the modality. The actual job of resistance training in a deficit is
**preserving lean mass**, which requires mechanical tension and meaningful loads — precisely what
short-rest circuits compromise. **So a weight-loss user gets a hypertrophy program.**

What changes is not the training style but four other things:

1. **Progression expectations** — deficit: hold load, don't chase PRs. Maintenance: steady
   progression. Surplus: faster progression.
2. **Volume caution** — recovery capacity is reduced in a deficit, so be *more* conservative about
   adding volume, not less.
3. **Proximity to failure** — leave slightly more in reserve during a deficit; repeated failure
   training on impaired recovery is counterproductive.
4. **Bodyweight compensation** — the 1:1 deficit-closing rule from
   [0004](0004-domain-model-and-resistance.md) fires only when it should.

### Goal parameters

| Goal | Reps | Proximity to failure | Rest | Progression lever | Progress metric |
|---|---|---|---|---|---|
| Hypertrophy | 6–20 | close (0–3 RIR) | 60–120 s | **reps, then load** | absolute load |
| Strength | 3–6 | 1–3 RIR, rarely failure | 2–5 min | reps, then load | absolute load |
| Aerobic | 15–30+ | moderate | 30–60 s | density | work ÷ time |
| Rehab | as prescribed | well short | as needed | range of motion | consistency |

**The progress metric is a function of goal and phase**, which resolves the tension found in
[0004](0004-domain-model-and-resistance.md): a weight-loss user's home screen foregrounds session
frequency, total work, streaks, and bodyweight trend — not load.

> **Corrected 2026-07-30 during implementation.** This table originally said the hypertrophy
> lever was "load, then reps" and its progress metric was "weekly sets per muscle". Both were
> wrong:
>
> - **The order is reps, then load.** Double progression — work up the rep range at a fixed
>   load, then step the load and reset to the bottom. On this machine a level step is ~5 lb and
>   8–10%, so stepping load first would crater reps every cycle.
> - **Weekly sets per muscle is not a progression metric.** Set count is a *program*
>   parameter: it changes when experience or recovery capacity changes, not session to session.
>   See "Volume is programming, not progression" below.

## Volume is programming, not progression

Reps and load move every session. Sets move when the program changes. Conflating them puts a
slow-moving parameter under a fast-moving algorithm, so `ProgressionEngine` deliberately does not
touch set count — it has three levers (reps, level, added weight), and volume is tracked
separately by `VolumeLedger` as a monitored metric.

### A stretch is not a set

The catalog carries `kind`: `strength` counts toward weekly volume, `stretch` does not.

Without it, adding ten stretches to the catalog would have silently inflated every muscle's
weekly set count — and the failure is worse than cosmetic, because it runs the wrong way. The
coach would tell a trainee their hamstrings were covered *because they stretched them*, and
then stop suggesting the hamstring work they actually needed. `SessionAdvisor` also refuses to
offer a stretch as the fix for a volume gap, for the same reason.

### Sets are counted fractionally per muscle

Total Gym work is unusually compound, so a raw set count is meaningless. One set of chest press
is 1.0 for chest but 0.5 each for triceps and front delts. Counting indirect work at full weight
badly overstates arm volume; counting it at zero hides real work. `MuscleInvolvement` carries the
fraction (1.0 direct, 0.5 indirect).

### There is no upper bound

Weekly targets scale with experience and have a floor but **no ceiling**:

| | Recommended weekly sets per muscle |
|---|---|
| Minimum effective dose (all levels) | **4** |
| Novice | 8 |
| Intermediate | 14 |
| Advanced | 20 |

Four sets is a genuine floor rather than a conservative guess — meta-analysis puts meaningful
hypertrophy below five sets weekly — and the dose-response keeps climbing well past any figure
this app could justify enforcing.

**No ceiling is a deliberate product decision**, for two reasons. The app cannot observe recovery
(sleep, stress, joint health, life load), so it is in no position to tell anyone they are doing
too much. And under-training, not over-training, is overwhelmingly the failure mode in a home-gym
population. The ledger reports gaps and neglect; it never warns about excess.

### How the deficit rule survives this

[Above](#weight-loss-is-a-phase-not-a-training-style) commits to being *more conservative about
volume in a deficit*. With no ceiling, that cannot mean a cap. It resolves as: **a deficit stops
recommending increases rather than imposing a limit** — the recommended target scales down (never
below the effective dose), and the trainee holds volume steady while recovery capacity is reduced.

### Experience level is inferred, not asked

Same principle as phase. Someone with three weeks of logs is a novice regardless of what they
claim, and training age is derivable from weeks logged, consistency, and how quickly progression
has stalled. Available as an advanced override alongside the phase override.

**Implemented as distinct training days, not calendar time** (`Logbook.GetExperienceAsync`):
under 24 is novice, under 100 intermediate, beyond that advanced. Someone who trained twice a
month for a year is not an intermediate, and weeks-since-signup would say they were.

### Surfaced, at last, by SessionAdvisor

The ledger was built and tested and then displayed nowhere, which meant every gap it could find
went unreported. `SessionAdvisor` turns the rollup into one line the trainee can act on —
*"You've put 9 sets into quads this week and 1 into biceps. 3 sets of Biceps Curl would get
biceps there."* — plus the two or three worst gaps with concrete movements against each.

Three rules it inherits and one it adds:

- **Never nag about a muscle never trained.** Skipping calves entirely is a program choice,
  not a gap. `BelowEffectiveDose` already drew that line; the advisor respects it, which also
  means a brand-new trainee sees nothing until they have trained something at least once.
- **Never warn about excess.** No ceiling exists to warn against.
- **Never suggest indirect work to fill a direct gap.** Filling a biceps gap with more rows is
  how the gap got there, so suggestions are drawn only from movements where the short muscle is
  the prime mover.
- **Prefer movements the trainee already knows.** Someone mid-workout wants the exercise whose
  setup they can already do, not an introduction to a new one.

The contrast line ("quads are fine, biceps are not") is only drawn when the two are at least
four sets apart. Comparing 4.5 against 3.5 invites fixing something that is not broken.

## Phase is inferred, never asked

Bodyweight over time is already required for the resistance formula. That same series determines
the phase, so nobody answers a question about it:

```
sustained loss > ~0.25 lb/wk  → Deficit
sustained gain > ~0.25 lb/wk  → Surplus
flat within band              → Maintenance
insufficient weigh-ins        → Unknown (coach stays neutral)
```

Self-reported intent is unreliable anyway — plenty of people who believe they are in a deficit
aren't.

### Never name the phase — describe the observation

The phase stays an internal enum; the UI speaks plainly.

| Don't say | Say |
|---|---|
| "Deficit phase — hold load" | "You're down 6 lb this month. Let's keep your lifts where they are — that's how you hold onto muscle while losing fat." |
| "Surplus phase — absolute load inflated" | "Your chest press went up 5 lb, but you're also 15 lb heavier, so most of that is the extra bodyweight rather than extra strength." |

The second delivers the entire relative-load insight with no technical terms.

### Guardrails on the inference

- **Require enough data.** At least 3 weigh-ins spanning 14 days, using the smoothed
  bodyweight from [0004](0004-domain-model-and-resistance.md). Until then phase is `Unknown` and
  the coach behaves neutrally — no compensation, no expectation-setting. Confidently wrong is far
  worse than silent.
- **Hysteresis on transitions.** Different thresholds to enter (0.25 lb/wk) and exit
  (0.10 lb/wk) a phase. Otherwise advice flips week to week and users stop believing it. Same
  debounce thinking as [0006](0006-rep-sources.md), on a much slower signal.
- **Require statistical significance.** *Added 2026-07-30 during implementation — see below.*
  The fitted rate must also exceed **2 standard errors**, or the phase stays `Maintenance`.

#### Why a rate threshold alone is not enough

A test with realistic ±3 lb daily weight noise on a *genuinely stable* user kept coming back
`Surplus`. That wasn't a bad test — the threshold was sitting on the noise floor.

Fitting a slope to 30 daily readings with ±3 lb of noise gives a standard error of
**0.257 lb/week**. The entry threshold was 0.25. Simulated over 20,000 trials, a weight-stable
user would be assigned a phase **33% of the time** — and hysteresis then makes it *worse*, because
having entered spuriously they'd be held there.

The fix is to require the rate to be distinguishable from flat, not merely large:

| Significance gate | False positives on stable weight | Real 1 lb/wk cut detected |
|---|---|---|
| none (rate only) | 33% | ~100% |
| 1.5 × SE | 13% | 99% |
| **2.0 × SE** | **~6%** | **~95%** |
| 2.5 × SE | 1% | lower |

2.0 is the chosen operating point. Missing a real cut is the worse error — the compensation rule
never fires and the user watches their numbers fall with no explanation — so the gate is set to
stay comfortably sensitive to genuine trends.

**This has a nice property:** more frequent weigh-ins shrink the standard error, so consistency
is rewarded with faster, more confident phase detection. That is a better incentive than nagging.

Both error rates are pinned by Monte Carlo tests in `BodyweightTrendTests`, so tuning the
constant cannot silently regress either direction.

This also gives an honest reason to prompt for weigh-ins — *"a current weight keeps your resistance
numbers accurate"* — rather than nagging about the scale.

## Onboarding is three questions

1. Bodyweight
2. Rail profile
3. Goal (one tap, plain language)

Everything else — equipment, secondary goal, phase override — is deferred or inferred.

**Ask "how many notches are on your rail?" rather than the model name.** The FIT and FIT
Anniversary share a name but have 12 and 14 levels respectively, and owners do not reliably know
which they have. Notch count is verifiable by looking at the machine and maps directly to the
profile that drives the math.

### Visible goals map to the internal model

| User picks | Internal |
|---|---|
| "Lose weight" | hypertrophy + expect deficit |
| "Build muscle" | hypertrophy + phase inferred |
| "Get stronger" | strength |
| "Improve endurance" | aerobic |
| "Recover from an injury" | rehab |

"Lose weight" stays visible because it is why most people buy the machine.

**The answer is stored as given, not only as its mapping.** `settings.aim` keeps the trainee's
own answer alongside the derived `GoalType`. "Lose weight" and "build muscle" both derive
hypertrophy — that part of this decision has not changed — but they are not the same request, and
a program can act on the difference. Flattening the answer at the door made that permanently
impossible: nothing downstream could tell the two apart, because by then they were the same value.

### The goal picks the movements, not just the numbers

`GoalParameters` covers reps, rest, RIR and load steps. That is the part of programming that
shows up in numbers. `ProgramEmphasis` is the part that shows up in the exercise list:

| Aim | Emphasis | What the builder leads with |
|---|---|---|
| Build muscle | `Lengthened` | movements loaded at long muscle lengths |
| Lose weight *(or an observed deficit)* | `LargestMuscles` | the biggest muscles first |
| Get stronger | `HeavyCompounds` | few movements, more sets each |
| Improve endurance | `Circuit` | whole-body work, short rests |
| Recover from an injury | `Gentle` | nothing that pulls hard into a stretch |

**Lengthened, for growth.** Loaded work at long muscle lengths grows a muscle more than the same
sets through a shortened range, and this machine is unusually good at delivering it: a cable holds
tension at the bottom of a fly where a dumbbell goes slack. So `peakTension` is recorded per
exercise and the hypertrophy templates are built out of the `lengthened` ones — a claim the tests
hold the shipped templates to, rather than a sentence in a description.

**Largest muscles, for fat loss.** Training does not burn a meaningful share of a deficit; its job
there is keeping and adding lean mass, and a pound of muscle on the quads or back does more for
resting metabolism than the same effort spent on arms. So the fat-loss emphasis ranks by
`MuscleGroups.RelativeMass` — approximate numbers whose only real claim is the ordering.

**An observed deficit counts the same as a stated one.** Someone who set out to build muscle but
has been losing weight for a month is training in a deficit whatever they intended. The stated aim
is intent, the trend is evidence, and either is enough — which is the same reasoning as the
phase-inference rules above, applied to exercise selection.

**The observed half stays in C#.** Whether the trainee is in a deficit is a phase call, and phase
calls are C#'s (below). So the shell's builder ranks by the *stated* aim only, and the coach is
what notices they have been losing weight since. The shell never quietly relabels a goal
underneath the person who set it.

### Tonnage is not a metric

The history screen used to total lifted pounds. It no longer does, anywhere. Tonnage is not
comparable across exercises — one heavy calf raise outweighs every curl anyone will ever do — so
the total tracked exercise selection more than effort, and a session could look bigger for being
easier. It is replaced by **sets per muscle**, which is the unit this document already programs
and coaches in, so the number the history shows and the number the coach quotes are the same
number.

### The yardstick follows the goal

The minimum effective dose is a hypertrophy number. `ProgramAnalyzer` applies it for the
hypertrophy, fat-loss and strength emphases and **suppresses it for circuit and rehab programs** —
holding a rehab program to a growth target has the app calling a program a failure for being
exactly what the trainee asked for.

Gaps are still *reported* under every goal. Suppressing a warning is not suppressing the fact.

### Advanced escape hatch

Settings → **Training phase: `Auto (detected)` · `Cutting` · `Maintaining` · `Bulking`**, default
`Auto`. Someone running a deliberate bulk/cut can pin it rather than wait for inference to catch
up. One row in settings, invisible to everyone else.

## Feature surfacing is declarative

```ts
Surface { id, relevantGoals: Goal[], priority: number, requires: Capability[] }
```

The home screen composes itself: filter by active goals, sort by priority, filter by available
capabilities — reusing the capability registry from [0006](0006-rep-sources.md). Adding a feature
means adding a declaration, not editing a dispatcher.

**Never hard-hide.** Goals change, and users who can't find a feature conclude the app is broken
rather than tailored. Goal drives *ordering and prominence*; everything stays reachable. The
rep-duration signal is the illustration — prominent for hypertrophy, absent from a weight-loss home
screen, still findable in set detail either way.

## Consequences for the data model

**PRs need phase tagging.** An all-time PR set at the top of a bulk may be unreachable for months
during a cut, which is quietly demoralizing. Track PRs as absolute, relative-to-bodyweight, and
scoped by phase — "best during a cut" is the comparison that motivates.

**Keep phase history, not just current phase.** It enables the useful nudges: *"You've been in a
deficit 14 weeks — consider a maintenance break,"* and *"Your relative load held flat across a
20 lb cut. That's the win."*

**The dual-axis load-and-bodyweight chart is required infrastructure**, per
[0004](0004-domain-model-and-resistance.md) — it is the only honest read for anyone whose weight is
deliberately changing.
