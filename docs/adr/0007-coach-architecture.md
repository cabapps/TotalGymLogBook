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

## Consequences

`TrainingGoal` and `Phase` are short, high-signal context that keep a small model on-topic far
more effectively than prompt engineering.

Tier 1 and Tier 2 are strictly optional. The app is fully functional as a coach with neither.
