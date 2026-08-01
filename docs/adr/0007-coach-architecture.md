# 0007 — Coach architecture and AI tiering

**Status:** Accepted

## Context

An "AI coach" is a headline feature, but the app must work offline
([0001](0001-persistence-and-backend-posture.md)) and cost nothing to run. Meanwhile the guidance
users actually need — what level next, are you close to failure, have you neglected pulling — is
deterministic.

## Decision

**Three tiers behind one interface, over a shared fact base, with capability negotiation.**

```csharp
record CoachContext(
    TrainingGoal Goal,             // see 0010
    Phase Phase,                   // see 0010
    ExerciseHistory History,
    BodyweightTrend Trend,
    EquipmentInventory Equipment,
    RailProfile Profile);

interface ICoach {
    CoachTier Tier { get; }
    Task<Guidance> NextSetAsync(CoachContext ctx);
    Task<string> AnswerAsync(string question, CoachContext ctx);
}
```

### Tier 0 — deterministic rules (always available, ship first)

Pure C# in `TotalGymLogBook.Domain`. Progressive overload, plateau detection, volume trends,
muscle-group balance, rest-day suggestions, bodyweight-loss compensation
([0004](0004-domain-model-and-resistance.md)), the achievable load ladder from owned equipment.

Runs offline, deterministic, unit-testable, zero download. **This is ~80% of what users will
experience as coaching.**

### Tier 1 — on-device small language model (opt-in)

Preference order:

1. **Prompt API** (`LanguageModel`) — shipped in Chrome 148 (May 2026) and Edge, using the
   browser's built-in model. **Zero download.** Try this first.
2. **WebLLM + WebGPU** — 0.5–3B models at Q4. WebGPU reached W3C candidate recommendation in
   March 2026 and is past 84% support.

