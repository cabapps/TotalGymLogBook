/**
 * Which precached asset is rejecting?
 *
 * The published service worker precaches with cache.addAll(), which is all-or-nothing: one
 * failing request discards the whole registration, leaving an empty cache and no offline
 * support. This replays each request individually -- same integrity hash, same cache mode --
 * to name the offender.
 *
 * Usage: node e2e/diagnose-sw.mjs https://your-app.azurestaticapps.net
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = (process.argv[2] ?? '').replace(/\/$/, '');
if (!BASE) { console.error('need a base url'); process.exit(2); }

const cache = join(homedir(), '.cache', 'ms-playwright');
const exe = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()
  .map((d) => join(cache, d, 'chrome-linux64', 'chrome')).filter(existsSync)[0];

const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await b.newContext()).newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const report = await page.evaluate(async () => {
  // The manifest the worker precaches from.
  const src = await (await fetch('service-worker-assets.js')).text();
  const json = src.replace(/^\s*self\.assetsManifest\s*=\s*/, '').replace(/;\s*$/, '');
  const manifest = JSON.parse(json);

  const failures = [];
  let ok = 0;

  for (const asset of manifest.assets) {
    try {
      const res = await fetch(new Request(asset.url, { integrity: asset.hash, cache: 'no-cache' }));
      if (!res.ok) failures.push({ url: asset.url, why: `HTTP ${res.status}` });
      else ok++;
    } catch (e) {
      failures.push({ url: asset.url, why: String(e).slice(0, 120) });
    }
  }

  return { total: manifest.assets.length, ok, failures: failures.slice(0, 12), version: manifest.version };
});

console.log(`manifest version: ${report.version}`);
console.log(`${report.ok}/${report.total} assets fetched cleanly\n`);
if (report.failures.length === 0) {
  console.log('no individual failures -- the problem is elsewhere');
} else {
  console.log('FAILING:');
  for (const f of report.failures) console.log(`  ${f.url}\n    ${f.why}`);
}

await b.close();
