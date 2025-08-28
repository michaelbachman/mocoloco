self.addEventListener('install', (e) => { self.skipWaiting() })
self.addEventListener('activate', (e) => { self.clients.claim() })

const CACHE = 'price-cache-v1'

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname === '/api/latest/XBTUSD') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(event.request)
      const networkPromise = fetch(event.request).then(async (res) => {
        try { await cache.put(event.request, res.clone()) } catch {}
        return res
      }).catch(() => null)
      if (cached) {
        networkPromise
        return cached
      }
      const net = await networkPromise
      return net || fetch(event.request)
    })())
  }
})
