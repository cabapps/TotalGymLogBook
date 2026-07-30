# 0001 — Persistence and backend posture

**Status:** Accepted

## Context

Total Gym Logbook is a free app with no revenue. It holds bodyweight and body-composition data.
Users expect it to work in a garage or basement with poor connectivity.

## Decision

**Local-first with no backend.** IndexedDB is the system of record. Export/import is the
durability story. There are no accounts, no authentication, and no server-side data.

**The schema is sync-ready from the first migration even though no sync exists:**

- Client-generated UUID primary keys — never autoincrement
- `updatedAt` on every record
- Soft-delete tombstones instead of hard deletes

## Rationale

- **Cost.** A free app must cost ~$0/month indefinitely, or it gets abandoned.
- **Privacy surface.** No accounts means no PII, no breach surface, no password resets, and no
  privacy-policy obligations. "Your data never leaves your device" is a genuine selling point.
- **Offline is free.** With no server truth there is no online/offline divergence to reconcile.
  Offline isn't a feature; it's the only mode.
- **Sync-ready now is cheap; retrofitting is not.** Client UUIDs, timestamps, and tombstones
  cost an hour of thought today and are the difference between "add sync" and "rewrite the
  data layer" later.

## Consequences

**Storage eviction is the primary risk.** Safari's ITP clears script-writable storage after
7 days without site interaction. Mitigations, all of which are desirable anyway:

- Prompt for Add to Home Screen — **installed PWAs are exempt from the 7-day cap** — and
  explain why ("so your log doesn't get cleared")
- Call `navigator.storage.persist()` on Chromium
- Make export a first-class flow, not a settings-page afterthought

No cross-device sync. A user with a phone and a tablet has two independent logbooks.

## Rejected

**Local-first with sync via user-owned cloud storage** (File System Access API to a Drive or
Dropbox folder). The API is Chromium-only, so it fails on iOS — the same wall that blocks
Web Bluetooth in [0006](0006-rep-sources.md). Real cross-device sync would require a real
backend; deferred, not designed out.
