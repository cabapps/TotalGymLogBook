// Caution! Be sure you understand the caveats before publishing an application with
// offline support. See https://aka.ms/blazor-offline-considerations

self.importScripts('./service-worker-assets.js');
self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => event.respondWith(onFetch(event)));
self.addEventListener('message', event => onMessage(event));

const cacheNamePrefix = 'offline-cache-';
const cacheName = `${cacheNamePrefix}${self.assetsManifest.version}`;
const offlineAssetsInclude = [ /\.dll$/, /\.pdb$/, /\.wasm/, /\.html/, /\.js$/, /\.json$/, /\.css$/, /\.woff$/, /\.png$/, /\.jpe?g$/, /\.gif$/, /\.ico$/, /\.blat$/, /\.dat$/, /\.webmanifest$/ ];
const offlineAssetsExclude = [
    /^service-worker\.js$/,
    // Azure Static Web Apps CONSUMES staticwebapp.config.json as configuration and refuses to
    // serve it, but it lives in wwwroot so Blazor lists it in the asset manifest anyway. The
    // precache below uses cache.addAll(), which is all-or-nothing: that single failing request
    // rejects the whole install, the browser discards the registration, and the app ends up
    // with an empty cache and NO offline support.
    //
    // This is invisible locally -- a plain static server serves the file happily, so
    // e2e/offline-check.mjs passes. It was found by e2e/diagnose-sw.mjs against the real
    // deployment, which replays each precache request individually. See docs/adr/0008.
    /^staticwebapp\.config\.json$/,
];

// Replace with your base path if you are hosting on a subfolder. Ensure there is a trailing '/'.
const base = "/";
const baseUrl = new URL(base, self.origin);
const manifestUrlList = self.assetsManifest.assets.map(asset => new URL(asset.url, baseUrl).href);

async function onInstall(event) {
    console.info('Service worker: Install');

    // Fetch and cache all matching items from the assets manifest
    const assetsRequests = self.assetsManifest.assets
        .filter(asset => offlineAssetsInclude.some(pattern => pattern.test(asset.url)))
        .filter(asset => !offlineAssetsExclude.some(pattern => pattern.test(asset.url)))
        .map(asset => new Request(asset.url, { integrity: asset.hash, cache: 'no-cache' }));
    await caches.open(cacheName).then(cache => cache.addAll(assetsRequests));
}

async function onActivate(event) {
    console.info('Service worker: Activate');

    // Delete unused caches
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys
        .filter(key => key.startsWith(cacheNamePrefix) && key !== cacheName)
        .map(key => caches.delete(key)));

    // Take over the page that just accepted the update, instead of waiting for it to navigate.
    // src/client/src/updates.ts reloads on the resulting 'controllerchange'; without this claim
    // that event never fires and the trainee taps Update to no effect.
    await self.clients.claim();
}

/**
 * The update handshake. A newly installed worker sits in 'waiting' until every client running
 * the old one closes -- which on an iOS home-screen PWA can be never, because resuming from the
 * app switcher does not retire the old client. The page prompts the trainee and posts this
 * message when they accept.
 *
 * skipWaiting() is deliberately NOT called unconditionally at install: the _framework assets
 * are content-fingerprinted, so swapping the cache out from under a running Blazor app can
 * fail its next lazy fetch mid-session. See docs/adr/0008.
 */
function onMessage(event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
}

async function onFetch(event) {
    let cachedResponse = null;
    if (event.request.method === 'GET') {
        // For all navigation requests, try to serve index.html from cache,
        // unless that request is for an offline resource.
        // If you need some URLs to be server-rendered, edit the following check to exclude those URLs
        const shouldServeIndexHtml = event.request.mode === 'navigate'
            && !manifestUrlList.some(url => url === event.request.url);

        const request = shouldServeIndexHtml ? 'index.html' : event.request;
        const cache = await caches.open(cacheName);
        cachedResponse = await cache.match(request);
    }

    return cachedResponse || fetch(event.request);
}
