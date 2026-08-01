/**
 * Service worker registration and the update handshake.
 *
 * The stock Blazor service worker precaches a new build on install and then WAITS: it stays in
 * the 'installed' state until every client using the old worker goes away. On a desktop tab
 * that resolves itself within a day. On an iPhone home-screen PWA it may never resolve --
 * resuming from the app switcher is not a fresh navigation and does not retire the old client
 * -- so the trainee runs whatever build they first installed, indefinitely, with no visible
 * way out. That is the bug this module exists for.
 *
 * Two halves, and both are required:
 *
 *   Something has to ASK. iOS does not poll for a new worker while the app is backgrounded, so
 *   we call registration.update() on load, on every return to the foreground, and hourly for
 *   sessions that stay open.
 *
 *   Something has to HAND OVER. A waiting worker only takes control when told to, so we
 *   message it SKIP_WAITING and reload once 'controllerchange' confirms the swap.
 *
 * The trainee is asked rather than reloaded from under themselves: a reload mid-set would
 * discard the rep count sitting in the stepper, which is not yet in IndexedDB.
 */

/** Long enough to be invisible; short enough that a phone left open overnight catches up. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Fired on window when a new build is installed and waiting. <tg-update-banner> listens. */
export const UPDATE_READY_EVENT = 'tg-update-ready';

let waiting: ServiceWorker | undefined;
let handingOver = false;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // controllerchange also fires on the very first registration, when the page went from no
    // controller to one. That is not an update and reloading there would be a startup loop.
    if (!handingOver) return;
    handingOver = false;
    window.location.reload();
  });

  void navigator.serviceWorker
    .register('service-worker.js', { updateViaCache: 'none' })
    .then((registration) => {
      // A worker already parked in 'waiting' when we arrive -- the common case on iOS, where
      // the update installed silently during an earlier session and has sat there ever since.
      announce(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') announce(installing);
        });
      });

      const check = (): void => {
        void registration.update().catch(() => {
          // Offline, or the host is down. Nothing to do and nothing worth logging: the next
          // foreground pass tries again.
        });
      };

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.setInterval(check, CHECK_INTERVAL_MS);
    })
    .catch((error: unknown) => {
      // No service worker means no offline support, which is a real loss but not a reason to
      // break the app -- everything except offline still works from the network.
      console.warn('Service worker registration failed', error);
    });
}

/**
 * A worker in 'installed' while a controller exists is a NEW build queued behind the running
 * one. Without a controller it is the first install on this device, which is not an update and
 * must not be announced -- there is nothing for the trainee to accept.
 */
function announce(worker: ServiceWorker | null): void {
  if (!worker || !navigator.serviceWorker.controller) return;

  waiting = worker;
  window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT));
}

/** True once a newer build is installed and waiting for permission to take over. */
export function isUpdateReady(): boolean {
  return waiting !== undefined;
}

/**
 * Accepts the waiting update. The reload happens in the controllerchange handler rather than
 * here: reloading before the new worker has taken control just re-serves the old cache.
 */
export function applyUpdate(): void {
  if (!waiting) return;

  handingOver = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}
