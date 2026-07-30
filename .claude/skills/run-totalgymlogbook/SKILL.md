---
name: run-totalgymlogbook
description: Build, run, and drive Total Gym Logbook. Use when asked to start the app, launch the dev server, run its tests, build or publish it, take a screenshot of its UI, or verify a change in the running app.
---

Total Gym Logbook is a Blazor WebAssembly PWA with a vanilla-web-component shell. Drive it with
`.claude/skills/run-totalgymlogbook/driver.mjs` — it starts the dev server if needed, drives
headless Chromium, screenshots both rendering tiers, and asserts the things that actually break.

All paths are relative to the repo root.

**The app renders in two tiers** ([docs/adr/0003](../../../docs/adr/0003-blazor-web-components-boundary.md)),
and knowing this is essential to verifying it:

- **Instant tier** — `<tg-app-shell>`, a web component that paints and becomes interactive
  before the .NET runtime exists. Live resistance readout, ~5 KB.
- **Derived tier** — Blazor renders the load ladder into `#blazor-root` seconds later, ~2.1 MB
  brotli.

A screenshot showing only one tier means something is broken.

## Prerequisites

.NET 10 SDK and Node. Both were already present; no `apt-get` was needed in this container.

```bash
dotnet --version   # 10.0.300
node --version     # v24.16.0
```

Playwright needs a Chromium build in `~/.cache/ms-playwright/`. One was already cached
(`chromium-1200`). If absent: `npx playwright install chromium`.

## Setup

One-time, after clone:

```bash
# Driver deps (kept out of src/client so Playwright isn't a dependency of the shipped app)
cd .claude/skills/run-totalgymlogbook && npm install && cd -

# Client deps. The approve step is REQUIRED on npm 12+ -- see Gotchas.
cd src/client && npm ci && npm install-scripts approve esbuild && cd -
```

## Build

```bash
dotnet build                      # builds client bundle too, via the BuildClient MSBuild target
cd src/client && npm run build    # client bundle only, when iterating on TypeScript
```

## Run (agent path)

```bash
node .claude/skills/run-totalgymlogbook/driver.mjs
```

Cold start to fully verified in ~10s. Starts the dev server if it isn't already up, and stops
only the server it started.

| flag / env | effect |
|---|---|
| `--keep` | leave the dev server running afterwards |
| `--dark` | render with `prefers-color-scheme: dark` |
| `PORT=5300` | use a different port (default 5232) |

Screenshots → `.claude/skills/run-totalgymlogbook/screenshots/` — `01-instant.png` (shell only),
`02-full.png` (both tiers), `03-interacted.png` (after slider + pulley + vest).

Verified output:

```
server already up on http://localhost:5232
chromium: /home/kcab7/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome

Instant tier (web components, pre-Blazor):
  PASS  shell rendered a resistance readout  56.7 lb
Derived tier (Blazor WASM):
  PASS  Blazor booted and rendered
  PASS  load ladder has 14 rows  14 rows
  PASS  TypeScript and C# agree at level 8  shell=56.7 blazor=56.7
Interaction:
  PASS  slider level 8 -> 14 raises load  56.7 -> 86.0 lb
  PASS  pulley halves the load  86.0 -> 43.0 lb
  PASS  vest hint explains the discount  Your 20 lb of added weight contributes 4.3 lb here.
Console:
  PASS  no console errors
```

**The cross-tier check is the valuable one.** `TypeScript and C# agree at level 8` compares the
shell's readout against the Blazor table's row 8. The resistance formula is deliberately
implemented twice ([docs/adr/0004](../../../docs/adr/0004-domain-model-and-resistance.md)), so
that assertion catches drift the unit tests would miss at the integration level.

## Run (human path)

```bash
dotnet run --project src/TotalGymLogBook.Web --urls http://0.0.0.0:5232
```

Then open `http://localhost:5232`. Bind to `0.0.0.0`, not the default localhost, if the browser
is outside the container — under WSL2 that makes it reachable from Windows. Stop with:

```bash
lsof -ti:5232 -sTCP:LISTEN | xargs -r kill
```

## Test

```bash
dotnet test                                    # 50 xUnit
cd src/client && npm run check                 # tsc --noEmit + 14 vitest
tests/publish-smoke.sh                         # 13 checks on real publish output
```

`publish-smoke.sh` is the one that matters before deploying — it asserts the esbuild bundle
survived `dotnet publish`, which is a real failure mode
([docs/adr/0009](../../../docs/adr/0009-repo-structure-and-build.md)).

## Gotchas

- **`<tg-app-shell>` renders into a shadow root.** Ordinary Playwright selectors (`#level`,
  `text=Level 8`) never match anything inside the instant tier. Everything must go through
  `el.shadowRoot` inside an `evaluate()`. `driver.mjs` has a `shellEval` helper for this.

- **Playwright's browser build number rarely matches the cache.** `npm i playwright` pulled a
  driver wanting `chromium_headless_shell-1234` while the cache held `chromium-1200`, giving
  `Executable doesn't exist at ...` with a perfectly good Chromium sitting right there.
  `driver.mjs` scans `~/.cache/ms-playwright` for whatever build is present instead of pinning.
  Override with `CHROME_BIN` if needed.

- **Never `waitForLoadState('networkidle')` to wait for Blazor.** `index.html` calls
  `Blazor.start()` manually from a `requestIdleCallback` (deliberately — see
  [docs/adr/0003](../../../docs/adr/0003-blazor-web-components-boundary.md)), so the runtime
  arrives long after load settles. Wait for `#blazor-root` to contain "Load ladder".

- **npm 12 blocks postinstall scripts by default.** esbuild fetches its platform binary in
  `postinstall`, so a plain `npm ci` leaves you with no working esbuild and a confusing failure
  at build time. `npm install-scripts approve esbuild` is required. The `RestoreClient` MSBuild
  target does this automatically but tolerates failure, so older npm still works.

- **MSBuild `Inputs`/`Outputs` must name the real artifact.** `BuildClient` originally used a
  stamp file under `node_modules` as its `Outputs`, so MSBuild skipped it whenever sources were
  unchanged — even with the bundle missing from `wwwroot`. It now points at
  `wwwroot/dist/shell.js`, so a deleted bundle forces a rebuild. If you touch that target, run
  `tests/publish-smoke.sh` after clearing `wwwroot/dist`.

- **`.csproj` comments cannot contain `--`.** XML forbids it, and the error
  (`MSB4025: The project file could not be loaded`) points at the line but not the cause. That
  file has long prose comments; use a semicolon or comma instead of an em-dash.

## Troubleshooting

- **`Executable doesn't exist at .../chromium_headless_shell-<N>/...`**: Playwright version vs.
  cached browser mismatch. `driver.mjs` handles it automatically; if it still fails, set
  `CHROME_BIN=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1)`.

- **Driver reports `load ladder has 0 rows` but the shell renders**: Blazor failed to boot. The
  shell is designed to work without it, so the page looks half-alive rather than broken. Check
  the browser console — most likely `data/rail-profiles.json` 404'd, which throws during DI
  setup in `Program.cs`. Confirm with `curl -s -o /dev/null -w '%{http_code}'
  http://localhost:5232/data/rail-profiles.json`.

- **`dev server never came up`**: usually port 5232 is held by a previous run.
  `lsof -ti:5232 -sTCP:LISTEN | xargs -r kill`, then retry.

- **Blank or shell-only screenshot**: not a rendering bug — the driver screenshots
  `01-instant.png` deliberately before Blazor boots. Compare against `02-full.png`.
