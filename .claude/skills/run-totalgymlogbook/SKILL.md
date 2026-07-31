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

- **Instant tier** — `<tg-app-shell>` and friends: onboarding, the set logger, the rest timer,
  and the session list. Paints and is fully usable for logging before the .NET runtime exists.
  ~20 KB, and it owns the write path.
- **Derived tier** — Blazor renders coaching into `#blazor-root` seconds later, ~2.1 MB brotli.
  Read-only, through the bridge; it never opens IndexedDB.

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

Screenshots → `.claude/skills/run-totalgymlogbook/screenshots/` — `01-onboarding.png`,
`02-logger.png`, `03-session.png` (after logging, correcting, deleting), `04-weighin.png`,
`05-coach.png`.

The driver starts from a FRESH browser context each run, so it always sees onboarding first.
That is deliberate: the empty-logbook path is the one every new user hits.

Verified output:

```
Onboarding (instant tier, no .NET yet):
  PASS  asks exactly three questions               3 inputs
Logging a set:
  PASS  load readout computed with no .NET         28.4 lb
  PASS  flags cable exercises                      · cable, so half the incline load
  PASS  rep stepper works                          12 reps
  PASS  set appears in the session list            1 rows
Rest timer:
  PASS  starts automatically after a set
  PASS  counts down from the deadline              1:30 -> 1:29
  PASS  survives a reload                          1:29 after reload
More sets and a correction:
  PASS  a mistyped set can be corrected            8 reps
  PASS  a set can be deleted                       2 rows
Weigh-in:
  PASS  shows the smoothed trend                   raw 186 -> trend 181.5 lb
  PASS  load follows the smoothed weight           moved 0.20 lb (raw 6 lb would be ~0.72)
Derived tier (Blazor reads the logbook):
  PASS  coach produced a recommendation            30.7 lb
  PASS  recommendation is a sane step              28.4 -> 30.7 lb (x1.08)
Console:
  PASS  no console errors
```

**Two checks earn their keep.**

`recommendation is a sane step` catches the coach reasoning about the wrong exercise. Cable
movements are halved by the pulley, so a load ladder built without the exercise's pulley factor
compares 28.4 lb of chest press against a 61.4 lb direct-press rung and recommends doubling the
load. Ratio-checking the recommendation against what was actually logged catches that class of
error regardless of the numbers involved.

`survives a reload` pins the rest timer's deadline-not-countdown design
([docs/adr/0005](../../../docs/adr/0005-session-state-ownership.md)). A decrementing counter
passes every other check and fails only this one.

**One trap worth knowing if you extend the weigh-in checks.** Bodyweight stores one row per
calendar day, so a second entry today REPLACES rather than accumulating. A smoothing assertion
written against a single reading passes vacuously — the EMA of one value is that value. The
driver seeds nine prior days through `db.recordBodyweight` before asserting, so there is
actually something to damp.

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
dotnet test                                    # 137 xUnit
cd src/client && npm run check                 # tsc --noEmit + 73 vitest
tests/publish-smoke.sh                         # 13 checks on real publish output
```

`publish-smoke.sh` is the one that matters before deploying — it asserts the esbuild bundle
survived `dotnet publish`, which is a real failure mode
([docs/adr/0009](../../../docs/adr/0009-repo-structure-and-build.md)).

## Gotchas

- **Shadow DOM is *not* a problem for Playwright** — an earlier version of this file claimed
  ordinary selectors can't reach inside the custom elements. That was wrong. Playwright's CSS
  engine pierces **open** shadow roots, so `page.locator('tg-set-logger #load')` works
  directly, and `driver.mjs` no longer needs an `evaluate()` helper. (Text selectors and
  `getByRole` also work; only `>>>`-style explicit piercing is unnecessary.) Plain
  `document.querySelector` from inside an `evaluate()` still won't reach in — that's a DOM
  limitation, not a Playwright one.

- **Playwright's browser build number rarely matches the cache.** `npm i playwright` pulled a
  driver wanting `chromium_headless_shell-1234` while the cache held `chromium-1200`, giving
  `Executable doesn't exist at ...` with a perfectly good Chromium sitting right there.
  `driver.mjs` scans `~/.cache/ms-playwright` for whatever build is present instead of pinning.
  Override with `CHROME_BIN` if needed.

