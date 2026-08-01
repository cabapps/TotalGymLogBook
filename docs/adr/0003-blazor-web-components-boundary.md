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

### Ownership is not adjacency: slot the derived tier in

Read literally, rule 5 produces sibling regions — shell, then Blazor — and that is what shipped
first. It put the coach and the history below the data-safety card, at the bottom of a page the
trainee had already stopped scrolling. Everything worked and nobody saw it.

`#blazor-root` is now a **light-DOM child of `<tg-app-shell>`**, projected through
`<slot name="derived">` between the Finish button and the data card. Ownership is unchanged —
Blazor still renders into that element and nothing else, the shell still never touches its
contents — but the shell now decides *where on the page* it appears.

Light DOM is what makes this safe, and it is the whole trick:

- The shell rewrites its **shadow** root on every screen change. A light child is untouched by
  that, so the .NET runtime can boot into it whenever it arrives, whatever the shell is showing.
- `document.querySelector('#blazor-root')` still resolves, so `RootComponents.Add<App>` needs no
  change.
- On screens with no matching slot — onboarding, the resume prompt — the child is simply not
  rendered. Hiding the coach mid-onboarding falls out of the platform rather than needing a
  flag.

The failure mode is silent in the other direction: drop the slot, or rename it on one side, and
the content still exists in the DOM while rendering nowhere. `e2e/driver.mjs` therefore asserts
*position* (`#blazor-root` sits between `#finish` and `tg-data-safety`), not presence, and
`publish-smoke.sh` greps both halves of the name out of the published output.

### The deferred boot must not use `requestIdleCallback` unguarded

Step 3 above starts Blazor manually from an idle callback, so the shell paints first. That was
written as:

```js
requestIdleCallback?.(startBlazor, { timeout: 1000 }) ?? setTimeout(startBlazor, 0);
```

which is wrong in a way that reads as careful. **Optional call guards a null or undefined
VALUE. It does not guard an UNDECLARED IDENTIFIER** — that is a `ReferenceError`, thrown while
evaluating the expression, which kills the module before `Blazor.start()` is reached.

**Safari has never shipped `requestIdleCallback.`** Not "recently", not "on old versions" — it
is still behind a preference in Technology Preview. So the derived tier had *never once booted
on an iPhone or iPad*. The shell is a separate script and kept working perfectly, so the app
looked healthy: it just silently had no coach and no history on every WebKit device.

Use `typeof requestIdleCallback === 'function'`, and fall back to a short `setTimeout`.

Two things made this survive as long as it did, and both are now closed:

- **Every automated check runs headless Chromium, where the global exists.** `driver.mjs` now
  runs a second pass in a context with `requestIdleCallback` deleted, which reproduces the trap
  exactly. Verified in both directions — it fails with `requestIdleCallback is not defined` when
  the old line is restored.
- **A boot failure had no way to report itself.** A phone has no console, and the shell keeps
  working, so nothing anywhere said the runtime had died. `index.html` now catches both the
  synchronous throw and the `Blazor.start()` rejection, and writes the message into
  `#blazor-root` — which, being slotted, puts it exactly where the coach should have been.

The general lesson is narrower than "test on real devices" and more useful: **a platform check
that cannot fail on your test platform is not a check.** The suite was thorough and completely
blind here, because the only browser it ever ran was the one where the bug does not exist.

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
