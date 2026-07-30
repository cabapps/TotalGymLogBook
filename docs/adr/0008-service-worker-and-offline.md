# 0008 — Service worker and offline strategy

**Status:** Accepted

## Context

Blazor WASM ships its own boot-resource caching that verifies each `.wasm`/`.dll` against SHA-256
hashes in `blazor.boot.json`. Layering a service worker on top gives two caches with independent
lifetimes — the source of nearly every Blazor PWA failure report.

## Decision

### Make the service worker the only cache layer

Set `<BlazorCacheBootResources>false</BlazorCacheBootResources>`. One cache, one invalidation
path.

### Two-tier precache

A single all-or-nothing precache of ~25 MB of `_framework` would hold the instant shell hostage on
first visit, contradicting [0003](0003-blazor-web-components-boundary.md).

- **Tier A — critical shell** (~50 KB): `index.html`, shell ES module, critical CSS, icons.
  Precached during `install`, cache-first.
- **Tier B — framework** (`_framework/*`): precached after `activate`, in the background.
  Cache-first once present.

Consequence, and it's consistent with everything else: a user who visits once and goes offline
gets a fully working set logger with no charts or coach. That is the same graceful degradation the
architecture already assumes.

### Prevent integrity failures structurally

`Failed to find a valid digest in the integrity attribute` hard-fails the boot. It happens when
the SW serves a `_framework` asset from one build alongside a `blazor.boot.json` from another.

**Every `_framework/*` asset comes from exactly one versioned cache, populated atomically,
switched only when complete.** Name the cache after the build version, fully populate, then flip.
Never mutate a live cache. Blazor's stock `service-worker.published.js` gets this right — it is
broken by adding runtime-caching rules that overlap `_framework`.

### Azure SWA configuration

> **Corrected 2026-07-30 against real .NET 10.0.300 publish output.** This section originally
> said framework files are not content-hash-named and that versioning flows through
> `blazor.boot.json`. That was true of older Blazor and is **wrong for .NET 10**. Verified
> facts:
>
> - **There is no `blazor.boot.json`.** Don't write cache rules for it.
> - **Every `_framework` asset is content-fingerprinted** — `dotnet.native.f749u69f30.wasm`,
>   `TotalGymLogBook.Domain.g4lkut7sah.wasm`. They can be cached immutably forever.
> - **Version tracking lives in `service-worker-assets.js`**, which carries a version string
>   and a SHA-256 per asset (48 of them, including `dist/shell.js` and
>   `data/rail-profiles.json`). It is *not* fingerprinted, so it is now the file that must
>   never be stale-cached.

The unfingerprinted entry points are the entire recovery path:

```
Cache-Control: no-cache   →  index.html, service-worker.js, service-worker-assets.js
Cache-Control: immutable  →  _framework/*   (content-addressed, safe forever)
Cache-Control: no-cache   →  dist/*, data/* (stable names by 0009, loaded before SW control)
```

If the CDN pins any of the first three, users are stuck on a stale build with **no recovery
path**.

`dist/shell.js` deserves a note: the SW *does* precache it with integrity checking, and Blazor's
published worker fetches with `cache: 'no-cache'`, so SW updates are safe regardless. But
`index.html` loads it directly on first paint, before any worker controls the page — so it stays
revalidated. At 8 KB that costs nothing.

```json
"navigationFallback": {
  "rewrite": "/index.html",
  "exclude": ["/_framework/*", "/*.{css,js,wasm,dll,dat,json,png,svg,woff2}"]
}
```

Omit those exclusions and requests for missing JS return `index.html`, producing
`Uncaught SyntaxError: Unexpected token '<'`.

### Carve out the AI model

If the WebLLM tier from [0007](0007-coach-architecture.md) ships, model weights are **excluded
from the SW entirely** — no interception, no caching. WebLLM manages its own Cache API/OPFS
storage, and a 1 GB blob in the precache would be catastrophic.

The quota interaction is asymmetric: **an evicted model is a re-download; an evicted workout log
is unrecoverable.** So check `navigator.storage.estimate()` before *offering* the download and
decline if headroom is tight. Together with `navigator.storage.persist()` from
[0001](0001-persistence-and-backend-posture.md), the optional nice-to-have can never threaten the
irreplaceable data.

### Update wiring

`registration.waiting` → prompt → post `SKIP_WAITING` → `controllerchange` → reload. Per
[0005](0005-session-state-ownership.md) the reload is provably safe.

The template won't do this for you: an installed PWA can run for days without a natural
navigation and will never notice an update. Call `registration.update()` on `visibilitychange`
when the app regains focus, throttled to roughly hourly.

### Keep the dev/prod split

Blazor's no-op `service-worker.js` for development, `service-worker.published.js` for production.
An active SW during development will cost an afternoon to a stale-cache bug that isn't real.
