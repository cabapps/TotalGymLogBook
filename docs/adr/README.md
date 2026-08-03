# Architecture Decision Records

Decisions for **Total Gym Logbook** — a free, offline-first PWA for tracking Total Gym
workouts, built with Blazor WebAssembly and vanilla Web Components in TypeScript.

Each record states the decision, why it was made, and what it commits us to. Where a decision
was revised during design, the record reflects where we landed, with the rejected option noted.

| # | Decision | Status |
|---|---|---|
| [0001](0001-persistence-and-backend-posture.md) | Persistence and backend posture | Accepted |
| [0002](0002-hosting-domain-and-updates.md) | Hosting, domain, and update model | Accepted |
| [0003](0003-blazor-web-components-boundary.md) | Blazor ↔ Web Components boundary | Accepted |
| [0004](0004-domain-model-and-resistance.md) | Domain model and the resistance calculation | Accepted |
| [0005](0005-session-state-ownership.md) | Session state ownership | Accepted |
| [0006](0006-rep-sources.md) | Rep sources and capability negotiation | Accepted |
| [0007](0007-coach-architecture.md) | Coach architecture and AI tiering | Accepted |
| [0008](0008-service-worker-and-offline.md) | Service worker and offline strategy | Accepted |
| [0009](0009-repo-structure-and-build.md) | Repo structure and build pipeline | Accepted |
| [0010](0010-goals-and-training-phase.md) | Training goals and energy phase | Accepted |

## The two principles everything else follows from

**1. Split work by time-to-interactive criticality, not by complexity.**
Blazor WASM cold start is 1–3 seconds; web components paint immediately. So the boundary is
drawn around *when* code must be available, not how sophisticated it is. This is why the
resistance calculator and the rep-detection filter live in TypeScript despite being the kind
of logic that would otherwise belong in .NET.

**2. The user's logbook is irreplaceable; everything else is a re-download.**
There is no server. IndexedDB is the system of record. Every decision about caching, storage
quota, domains, and updates resolves in favor of not losing workout history.

## Open items

- `bodyFraction` values per exercise are estimated from the trainee's position, not measured.
- The Total Gym STATS BLE protocol is unknown; [0006](0006-rep-sources.md) ships the
  interface only.
