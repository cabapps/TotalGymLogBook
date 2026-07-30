# 0005 — Session state ownership

**Status:** Accepted

## Context

An in-progress workout must survive a reload, a backgrounded tab, a locked screen, a Blazor
restart, and the update flow from [0002](0002-hosting-domain-and-updates.md). Treating "session
state" as one blob is what produces the classic "I lost my workout" bug.

## Decision

**Decompose by durability requirement.** It's four different things:

| Category | Example | Lives in | Owner |
|---|---|---|---|
| Logged sets | the 12 reps you just did | IndexedDB, append-only | TS |
| Session envelope | started-at, machine, bodyweight snapshot, routine position | IndexedDB | TS |
| Rest timer | 90 s remaining | absolute timestamp | TS |
| In-flight UI | stepper at 11, selected exercise | `sessionStorage` | the custom element |

**Blazor owns none of it.** It reads the session through `db.ts` on demand, derives, renders, and
re-reads on the change event. That single constraint makes Blazor restartable at any instant.

Two supporting rules:

- **Write to IndexedDB on tap, never buffer in memory.** The set is durable before the button's
  animation finishes.
- **Snapshot bodyweight once per session** on the envelope, then copy down to each `SetLog`.
  Re-reading per set would make sets within one session compute against different bodyweights,
  which [0004](0004-domain-model-and-resistance.md) assumes cannot happen.

### The rest timer stores a deadline, not a remaining time

Never `setInterval` a countdown variable — browsers throttle background timers to roughly once a
minute, so it drifts badly, and a reload wipes it.

Store `restEndsAt` as an absolute epoch timestamp and derive `remaining = endsAt - Date.now()` on
every render and on `visibilitychange`. Reload, backgrounded tab, locked screen, and Blazor
restart all recover the correct value, because there is no accumulated state to corrupt.

**Hold a Screen Wake Lock for the duration of an active session.** Well supported (Chrome; Safari
since 16.4). Nobody wants the screen sleeping between sets, and keeping the page foregrounded
sidesteps most background-throttling problems for free.

## Edge cases

**Orphaned sessions.** On boot, if an `active` session's `startedAt` exceeds a few hours, prompt:
*"Unfinished workout from yesterday — resume or close?"* Never auto-close (discards data) and
never auto-resume (pollutes today's numbers).

**Multiple tabs.** Broadcast writes over `BroadcastChannel`, reusing the event bus from
[0003](0003-blazor-web-components-boundary.md), so other tabs re-render. Append-only records with
client UUIDs mean there is no merge conflict; the only real risk is double-creating the session
envelope, avoided by *querying* for today's active session rather than caching its ID in memory.

## Consequences

**A full page reload loses nothing.** Sets are written on tap, the timer is an absolute
timestamp, UI state is in `sessionStorage`, and Blazor holds nothing durable. This retroactively
relaxes [0002](0002-hosting-domain-and-updates.md): applying an update mid-session is *safe*, not
dangerous. The prompt remains because a surprise reload is jarring, not because data is at risk.

## Known limitation

**Notifying the user when rest ends while the app is backgrounded is not reliably solvable in a
PWA.** There is no dependable way to schedule a local notification without a push server, and
service workers get killed. Wake Lock plus audio-on-return covers the realistic case. Design the
rest timer as something you glance at, not something that reliably interrupts you, and do not
promise otherwise in the UI.
