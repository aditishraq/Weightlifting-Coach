/* Offline support for Weightlifting Coach.
   App files: network first so updates arrive as soon as they're deployed, falling back to the cache offline.
   Pinned MediaPipe files and fonts: cache first, since they never change. The 9 MB pose model and 12 MB
   runtime are cached the first time body tracking runs, not up front, so a visit never costs 21 MB of data
   by surprise. */

const SHELL = 'wl-coach-shell-v14';
const STATIC = 'wl-coach-static-v1';
const APP = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/state.js', 'js/sources.js', 'js/tracker.js', 'js/path.js', 'js/pose.js',
  'js/checks.js', 'js/draw.js', 'js/storage.js', 'js/library.js', 'js/pwa.js',
  'js/config.js', 'js/smooth.js', 'js/ncc.js', 'js/circles.js', 'js/track-worker.js', 'js/plate.js', 'js/engine.js', 'js/coach.js', 'js/coach-ui.js', 'js/dataset.js', 'js/reference.js', 'knowledge/good-lift.md', 'knowledge/coaching.md',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/logo.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('wl-coach-') || k.startsWith('bar-path-')) && k !== SHELL && k !== STATIC).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const pinned = (url.origin === location.origin && url.pathname.includes('/vendor/'))
    || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (pinned) e.respondWith(cacheFirst(req));
  else if (url.origin === location.origin) e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      // revalidate with the server: without this the browser's HTTP cache can serve stale modules for hours
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const page = await cache.match('index.html'); if (page) return page; }
    throw err;
  }
}
