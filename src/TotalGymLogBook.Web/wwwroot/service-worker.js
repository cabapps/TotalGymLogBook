// In development, always fetch from the network and do not enable offline support.
// This is because caching would make development more difficult (changes would not
// be reflected on the first load after each change).
self.addEventListener('fetch', () => { });

// The update handshake, which the development worker needs just as much as the published one.
//
// The build stamps this file with a manifest version that changes whenever any static asset
// does, so every rebuild produces a byte-different worker. The browser installs it, parks it in
// 'waiting' behind the worker already controlling the page, and src/client/src/updates.ts quite
// correctly offers the trainee an update.
//
// Without this listener that offer cannot be honored: SKIP_WAITING arrives, nothing answers it,
// the worker waits forever, 'controllerchange' never fires, and the banner sits on "Updating..."
// for the rest of the session. That is a development-only dead end for a production code path,
// which is the worst place to have one -- the mechanism looks broken exactly where you are
// working on it, and works exactly where you cannot watch it.
//
// Kept in sync with service-worker.published.js. test/service-worker.test.ts checks that.
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