WebLLM costs a 500 MB–2 GB model download. Make it explicitly opt-in ("Download offline coach —
1.1 GB"), never automatic, and check `navigator.storage.estimate()` first
([0008](0008-service-worker-and-offline.md)).

### Tier 2 — cloud (bring-your-own-key)

Best quality, needs network. The user supplies their own API key, stored locally, called directly
from the browser. **Never ship our own key** — it is fully extractable from a WASM bundle.

### The rule that makes the AI tiers safe

> **Tier 0 always runs and always produces the numbers. Higher tiers only narrate them or answer
> freeform questions.**

An LLM never overrides a computed progression. A hallucinating 1B model can therefore produce
awkward prose, but it can never tell someone to jump three levels — the only failure mode that
actually matters. Feed the model Tier-0's computed facts as context rather than raw history.

Degradation between tiers is invisible: same interface, same fact base, capability-negotiated
implementation.

## Two questions, not one

The coach answers two different questions and they need different machinery, different data,
and different placement on screen:

| | Question | Engine | Unit | Scope |
|---|---|---|---|---|
| **Set** | "What should this set be?" | `ProgressionEngine` | reps, level, added weight | one exercise |
| **Session** | "What's missing?" | `SessionAdvisor` | sets per muscle per week | whole body |

The first shipped pinned to a hardcoded `chest-press`, which made it actively wrong the moment
anyone trained anything else — it would advise a notch increase on the press while the trainee
stood at the squat stand. The engine was always per-exercise; nothing ever told it *which*.

### The coach does not need to predict the next exercise

The obvious answer is "it needs a program". It does not, and waiting for one was the mistake.

**The trainee has already said.** They pick the exercise in the set logger before the first
rep, so the selection *is* the answer, available with no prediction, no schedule, and no
model. `src/client/src/focus.ts` publishes it and the derived tier follows it live.

That state is deliberately **not persisted**: it is in-flight UI state per
[0005](0005-session-state-ownership.md), and writing it to IndexedDB on every flick of a
dropdown would push UI churn into a log designed to sync. It is also not broadcast to other
tabs — a second tab's dropdown is not this trainee's next set.

It rides the existing change bus as a `focus` topic rather than a second `[JSImport]`
subscription, which keeps [0003](0003-blazor-web-components-boundary.md) rule 3's
one-bus contract. `Logbook` special-cases it to *not* drop the history cache, or scrolling the
selector would refetch the entire logbook per option.

A program, when it arrives, makes this better — it can say what is next *before* the trainee
picks — but it was never a prerequisite.

### Terminology, corrected against the literature

Worth writing down, because the everyday usage and the textbook usage differ in one place that
matters for the data model:

- **Split** — how the body's musculature is divided across sessions. *Full body, upper/lower,
  push-pull-legs are splits, not programs.* This is the correction: they describe only the
  division of work.
- **Program** — the split *plus* exercise selection, set and rep prescription, and a
  progression scheme. PPL alone does not tell you what to do on Monday.
- **Microcycle** — the repeating block, conventionally a week. "Week" is the right word for the
  UI; the term is only useful for knowing that the one-week assumption is a convention and not
  a law.
- **Session** — correct as-is.
- **Weekly sets per muscle** — the accepted unit of training volume in the hypertrophy
  dose-response work, counting hard sets taken near failure. Not tonnage, not time, not
  sessions. The framing of "hit every major muscle group for a target number of sets by the end
  of the week" is exactly right and is the modern mainstream view.

**Order the program by rotation, not by calendar.**
Day-of-week scheduling breaks the first time someone trains on Tuesday instead of Monday, and a
home-gym population misses days constantly. "Next session in the rotation" degrades gracefully;
"it's Wednesday, do legs" nags.

Frequency falls out of the split rather than needing its own setting. Total weekly volume is
what drives growth; frequency mostly distributes it, with roughly twice a week per muscle a
reasonable default because it is easier to do 12 quality sets across two days than one.

## Programs, as built

Three built-in templates in [`data/programs.json`](../../data/programs.json) — Full Body,
Upper/Lower, Push/Pull/Legs — each a **rotation of sessions**, each session an ordered list of
movements with a set target. No day-of-week appears anywhere in the schema, which is the
rotation decision made structural rather than merely intended.

### The rotation is derived from history, never stored

A cursor ("you are on session 2") drifts the instant anyone trains out of order, skips a
session, or logs on a second device — and it drifts *silently*, so the app carries on
confidently naming the wrong day. So a workout started from a program stamps `programId` and
`programSessionId` onto its session record, and "what is next" is read back off that: the
session after the most recent one logged, wrapping.

History cannot disagree with reality, because it is what happened. It also degrades correctly
in the two cases a cursor handles worst: a session edited out of the program restarts the
rotation instead of pointing at nothing, and workouts logged outside the program are ignored
rather than advancing it.

### Split across the tiers along the usual line

| | Where | Why |
|---|---|---|
| Which session is next, tick-off progress | TypeScript | Drives the exercise picker, so it has to work before the runtime exists ([0003](0003-blazor-web-components-boundary.md)) |
| Whether the program is any *good* | .NET | Reuses the volume machinery, and can arrive late |

`ProgramAnalyzer` applies exactly the accounting `VolumeLedger` uses — per muscle, indirect work
at half a set — to a **plan** rather than to history. So a trainee can see that a split gives
their calves three sets a rotation *before* running it for six weeks and wondering why.

That paid for itself immediately: pointed at the templates shipping in the same commit, it found
calves at 2 sets in Full Body and calves and core at 3 in Push/Pull/Legs. All three now clear
the effective dose, and a test asserts it so the next edit to the data cannot quietly undo it.

### Untrained is a choice; under-dosed is a gap

The first version warned about any muscle at zero, which made the app wrong about all three of
its own templates — hardly any real program isolates the adductors, and saying so as a defect is
just noise. A muscle the program *does* train but leaves at two sets is a different claim
entirely: the intent is there and the dial is set too low.

So they are reported separately, which is also the line [0010](0010-goals-and-training-phase.md)
already drew for logged history. Two features making opposite claims about the same idea would
be worse than either choice on its own.

### The plan suggests; it never constrains

Tapping a planned movement selects it in the logger. That is the whole interaction. The picker
still offers the full catalog, the tick list counts sets logged *today* rather than sets against
this session record — closing the app mid-workout starts a new record but is obviously the same
workout to the trainee — and doing four sets where the plan said three is not an error.

### The trainee builds and edits their own

`<tg-program-editor>` is in the **shell**, not Blazor, for the reason everything that writes is:
IndexedDB is TypeScript's and the derived tier is read-only (0003, 0009). That forces a second
implementation of the per-muscle volume accounting in `programs.ts`, mirroring
`ProgramAnalyzer.WeeklySets` — paired tests on both sides assert the same figures for the same
shipped template, the same way the resistance calculator is kept honest.

**The volume moves while you choose.** The coach can already tell a trainee that a finished
program leaves their biceps short, but that is the wrong moment — by then they have committed, and
acting on it means coming back to edit. Showing sets-per-muscle *during* the edit turns the
effective dose from a verdict into a dial they can watch themselves move.

**Nothing in the editor blocks.** A program that ignores a muscle group saves like any other; the
gap is named and the decision stays the trainee's. Real programs skip muscles on purpose, and an
app that refuses to save one is wrong more often than the trainee is. Same line as *untrained is a
choice; under-dosed is a gap*, above.

**Ranked, never filtered.** The movement list is ordered by what the trainee is training for
(0010) and still contains everything. A movement that scores badly for their goal may be exactly
what they want for a reason the app cannot see.

## Consequences

`TrainingGoal` and `Phase` are short, high-signal context that keep a small model on-topic far
more effectively than prompt engineering.

Tier 1 and Tier 2 are strictly optional. The app is fully functional as a coach with neither.
