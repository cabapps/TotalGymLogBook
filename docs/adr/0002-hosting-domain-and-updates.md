# 0002 — Hosting, domain, and update model

**Status:** Accepted

## Context

[0001](0001-persistence-and-backend-posture.md) makes IndexedDB the system of record.
**IndexedDB is origin-scoped**, and there is no way to read a previous origin's database.
Therefore the origin is a permanent, unmigratable commitment: changing it destroys every
existing user's workout history.

The app also uses the name "Total Gym," a registered trademark of Total Gym Fitness LLC.

## Decision

### Hosting: Azure Static Web Apps

Free tier, static output only, deployed from GitHub Actions.

Required capabilities, both of which SWA has:
- Header control via `staticwebapp.config.json` (keeps the `COOP`/`COEP` door open for
  `SharedArrayBuffer` should .NET WASM multithreading ever be wanted)
- On-the-fly compression (so Blazor's `.br` assets are served correctly without a JS
  decompression shim)

Free tier limits are comfortable: 100 GB/month bandwidth, 250 MB app size against a published
`_framework` of ~20–30 MB. Its bundled Azure Functions are a clean escape hatch if sync is ever
added.

### Domain: `totalgymlogbook.cabapps.app`

`cabapps.app` was verified available (RDAP, 2026-07). `cabapps.com` and `cabapps.dev` are taken.

- **Subdomains, never subpaths.** An origin is scheme + host + port, so subpaths *share* an
  origin. Hosting multiple apps under one domain as folders would give them one shared
  IndexedDB namespace, one localStorage, and a service-worker scope conflict — and would make
  extracting any app later impossible without destroying its data. Subdomains isolate cleanly.
- **`.app` is on the HSTS preload list**, TLD-wide including subdomains. HTTPS is enforced at
  the browser level, which a PWA requires anyway.
- **Develop on the free `*.azurestaticapps.net` hostname; buy and switch before the first real
  user.** That hostname is origin-locked identically, and it is unshareable — which matters
  because word-of-mouth in Total Gym communities is the only distribution channel.

### Build settings

- IL trimming **on**
- AOT **off** — it multiplies payload size for throughput this app never needs. Boot time is
  the metric that matters; the heaviest computation is a progression algorithm over a few
  thousand rows.

### Update model

Detect the waiting service worker, hold it, show a dismissible banner, and apply on user
action. Never auto-reload. Wiring is in [0008](0008-service-worker-and-offline.md).

Per [0005](0005-session-state-ownership.md) a reload is provably safe — nothing durable lives
in memory — so the prompt exists for politeness, not data protection.

## Trademark posture

The exposure here is not really legal, it is **data durability**: a forced rename means an
origin change, which wipes every user's logbook. A subdomain on a domain we own outright is
low-profile and renameable in a way an app-specific domain is not.

The relevant test is nominative fair use (*New Kids on the Block v. News America*, 9th Cir.
1992), and all three prongs are satisfiable deliberately:

1. The product is not identifiable without the mark — an app for Total Gym owners cannot
   describe itself otherwise.
2. Use no more of the mark than necessary — the words only. Never their logo, stylised
   wordmark, product photography, colours, or trade dress.
3. Suggest no sponsorship — "Not affiliated with, endorsed by, or sponsored by Total Gym
   Fitness LLC" in the footer, About page, and PWA manifest description. Never "official."

Plus: **keep it genuinely free and non-commercial.** Commercial use materially weakens fair
use across the board.

Related copyright analysis (what may be reproduced from Total Gym's published materials) is in
[0004](0004-domain-model-and-resistance.md).

## Rejected

**GitHub Pages.** No header control at all, and it won't serve Blazor's pre-compressed `.br`
assets with the correct `Content-Encoding`, forcing a slow JS decompression shim — directly
against the load-time principle.

**Cloudflare Pages.** Equivalent on capability, but SWA is already familiar, and for a hobby
project that needs to actually ship, familiarity beats a marginally better platform.
