#!/usr/bin/env node
/**
 * Rasterizes tools/icon.svg into the PNGs the manifest and iOS ask for.
 *
 *   node tools/gen-icons.mjs
 *
 * Chromium rather than a raster library, because the repo already has one for the e2e suite and
 * it is the same renderer the icon will be judged by. No new dependency, and no second SVG
 * implementation to disagree with the browser about stroke joins.
 *
 * Deliberately NOT part of the build. The icon changes about once a year and the output belongs
 * in the diff, where a human can look at it before it ships to somebody's home screen.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Reached by path rather than by name: playwright is installed under e2e/, and a bare import
// from tools/ walks up to a repo root that does not have it. Same reason fit-programs.mjs runs
// esbuild with an explicit cwd -- this repo keeps its tooling next to what uses it.
const { chromium } = await import(
  pathToFileURL(join(HERE, '..', 'e2e', 'node_modules', 'playwright', 'index.mjs')).href
);
const WWWROOT = join(HERE, '..', 'src', 'TotalGymLogBook.Web', 'wwwroot');

/**
 * 180 is the size iOS actually asks for on a modern iPhone. Without it Safari takes the 512 and
 * downscales, which softens the strokes at exactly the size they are hardest to read.
 */
const SIZES = [
  { file: 'icon-512.png', px: 512 },
  { file: 'icon-192.png', px: 192 },
  { file: 'icon-180.png', px: 180 },
  { file: 'favicon.png', px: 64 },
];

function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;

  return readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
    .filter(existsSync)[0];
}

const svg = readFileSync(join(HERE, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });

try {
  for (const { file, px } of SIZES) {
    const page = await browser.newPage({ viewport: { width: px, height: px } });

    // The SVG is sized to the viewport rather than scaled with CSS transforms, so strokes are
    // rasterized at the target size instead of being drawn large and resampled down.
    await page.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:${px}px;height:${px}px}</style>${svg}`,
    );

    await page.screenshot({ path: join(WWWROOT, file), omitBackground: false });
    await page.close();
    console.log(`${file.padEnd(16)} ${px}x${px}`);
  }
} finally {
  await browser.close();
}
