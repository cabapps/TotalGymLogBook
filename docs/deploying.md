# Deploying

CI and the deploy workflow are committed and verified locally. **The Azure resource and its
deployment token are not** — those need your Azure account, and this document is the handover.

Architecture rationale for the hosting choices is in
[ADR 0002](adr/0002-hosting-domain-and-updates.md).

## Read this before you deploy anything

**The origin you launch on is permanent.** IndexedDB is scoped to it, and there is no way to
read a previous origin's database. Moving from `something.azurestaticapps.net` to your own
domain later **destroys every existing user's workout history** — silently, with no migration
path, because with no server there is nothing to restore from.

So:

- Deploy to the free `*.azurestaticapps.net` hostname as much as you like **while you are the
  only user**.
- **Buy the domain and point it at the app before anyone else stores data.** ADR 0002 settles
  on `totalgymlogbook.cabapps.app`; `cabapps.app` was available as of July 2026.
- Once real users exist, the origin is frozen.

## One-time Azure setup

### 1. Create the Static Web App

Portal → Create resource → Static Web App.

| Field | Value |
|---|---|
| Plan | **Free** |
| Deployment source | **Other** (not GitHub) |
| Region | whichever is closest to you |

Choosing "Other" rather than "GitHub" matters: letting Azure wire up the repo generates its own
workflow file that conflicts with the one already committed here, and its Oryx builder will try
to build the app itself and get it wrong.

### 2. Add the deployment token to GitHub

Azure portal → your Static Web App → **Manage deployment token** → copy.

GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | the token you just copied |

The name must match exactly — `.github/workflows/deploy.yml` reads it.

That is the whole setup. Push to `main` and the workflow publishes, verifies, and uploads.

### 3. Custom domain, when you are ready

1. Buy `cabapps.app`.
2. Azure portal → your Static Web App → Custom domains → Add → `totalgymlogbook.cabapps.app`.
3. Azure gives you a `CNAME` target and a `TXT` validation record. Add both at your registrar.
4. Certificates are issued and renewed automatically.

A subdomain is deliberately easier than the apex here — apex domains on SWA need ALIAS/ANAME
support, which not every registrar has. Putting DNS on Cloudflare (free, even for domains
registered elsewhere) solves that with CNAME flattening if you ever want the apex.

## What the workflows do

**`ci.yml`** — every push and pull request.

| Job | Contents |
|---|---|
| `test` | build with `-warnaserror`, 137 xUnit, typecheck, 85 vitest, 15 publish checks |
| `e2e` | 23 browser checks of the user flow, then 11 offline checks against a real published build |

**`deploy.yml`** — pushes to `main`, plus preview environments per PR.

Publishes, runs `publish-smoke.sh` against the output as a gate, then uploads with
`skip_app_build: true`.

## Why the e2e job is worth its runtime

`offline-check.mjs` publishes, serves the output statically, and disconnects the network. It is
the only check that exercises the real service worker and the real fingerprinted asset names.

Both of the worst bugs found in this project were invisible to everything else:

- A **missing import map** meant the published app requested `_framework/dotnet.js`, which does
  not exist, so Blazor never loaded on any static host. Perfect under `dotnet run`.
- **Editing `index.html`** left the fingerprint placeholder unsubstituted on the next
  incremental publish, so the framework script tag 404'd.

Both would have deployed green. A file-existence smoke test passes happily on a completely
broken deployable — assert on content and on behaviour in a browser.

## Running the same checks locally

```bash
dotnet build -c Release -warnaserror
dotnet test
cd src/client && npm run check && cd -
tests/publish-smoke.sh
node e2e/driver.mjs
node e2e/offline-check.mjs
```

## Costs

Free tier throughout: 100 GB/month bandwidth, 250 MB app size against a ~12 MB published
output. GitHub Actions is free for public repositories. The only recurring cost is the domain,
around $15/year.

## Troubleshooting

- **`Deployment token was not provided`** — the secret is missing or misnamed. It must be
  exactly `AZURE_STATIC_WEB_APPS_API_TOKEN`.
- **The action tries to build the app** — `skip_app_build: true` was dropped, or Azure created
  its own workflow file when the Static Web App was set up with "GitHub" as the deployment
  source. Delete the generated workflow; this repo's is the one to keep.
- **App deploys but shows a blank page** — check the browser console. If it says *"Failed to
  fetch dynamically imported module"*, the import map is missing from `index.html`; see
  [ADR 0008](adr/0008-service-worker-and-offline.md).
- **Users report losing data** — check whether the origin changed. That is unrecoverable, which
  is the entire reason for the warning at the top of this file.
