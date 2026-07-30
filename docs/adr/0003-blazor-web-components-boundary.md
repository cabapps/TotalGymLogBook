# 0003 — Blazor ↔ Web Components boundary

**Status:** Accepted

## Context

Blazor WASM cold start is 1–3 seconds. Vanilla web components paint immediately. The app's core
interaction — logging a set between exercises — must be instant.

The obvious split ("web components = presentation, Blazor = logic") fails: the set logger would
paint in 200 ms but be unable to *record* anything until the runtime boots. That is worse than a
spinner, because users tap it and lose input.

## Decision

> **TypeScript owns the write path. Blazor owns everything derived from it.**

Logging a set is an append of an immutable record — UUID, timestamp, exercise, level, reps —
with no domain logic involved, so TypeScript can do it milliseconds after first paint.
Everything requiring the domain model (progression, PRs, volume trends, charts, coaching) is a
*derivation*, and derivations can arrive late without anyone noticing.

Effectively CQRS with the command side in TypeScript and the query side in .NET.

**TypeScript owns IndexedDB exclusively.** Blazor never opens the database; it calls into
`db.ts` via `[JSImport]` and receives JSON. One data-access layer, one migration path, no
two-drivers-disagreeing class of bug.

### Assignment

| Web Components (instant tier) | Blazor (capable tier) |
|---|---|
| App shell, tab bar, splash | Progression / coach engine |
| `<tg-set-logger>` | History, analytics, charting |
| `<tg-rest-timer>` | Routine builder |
| `<tg-session-list>` | Import / export / backup |
| `<tg-angle-calibrator>` | `ICoach` implementations |
| Primitives (button, sheet, toast, chip, stepper) | Future sync / conflict resolution |
| `db.ts` — the IndexedDB layer | |

### Boot sequence

1. `index.html` ships inline critical CSS plus the shell ES module. First paint immediately.
2. TypeScript opens IndexedDB and renders today's session. **The app is fully usable for
   logging at this point** — this is the moment that matters.
3. Blazor starts *after* step 2, not in parallel:
   `<script src="_framework/blazor.webassembly.js" autostart="false">` then call
   `Blazor.start()` manually. Autostart contends with first paint for the main thread.
4. Blazor signals ready; skeleton placeholders fill in with suggestions, charts, coaching.
5. Nothing in steps 1–2 ever awaits step 3.

### Interop contract

1. **`[JSImport]`/`[JSExport]`, not `IJSRuntime`** — direct marshalling, no JSON round-trip
   through the dispatcher.
2. **The boundary carries IDs and JSON strings, never live object references.** TypeScript
   says "session `abc123` changed"; Blazor re-reads via `db.ts`. No object-graph marshalling,
   no duplicate source of truth.
3. **One typed event bus** — a single `EventTarget` Blazor subscribes to once, not JSInterop
   calls scattered across components. Also carries `BroadcastChannel` cross-tab events
   (see [0005](0005-session-state-ownership.md)).
4. **Any custom element Blazor renders must be attribute-driven, not property-driven.** Blazor's
   renderer sets *attributes* and will not set JS properties. Elements needing structured data
   take an ID and fetch it. This one fails silently.
5. **Partition the DOM by owner.** Blazor renders into its own roots; the shell lives outside
   them. Shadow DOM for encapsulation, with CSS custom properties and `::part()` exposed so
   both tiers consume identical design tokens.

## Consequences

Two pieces of logic that "should" be in .NET are in TypeScript instead, because the load-time
principle outranks the complexity principle:

- **The resistance calculator** must update live as the level selector moves. Implemented in
  both languages from one JSON source of truth, with a parity test
  ([0004](0004-domain-model-and-resistance.md), [0009](0009-repo-structure-and-build.md)).
- **Rep detection** is a 60 Hz stream needing low latency and pre-boot availability
  ([0006](0006-rep-sources.md)).

## Rejected

**Blazor's `RegisterCustomElement`** — exposing Blazor components *as* custom elements. It
inverts the dependency: those elements cannot render until the .NET runtime boots, which is
precisely what this split exists to avoid.
