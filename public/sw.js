// Minimal service worker — exists only so the app meets the browser's
// "installable PWA" bar (a registered service worker with a fetch handler).
// It deliberately caches nothing: Click ships real fixes often, and a
// caching service worker risks serving stale app.js/index.html after a
// deploy. Every request is left to the network exactly as if there were no
// service worker at all.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
