// Minimal service worker: makes the app installable ("Add to Home Screen")
// and lets the page show system notifications. Network-only on purpose —
// a call button must never be served from a stale cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      const url = e.notification.data && e.notification.data.url;
      const win = wins.find((w) => url && w.url.includes(url));
      return win ? win.focus() : self.clients.openWindow(url || '/');
    })
  );
});
