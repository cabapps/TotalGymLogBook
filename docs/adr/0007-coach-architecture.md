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

The obvious answer is "it needs a programme". It does not, and waiting for one was the mistake.

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

A programme, when it arrives, makes this better — it can say what is next *before* the trainee
picks — but it was never a prerequisite.

### Terminology, corrected against the literature

Worth writing down, because the everyday usage and the textbook usage differ in one place that
matters for the data model:

- **Split** — how the body's musculature is divided across sessions. *Full body, upper/lower,
  push-pull-legs are splits, not programmes.* This is the correction: they describe only the
  division of work.
- **Programme** — the split *plus* exercise selection, set and rep prescription, and a
  progression scheme. PPL alone does not tell you what to do on Monday.
- **Microcycle** — the repeating block, conventionally a week. "Week" is the right word for the
  UI; the term is only useful for knowing that the one-week assumption is a convention and not
  a law.
- **Session** — correct as-is.
- **Weekly sets per muscle** — the accepted unit of training volume in the hypertrophy
  dose-response work, counting hard sets taken near failure. Not tonnage, not time, not
  sessions. The framing of "hit every major muscle group for a target number of sets by the end
  of the week" is exactly right and is the modern mainstream view.

One implication for [Slice B](README.md): **order the programme by rotation, not by calendar.**
Day-of-week scheduling breaks the first time someone trains on Tuesday instead of Monday, and a
home-gym population misses days constantly. "Next session in the rotation" degrades gracefully;
"it's Wednesday, do legs" nags.

Frequency falls out of the split rather than needing its own setting. Total weekly volume is
what drives growth; frequency mostly distributes it, with roughly twice a week per muscle a
reasonable default because it is easier to do 12 quality sets across two days than one.

## Consequences

`TrainingGoal` and `Phase` are short, high-signal context that keep a small model on-topic far
more effectively than prompt engineering.

Tier 1 and Tier 2 are strictly optional. The app is fully functional as a coach with neither.
