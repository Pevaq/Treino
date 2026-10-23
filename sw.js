// Cache para abrir la app sin señal. Subir la versión en cada deploy: así el celular baja todo y la app se recarga sola.
const C = 'treino-v14';
const SHELL = ['./', 'index.html', 'app.js', 'plan.js', 'config.js', 'style.css', 'manifest.json', 'ayuda.md', 'prompt-rutina.md', 'icon.svg', 'icon-192.png', 'fonts/barlow-condensed-600.woff2', 'fonts/barlow-condensed-700.woff2', 'fonts/inter-tight.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// Responde desde cache y actualiza en segundo plano (los cambios se ven en la siguiente apertura).
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('.supabase.co')) return;
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (!hit) return net;
    net.catch(() => {});
    return hit;
  }));
});
