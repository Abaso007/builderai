/**
 * Service Worker for caching /api/dashboard/file responses
 *
 * Strategy:
 * - Cache-first for /api/dashboard/file (immutable files with versioned URLs)
 * - Network-first for everything else
 */

const CACHE_NAME = "lakehouse-files-v1"
const FILE_URL_PATTERN = /\/api\/dashboard\/file\?/

// Install event - open cache
self.addEventListener("install", (event) => {
  console.info("[SW] Installing service worker")
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => {
      console.info("[SW] Cache opened")
      return self.skipWaiting()
    })
  )
})

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  console.info("[SW] Activating service worker")
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.info("[SW] Deleting old cache:", name)
              return caches.delete(name)
            })
        )
      })
      .then(() => self.clients.claim())
  )
})

// Fetch event - intercept requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)

  // Only cache /api/dashboard/file requests
  if (!FILE_URL_PATTERN.test(url.pathname + url.search)) {
    return // Let browser handle normally
  }

  event.respondWith(cacheFirstStrategy(event.request))
})

/**
 * Cache-first strategy for file downloads
 *
 * 1. Check cache first
 * 2. If not in cache, fetch from network
 * 3. Store successful responses in cache
 * 4. Files are immutable (versioned URLs), so cache indefinitely
 */
async function cacheFirstStrategy(request) {
  const cache = await caches.open(CACHE_NAME)

  // Check cache first
  const cachedResponse = await cache.match(request)
  if (cachedResponse) {
    console.info("[SW] Cache hit:", request.url)
    return cachedResponse
  }

  console.info("[SW] Cache miss, fetching:", request.url)

  try {
    const networkResponse = await fetch(request)

    // Only cache successful responses
    if (networkResponse.ok) {
      // Clone the response since we need to use it twice
      const responseToCache = networkResponse.clone()

      // Store in cache (don't await - let it happen in background)
      cache.put(request, responseToCache).catch((err) => {
        console.warn("[SW] Failed to cache response:", err)
      })
    }

    return networkResponse
  } catch (error) {
    console.error("[SW] Fetch failed:", error)
    throw error
  }
}

// Message handler for cache management
self.addEventListener("message", (event) => {
  if (event.data.type === "CLEAR_CACHE") {
    console.info("[SW] Clearing cache")
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0]?.postMessage({ success: true })
    })
  }

  if (event.data.type === "GET_CACHE_STATS") {
    getCacheStats().then((stats) => {
      event.ports[0]?.postMessage(stats)
    })
  }
})

/**
 * Get cache statistics
 */
async function getCacheStats() {
  const cache = await caches.open(CACHE_NAME)
  const keys = await cache.keys()

  let totalBytes = 0
  for (const request of keys) {
    const response = await cache.match(request)
    if (response) {
      const blob = await response.clone().blob()
      totalBytes += blob.size
    }
  }

  return { count: keys.length, totalBytes }
}
