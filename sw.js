// Network-first service worker for the app shell. It never touches database/auth traffic
// (Firestore and Firebase Auth have their own offline handling).
const CACHE = 'tnt-v3.0.0';
const CORE = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const CACHEABLE = url => url.origin === self.location.origin || ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'].includes(url.hostname);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http') || !CACHEABLE(url) || url.pathname.startsWith('/__/')) return;
  e.respondWith((async () => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    });
    net.catch(() => {});
    try { return await withTimeout(net, 5000); }
    catch {
      const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await caches.match('./index.html'));
      return hit || net;
    }
  })());
});
