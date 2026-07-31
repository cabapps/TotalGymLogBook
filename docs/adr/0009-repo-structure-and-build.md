# 0009 — Repo structure and build pipeline

**Status:** Accepted

## Structure

```
TotalGymLogBook/
├─ data/                              # source of truth, hand-edited
│  ├─ rail-profiles.json              # angles + boardWeight per profile
│  ├─ exercises.json
│  ├─ resistance-cases.json           # parity test inputs
│  └─ resistance-expected.json        # parity test golden outputs
├─ docs/adr/
├─ src/
│  ├─ TotalGymLogBook.Domain/         # pure C# — resistance, progression, coach rules
│  ├─ TotalGymLogBook.Interop/        # JSImport bindings, DTOs, STJ source-gen context
│  ├─ TotalGymLogBook.Web/            # Blazor WASM — the publishable project
│  │  └─ wwwroot/{index.html, dist/, data/}
│  └─ client/                         # TypeScript
│     └─ src/{shell/, db/, resistance.ts, bridge.ts, repsources/}
└─ tests/
   ├─ Domain.Tests/                   # xUnit, desktop runtime
   └─ client/                         # vitest
```

**`Domain` must never reference `Interop`.** JSImport requires the `browser-wasm` target, which
would drag domain tests onto a browser runner. A dependency-free class library means the
resistance calculator and progression engine test on the desktop runtime in milliseconds — and
that is where all the interesting logic lives.

## Toolchain: TypeScript + esbuild

```json
{
  "devDependencies": {
    "esbuild": "^0.25",        // bundler
    "typescript": "^5",        // type checking only; esbuild does the transpiling
    "vitest": "^3",            // tests
    "@types/node": "^26",      // node: imports in tests
    "fake-indexeddb": "^6"     // a real IDB implementation for tests, not a stub
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "esbuild src/main.ts --bundle --format=esm --minify --target=es2022 --outfile=../TotalGymLogBook.Web/wwwroot/dist/shell.js",
    "watch": "npm run build -- --watch",
    "test": "vitest run",
    "check": "npm run typecheck && npm run test"
  }
}
```

**Two of these ship nothing; three are test-only.** The build path is still just esbuild plus
`tsc --noEmit`, one config file (`tsconfig.json`), and zero plugins. `vitest`, `@types/node`, and
`fake-indexeddb` exist solely for the test run and never reach the bundle.

*(This block originally listed only `typescript` and `esbuild`. Updated as the test dependencies
were added, so it reflects the real file rather than the intention.)*

**`tsc --noEmit` is mandatory in CI.** esbuild strips types without checking them — it compiles
code with type errors happily.

**Stable, unhashed output filename.** Blazor owns `index.html` (it injects framework script tags),
so don't let a bundler own it too. Stable names are safe because
[0008](0008-service-worker-and-offline.md) puts cache invalidation in the service worker and
`no-cache` on `index.html`.

**CSS needs no tooling.** Constructable stylesheets from template literals keep the pipeline at
two dependencies permanently:

```ts
const sheet = new CSSStyleSheet();
sheet.replaceSync(`:host { display: block }`);
shadow.adoptedStyleSheets = [sheet];
```

Avoid CSS imports (needs a bundler plugin) and `import ... with { type: 'css' }` (not universally
supported yet).

### Rejected

- **Vite.** Its headline feature is the dev server and HMR, but Blazor owns the dev server here —
  `dotnet watch` serves the app. That leaves `vite build --watch`, i.e. a bundler plus a config
  file, for no benefit.
- **Rollup.** Fine, and equivalent in output at this scale, but needs `rollup.config.js` plus
  `@rollup/plugin-typescript` where esbuild needs one CLI line.
- **`tsc` alone.** `outFile` only works with `module: "amd"` or `"system"` and errors on ES
  modules, so there is no path to a bundled ESM file. Unbundled native modules are workable on
  HTTP/2 (request count is fine) but pay a **dependency waterfall**: the browser must parse each
  module to discover its imports. A five-deep graph is five sequential round trips — ~500 ms of
  pure latency at mobile RTT, attacking exactly what
  [0003](0003-blazor-web-components-boundary.md) protects. Flattening it with `modulepreload`
  hints requires generating the list, which is a build step again.

## Wiring the client build into `dotnet publish`

```xml
<PropertyGroup>
  <ClientDir>$(MSBuildProjectDirectory)/../client/</ClientDir>
</PropertyGroup>

<Target Name="BuildClient" BeforeTargets="BeforeBuild" Condition="'$(SkipClientBuild)' != 'true'">
  <Exec Command="npm ci" WorkingDirectory="$(ClientDir)"
        Condition="!Exists('$(ClientDir)node_modules')" />
  <Exec Command="npm run build" WorkingDirectory="$(ClientDir)" />
</Target>
```

**⚠ The sharp edge.** Blazor's static-web-asset pipeline collects `wwwroot` contents *early*. If
TypeScript output lands in `wwwroot/dist/` after that collection runs, the symptom is:
**everything works under `dotnet run`, and the files are simply absent after `dotnet publish`.**
It reads as a deployment problem when it's a build-ordering problem.

Mitigations:

- Verify with an actual `dotnet publish` on day one, not the week of shipping.
- Add a CI check that greps the publish output for `dist/shell.js` — cheap, and catches silent
  regressions on SDK upgrades.
- The exact static-web-assets target names have shifted between SDK versions; confirm against the
  installed SDK rather than trusting a hardcoded name.
- Once working, add `Inputs`/`Outputs` with a stamp file, or npm re-runs on every incremental
  build.

## Two publish-only failure modes worth knowing

Both were found by verification, not by review, and both are silent under `dotnet run`:

- **`index.html` must keep `<script type="importmap"></script>`.** Publish populates it with
  the runtime fingerprint map. Without it, Blazor requests `_framework/dotnet.js`, which does
  not exist. See [0008](0008-service-worker-and-offline.md).
- **Editing `index.html` poisons the next incremental publish** — the fingerprint placeholder
  survives into the output. `dotnet clean` is not enough; delete `obj/`.

`VerifyPublishedIndexHtml` in the csproj fails the build on both, and `publish-smoke.sh`
asserts them independently.

## The cross-language parity test

[0003](0003-blazor-web-components-boundary.md) duplicates the resistance calculation in C# and
TypeScript. Parity is enforced with data, not with a shared runtime:

- `data/resistance-cases.json` — every profile × every level × a spread of bodyweights, vest/bar
  loads, pulley on/off
- `data/resistance-expected.json` — committed golden results
- xUnit and vitest each compute all cases and assert equality, **rounded to 0.1 lb** (two runtimes
  will not be bit-identical)
- `tools/GenerateExpected` regenerates the golden file when the formula changes deliberately

Either implementation drifting fails its own suite independently, and an intentional formula change
appears as a reviewable diff.

## Rail profile data flow

`data/rail-profiles.json` is the single source of truth. It is copied to `wwwroot/data/` at build
time; TypeScript fetches it; **`Domain` takes the profile table as a constructor parameter** — pure,
no I/O, no embedded resource. The Web project loads the JSON and registers it in DI. One file on
disk, and `Domain` stays trivially testable with synthetic profiles.

## CI

`actions/setup-node` must run **before** the .NET steps.

**Set `skip_app_build: true` on the Azure Static Web Apps action** and point it at the
`dotnet publish` output. Otherwise its Oryx build tries to build the app itself and gets it wrong.

Dev loop is two watchers — `dotnet watch` and `npm run watch` — with `SkipClientBuild=true` on the
dotnet side so they don't fight over `dist/`.
