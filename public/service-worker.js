const CACHE_NAME = 'paperlex-shell-v6';
const LOCAL_FALLBACK_URL = '/?local=1';
const CONFIG_URL = '/api/config';
const SHELL = [
  LOCAL_FALLBACK_URL,
  '/styles.css',
  '/app.js',
  '/definition-format.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await cache.addAll(SHELL);
    const config = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (config.ok) await cache.put(CONFIG_URL, config);
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        if (event.request.mode === 'navigate') {
          const config = await cloudConfig();
          if (config?.libraryUrl && url.searchParams.get('local') !== '1') {
            return Response.redirect(config.libraryUrl, 302);
          }
        }
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match(LOCAL_FALLBACK_URL);
        return Response.error();
      }),
  );
});

async function cloudConfig() {
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (response.ok) return response.json();
  } catch {
    // The cached mode below still prevents an implicit local/cloud switch.
  }
  const cached = await caches.match(CONFIG_URL);
  return cached?.json();
}
