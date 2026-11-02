/* Offline support. App files: served from cache, refreshed in the background (new versions show
 * on the next open). Data files: network first, cached copy when offline. */
const CACHE = "gridiron-v1";
const SHELL = ["./", "index.html", "css/style.css", "js/sim.js", "js/app.js", "js/worker.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = url.pathname.includes("/data/") ? url.origin + url.pathname : e.request;   // ignore ?cache-busters for data
  if (url.pathname.includes("/data/")) {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(key, cp)); } return r; })
      .catch(() => caches.match(key)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
