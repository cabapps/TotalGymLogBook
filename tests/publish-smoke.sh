#!/usr/bin/env bash
#
# Proves `dotnet publish` produces a complete, deployable bundle.
#
# This exists because of the sharp edge in docs/adr/0009: Blazor's static web asset pipeline
# collects wwwroot early, so if the esbuild output lands after that collection, everything
# works under `dotnet run` and the client bundle is SILENTLY ABSENT after publish. The failure
# reads as a deployment problem when it is a build-ordering problem, and it typically surfaces
# the week you are trying to ship.
#
# The exact static-web-assets target names have shifted between SDK versions, so this asserts
# on the OUTPUT rather than trusting a hardcoded target name. Run it in CI: an SDK upgrade that
# reorders those targets should fail here, loudly.
#
# Usage:  tests/publish-smoke.sh [output-dir]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$(mktemp -d)}"
WWWROOT="$OUT/wwwroot"

pass=0
fail=0

check() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    printf '  \033[32mPASS\033[0m  %-46s %s\n' "$label" "$(du -h "$path" 2>/dev/null | cut -f1)"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-46s MISSING: %s\n' "$label" "${path#"$WWWROOT"/}"
    fail=$((fail + 1))
  fi
}

# .NET 10 fingerprints framework filenames (dotnet.native.f749u69f30.wasm), so these must be
# matched by glob rather than exact name.
check_glob() {
  local label="$1" pattern="$2"
  local matches=( $pattern )
  if [[ -e "${matches[0]:-}" ]]; then
    printf '  \033[32mPASS\033[0m  %-46s %s\n' "$label" "$(basename "${matches[0]}")"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-46s NO MATCH: %s\n' "$label" "${pattern#"$WWWROOT"/}"
    fail=$((fail + 1))
  fi
}

check_contains() {
  local label="$1" path="$2" needle="$3"
  if [[ -f "$path" ]] && grep -q "$needle" "$path"; then
    printf '  \033[32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-46s expected %q in %s\n' \
      "$label" "$needle" "${path#"$WWWROOT"/}"
    fail=$((fail + 1))
  fi
}

echo "Publishing to $OUT ..."
dotnet publish "$REPO_ROOT/src/TotalGymLogBook.Web" \
  -c Release -o "$OUT" --nologo -v quiet >/dev/null

echo
echo "Client bundle (the thing that silently vanishes):"
check "esbuild output present"           "$WWWROOT/dist/shell.js"

echo
echo "Domain data:"
check "rail-profiles.json copied"        "$WWWROOT/data/rail-profiles.json"
# Blazor now parses this at startup too, for exercise names and per-muscle volume.
check "exercises.json copied"            "$WWWROOT/data/exercises.json"
check "programs.json copied"             "$WWWROOT/data/programs.json"

echo
echo "Blazor framework (.NET 10 content-fingerprints these; there is no blazor.boot.json):"
check_glob "runtime wasm"                "$WWWROOT/_framework/dotnet.native.*.wasm"
check_glob "blazor.webassembly loader"   "$WWWROOT/_framework/blazor.webassembly.*.js"
check_glob "domain assembly"             "$WWWROOT/_framework/TotalGymLogBook.Domain.*.wasm"

echo
echo "PWA:"
check "service worker (published swap)"  "$WWWROOT/service-worker.js"
check "service worker asset manifest"    "$WWWROOT/service-worker-assets.js"
check "web manifest"                     "$WWWROOT/manifest.webmanifest"
check "SWA config"                       "$WWWROOT/staticwebapp.config.json"

echo
echo "Wiring:"
check_contains "index.html loads the shell bundle" "$WWWROOT/index.html" 'dist/shell.js'
check_contains "Blazor autostart disabled"         "$WWWROOT/index.html" 'autostart="false"'

# Editing wwwroot/index.html leaves the asset-fingerprint placeholder unsubstituted on the next
# incremental publish. The output still contains every expected file, so a pure existence check
# passes while the app is completely broken -- the framework script tag 404s and Blazor never
# loads. `dotnet clean` does not fix it; deleting obj/ does. The csproj now fails the build on
# this, and this is the belt to that braces.
# The importmap maps _framework/dotnet.js to the fingerprinted file. Missing or empty, Blazor
# dies with "Failed to fetch dynamically imported module" on any static host -- while working
# perfectly under `dotnet run`, whose DevServer resolves the names itself.
if grep -q '<script type="importmap">{' "$WWWROOT/index.html"; then
  printf '  \033[32mPASS\033[0m  importmap populated\n'
  pass=$((pass + 1))
else
  printf '  \033[31mFAIL\033[0m  importmap populated                       missing or empty in index.html\n'
  fail=$((fail + 1))
fi

if grep -q '{fingerprint}' "$WWWROOT/index.html"; then
  printf '  \033[31mFAIL\033[0m  asset fingerprints substituted            index.html still has {fingerprint}\n'
  fail=$((fail + 1))
else
  printf '  \033[32mPASS\033[0m  asset fingerprints substituted\n'
  pass=$((pass + 1))
fi
check_contains "published SW was swapped in"       "$WWWROOT/service-worker.js" 'self.assetsManifest'

# The Blazor mount point is a light-DOM child of the shell, projected into <slot name="derived">
# so the coach lands under the workout rather than below the data card. Both halves live in
# files that get rewritten by different toolchains, and a mismatch is silent: an unslotted child
# is not rendered, so the coach simply never appears.
check_contains "Blazor root is slotted"            "$WWWROOT/index.html"        'slot="derived"'
check_contains "shell exposes the derived slot"    "$WWWROOT/dist/shell.js"     'name="derived"'

# The update handshake. Without SKIP_WAITING a new build sits in 'waiting' forever on an
# installed iOS PWA, because resuming from the app switcher never retires the old client; without
# clients.claim the page never sees controllerchange and the Update button does nothing.
check_contains "SW answers the update handshake"   "$WWWROOT/service-worker.js" 'SKIP_WAITING'
check_contains "SW claims clients on activate"     "$WWWROOT/service-worker.js" 'clients.claim'
check_contains "shell registers the SW"            "$WWWROOT/dist/shell.js"     'service-worker.js'

if grep -qi 'bootstrap' "$WWWROOT/index.html"; then
  printf '  \033[31mFAIL\033[0m  template Bootstrap still referenced\n'; fail=$((fail + 1))
else
  printf '  \033[32mPASS\033[0m  template Bootstrap removed\n'; pass=$((pass + 1))
fi

echo
echo "Payload (what a first-time visitor downloads):"
printf '  %-20s %s\n' "wwwroot total"  "$(du -sh "$WWWROOT" | cut -f1)"
printf '  %-20s %s\n' "_framework"     "$(du -sh "$WWWROOT/_framework" | cut -f1)"
printf '  %-20s %s\n' "shell.js"       "$(du -h "$WWWROOT/dist/shell.js" | cut -f1)"
printf '  %-20s %s\n' "brotli assets"  "$(find "$WWWROOT" -name '*.br' | wc -l) files"

echo
if (( fail > 0 )); then
  echo -e "\033[31m$fail check(s) failed\033[0m, $pass passed."
  exit 1
fi
echo -e "\033[32mAll $pass checks passed.\033[0m"