- **Never `waitForLoadState('networkidle')` to wait for Blazor.** `index.html` calls
  `Blazor.start()` manually from a `requestIdleCallback` (deliberately — see
  [docs/adr/0003](../../../docs/adr/0003-blazor-web-components-boundary.md)), so the runtime
  arrives long after load settles. Wait for a selector the component actually renders
  (`#empty-state, #rec-load`), and note the `<h2>` appears BEFORE the logbook read finishes —
  waiting on the heading alone is a race.

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

- **`[JSImport]` global paths need an explicit `globalThis.` prefix.** `[JSImport("myGlobal.fn")]`
  fails at first call with `myGlobal not found while looking up myGlobal.fn`, wrapped in an
  opaque `AggregateException_ctor_DefaultMessage` — even when `globalThis.myGlobal` is
  demonstrably an object in the page. Write `[JSImport("globalThis.myGlobal.fn")]`. Because the
  binding resolves during startup, the only visible symptom is that Blazor renders nothing.

- **`index.html` must keep `<script type="importmap"></script>`.** Publish populates it with
  the fingerprint map for the runtime files. Without it the loader requests
  `_framework/dotnet.js`, which does not exist (the file is `dotnet.<hash>.js`), and Blazor
  dies with "Failed to fetch dynamically imported module". **This does not reproduce under
  `dotnet run`** — the DevServer resolves unfingerprinted names itself — so the app looks
  perfect locally and is broken on every static host. Caught only by `offline-check.mjs`.

- **Editing `index.html` breaks the next incremental publish.** The fingerprint placeholder
  survives into the output and the framework script tag 404s. `dotnet clean` does NOT fix it;
  delete `obj/`. The csproj fails the build on this now.

- **~~`JSHost.ImportAsync` resolves its URL relative to `_framework/`~~** (no longer relevant —
  the bindings are global-rooted, which removes module URLs from the picture entirely; kept
  because the trap is real if anyone reintroduces ImportAsync):
  `"./dist/shell.js"` silently becomes `/_framework/dist/shell.js` and 404s. The failure
  surfaces as an opaque `AggregateException_ctor_DefaultMessage (TypeError: Failed to fetch
  dynamically imported module)` during startup — it names neither the path nor the caller. Use
  `"../dist/shell.js"`, which is also correct under subpath hosting since `_framework` always
  sits one level below the base.

- **Anything Blazor imports must be a named export of `main.ts`.** `[JSImport]` resolves
  against the imported module's exports, so a function `bridge.ts` declares but `main.ts`
  doesn't re-export is invisible, with no build-time error.

- **C# marshals an absent argument as `null`, not `undefined`.** A TypeScript guard written
  `foo === undefined` therefore lets `null` straight through — and `IDBKeyRange.lowerBound(null)`
  throws `DataError: Failed to execute 'lowerBound' on 'IDBKeyRange': The parameter is not a
  valid key`. Use `== null` on anything reachable from the bridge. Unit tests never catch this,
  because they pass real values.

- **`Infinity` is not a valid IndexedDB key.** Only finite numbers, strings, dates, binary, and
  arrays of those. Using `±Infinity` as range sentinels throws the same opaque `DataError` at
  runtime; use `0` and `Number.MAX_SAFE_INTEGER`.

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
  `lsof -ti:5232 -sTCP:LISTEN | xargs -r kill`, then retry. If it persists, run the dev server
  by hand — the driver swallows its output, and a compile error looks identical to a slow start.

- **`CS0234: The type or namespace name 'Interop' does not exist`**: something rewrote
  `TotalGymLogBook.Web.csproj` and dropped a `<ProjectReference>`. An IDE tidying the project
  file has done this at least once. Diff against git before assuming your own edit broke it:
  `git diff src/TotalGymLogBook.Web/TotalGymLogBook.Web.csproj`.

- **Blank or shell-only screenshot**: not a rendering bug — the driver screenshots
  `01-instant.png` deliberately before Blazor boots. Compare against `02-full.png`.
