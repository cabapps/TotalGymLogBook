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

## Status

Design phase. No application code yet.

---

Not affiliated with, endorsed by, or sponsored by Total Gym Fitness LLC.
