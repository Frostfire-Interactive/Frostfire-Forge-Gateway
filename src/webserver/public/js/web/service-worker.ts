/// <reference lib="webworker" />
// Service Worker: HTTP-level cache for large, rarely-changing asset-server
// binaries (sprites, tilesets, icons). Transpiled to service-worker.js by
// src/utility/transpiler.ts and served at /service-worker.js (root scope) by
// the webserver.

declare const self: ServiceWorkerGlobalScope;

// v4: drops the entries v3 took with no way to tell them apart from a newer
// copy (activate deletes every other cache name).
const ASSET_CACHE = 'asset-cache-v4';
// The asset version each asset server had when its entries were last checked,
// one entry per origin. Its own cache, so eviction never drops it.
const VERSION_CACHE = 'asset-cache-v4-versions';

// How long a version check holds before the next request checks again.
const VERSION_CHECK_MS = 60_000;

// Asset-server GET endpoints whose responses are kept cache-first. They are
// kept until the asset server's /asset-version changes (a restart with new
// sprites, icons or sprite sheets), then fetched again.
// Matched by exact pathname so e.g. "/sprite" doesn't also swallow
// "/sprite-sheet-image".
// "/tileset" is NOT here: tileset images get edited in place under the same
// name, and a cache-first entry kept serving the old image on every normal
// reload (only a hard reload, which bypasses the worker, showed the new one).
// The asset server answers /tileset with an ETag and "Cache-Control: no-cache",
// so the browser's HTTP cache revalidates it each load (a 304 when unchanged).
const CACHEABLE_PATHS: ReadonlySet<string> = new Set([
  '/sprite',
  '/sprite-sheet-image',
  '/sprite-sheet-template',
  '/sprite-sheets',
  '/sprite-template',
  '/icon',
]);

// Soft cap on total cached bytes; oldest entries are evicted past this.
const MAX_CACHE_SIZE = 100 * 1024 * 1024;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (name === ASSET_CACHE || name === VERSION_CACHE ? undefined : caches.delete(name))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!CACHEABLE_PATHS.has(url.pathname)) return;

  event.respondWith(handleCacheStrategy(event.request));
});

// Cache-first: serve from Cache Storage when present, otherwise fetch and store.
async function handleCacheStrategy(request: Request): Promise<Response> {
  await checkVersion(new URL(request.url).origin);

  const cached = await fromCache(request);
  if (cached) return cached;

  let response: Response;
  try {
    // no-cache: the browser's HTTP cache revalidates its copy (a 304 when it
    // is current) instead of handing back one it kept for a year.
    response = await fetch(request, { cache: 'no-cache' });
  } catch {
    const stored = await fromCache(request);
    if (stored) return stored;
    return new Response('Offline - asset not cached', { status: 503 });
  }

  // Cache real assets only. NOT the "missing" fallback: Cache Storage has no
  // TTL, so a cached fallback would mask a real asset added later until the
  // whole cache is bumped. The asset server sends the fallback with a short
  // max-age, so the browser's HTTP cache handles placeholder de-duplication
  // and self-expires.
  if (
    response.status === 200 &&
    !response.headers.get('X-Asset-Fallback')
  ) {
    await store(request, response.clone());
  }

  return response;
}

// The last version check per asset server origin, shared by the requests made
// while it runs. A worker the browser stopped and started again checks anew.
const versionChecks = new Map<string, { at: number; done: Promise<void> }>();

function checkVersion(origin: string): Promise<void> {
  const last = versionChecks.get(origin);
  if (last && Date.now() - last.at < VERSION_CHECK_MS) return last.done;
  const done = dropIfVersionChanged(origin);
  versionChecks.set(origin, { at: Date.now(), done });
  return done;
}

// Asks the asset server for its asset version and, when it differs from the
// one its entries were taken at, drops every entry from that asset server. An
// asset server that does not answer leaves the cache as it is.
async function dropIfVersionChanged(origin: string): Promise<void> {
  try {
    const response = await fetch(`${origin}/asset-version`, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) return;
    const version = String((await response.json())?.version ?? '');
    if (!version) return;

    const versions = await caches.open(VERSION_CACHE);
    const key = `${origin}/asset-version`;
    const known = await versions.match(key);
    if (known && (await known.text()) === version) return;

    const cache = await caches.open(ASSET_CACHE);
    for (const request of await cache.keys()) {
      if (new URL(request.url).origin === origin) await cache.delete(request);
    }
    await versions.put(key, new Response(version));
  } catch {
    // Best-effort: the cache is kept and checked again later.
  }
}

// Cache Storage can fail on its own (out of quota, a damaged profile). This
// worker only speeds assets up, so a failure is a miss and the network answers:
// without that, every sprite and icon comes back "offline" and the world never
// loads, though the asset server is fine.
async function fromCache(request: Request): Promise<Response | undefined> {
  try {
    return await caches.match(request);
  } catch {
    return undefined;
  }
}

async function store(request: Request, response: Response): Promise<void> {
  try {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response);
    await evictIfOverBudget(cache);
  } catch {
    // Storing is best-effort: the asset is fetched again next time.
  }
}

async function evictIfOverBudget(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();

    let total = 0;
    const entries: Array<{ request: Request; size: number; url: string }> = [];
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) continue;
      const size = await responseSize(response);
      entries.push({ request, size, url: request.url });
      total += size;
    }

    if (total <= MAX_CACHE_SIZE) return;

    // Deterministic order (by URL) for a stable eviction set.
    entries.sort((a, b) => a.url.localeCompare(b.url));

    let freed = 0;
    const need = total - MAX_CACHE_SIZE;
    for (const entry of entries) {
      if (freed >= need) break;
      await cache.delete(entry.request);
      freed += entry.size;
    }
  } catch {
    // Eviction is best-effort.
  }
}

async function responseSize(response: Response): Promise<number> {
  try {
    return (await response.clone().blob()).size;
  } catch {
    return 0;
  }
}
