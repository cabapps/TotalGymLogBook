import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two service workers have to agree on one thing, and only one thing.
 *
 * src/client/src/updates.ts offers the trainee an update and then posts SKIP_WAITING to the
 * waiting worker, waiting for 'controllerchange' to reload the page. A worker that does not
 * answer that message never activates, the event never fires, and the banner sits on
 * "Updating..." until the app is closed.
 *
 * That is exactly what the DEVELOPMENT worker did. It is a no-op by design -- caching would make
 * development miserable -- but the build stamps it with a manifest version that changes on every
 * rebuild, so the browser dutifully installs a new copy, parks it behind the running one, and
 * the app dutifully offers an update it had no way to complete.
 *
 * A source-level check rather than a browser one because the failure is structural: it is not
 * that the handshake went wrong, it is that one side of it was never written. Reading the file
 * catches that permanently and for free, which a browser test that needs two dev-server restarts
 * does not.
 */
const wwwroot = join(__dirname, '..', '..', 'TotalGymLogBook.Web', 'wwwroot');

const workers = [
  ['development', 'service-worker.js'],
  ['published', 'service-worker.published.js'],
] as const;

describe('service worker update protocol', () => {
  for (const [which, file] of workers) {
    it(`the ${which} worker answers SKIP_WAITING`, () => {
      const source = readFileSync(join(wwwroot, file), 'utf8');

      expect(source, `${file} must listen for messages`).toMatch(
        /addEventListener\(\s*['"]message['"]/,
      );
      expect(source, `${file} must recognize SKIP_WAITING`).toContain('SKIP_WAITING');
      expect(source, `${file} must actually hand over`).toContain('skipWaiting()');
    });
  }

  it('the development worker still does no caching', () => {
    // The fix must not turn the dev worker into a caching one -- serving yesterday's bundle is
    // the reason it is a no-op in the first place.
    const source = readFileSync(join(wwwroot, 'service-worker.js'), 'utf8');

    expect(source).not.toContain('caches.open');
    expect(source).not.toContain('respondWith');
  });
});
