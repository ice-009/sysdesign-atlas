/* Service worker for the offline edition.

   Install downloads the whole curriculum — the app shell plus every topic — so
   once it activates, nothing needs the network again. Topic files carry a
   content hash in their name and live in one long-lived cache, so an update
   only fetches the topics that changed, and a download interrupted by flaky
   Wi-Fi resumes where it stopped instead of starting over.

   The build replaces the marker below with BUILD, SHELL_FILES and CONTENT_FILES. */

/* @manifest */

const SHELL = `atlas-ipad-shell-${BUILD}`;
const CONTENT = 'atlas-ipad-content';
const PARALLEL = 6;

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const c of clients) c.postMessage({ ...msg, build: BUILD });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));

      const content = await caches.open(CONTENT);
      const have = new Set((await content.keys()).map((r) => r.url));
      const todo = CONTENT_FILES.filter((u) => !have.has(new URL(u, self.location).href));
      const total = CONTENT_FILES.length;
      let done = total - todo.length;
      let sent = 0;

      broadcast({ type: 'progress', done, total });

      let next = 0;
      async function worker() {
        while (next < todo.length) {
          const url = todo[next++];
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
          await content.put(url, res);
          done++;
          if (Date.now() - sent > 150 || done === total) {
            sent = Date.now();
            broadcast({ type: 'progress', done, total });
          }
        }
      }

      try {
        await Promise.all(Array.from({ length: PARALLEL }, worker));
      } catch (err) {
        // Files fetched so far stay cached; the next attempt picks up from here.
        broadcast({ type: 'failed', error: String(err && err.message ? err.message : err) });
        throw err;
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('atlas-ipad-shell-') && key !== SHELL) await caches.delete(key);
      }
      const keep = new Set(CONTENT_FILES.map((u) => new URL(u, self.location).href));
      const content = await caches.open(CONTENT);
      for (const req of await content.keys()) {
        if (!keep.has(req.url)) await content.delete(req);
      }
      await self.clients.claim();
      broadcast({ type: 'activated' });
    })()
  );
});

// The page asks for this when the reader taps "Reload" on the update banner.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  // Every page load is the same single-page shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shellUrl = new URL('index.html', self.registration.scope).href;
        const cached =
          (await (await caches.open(SHELL)).match(shellUrl)) || (await caches.match(shellUrl));
        if (cached) return cached;
        try {
          return await fetch(req);
        } catch {
          return new Response('<h1>Offline</h1><p>Open the app once while online to download it.</p>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // Topics read before the full download finished get kept too.
        if (res.ok && /\/(topics\/|search\.)/.test(url.pathname)) {
          const content = await caches.open(CONTENT);
          await content.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })()
  );
});
