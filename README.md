# Total Gym Logbook

A free, offline-first PWA for tracking workouts on the Total Gym.

Built with Blazor WebAssembly and vanilla Web Components in TypeScript. Your data stays on your
device — there is no account and no server.

## Why it's different

The Total Gym creates resistance by inclining a glideboard, so load depends on your bodyweight and
the level you set — unlike a barbell. This app converts level to **actual pounds** for your
specific machine, which makes progressive overload meaningful across level changes, added weight,
and bodyweight changes. See
[ADR 0004](docs/adr/0004-domain-model-and-resistance.md) for the derivation.

## Design

Architecture decisions live in [`docs/adr/`](docs/adr/README.md). Start with the index — the two
principles at the bottom of it explain most of the rest.

Resistance data (incline angles and derived glideboard weights per rail profile) is in
[`data/rail-profiles.json`](data/rail-profiles.json).

## Running it

```bash
dotnet run --project src/TotalGymLogBook.Web --urls http://0.0.0.0:5232
```

Tests and browser checks:

```bash
dotnet test                    # domain
cd src/client && npm run check # typecheck + client tests
tests/publish-smoke.sh         # asserts the publish output is deployable
node e2e/driver.mjs            # drives the real user flow in a browser
node e2e/offline-check.mjs     # publishes, serves statically, disconnects the network
```

## Deploying

CI runs on every push; `main` deploys to Azure Static Web Apps. See
[docs/deploying.md](docs/deploying.md) — the Azure resource and its token are a manual one-time
setup, and there is a warning there about origin changes destroying user data that is worth
reading before you deploy anywhere.

## Status

The logging loop works end to end and offline. Still open: history and charts, surfacing the
volume ledger, and confirming the 10-notch rail angles against a real machine. See the open
items in [docs/adr/](docs/adr/README.md).

---

Not affiliated with, endorsed by, or sponsored by Total Gym Fitness LLC.
