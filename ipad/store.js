/* On-device database for the iPad edition: every mark you make, the queue of
   changes waiting to upload, and a little bookkeeping. IndexedDB rather than
   localStorage because writes are transactional and the space is far larger.

   A record is { id, kind, topic, data, clock, deleted, at }:
     kind   highlight | stroke | card | done | conf | bookmark | note
     clock  hybrid logical clock, "<ms36>-<counter36>-<device>". Strings sort
            in time order, and the clock never runs backwards even if the
            iPad's time is changed.

   put() writes the record and its outbox entry in ONE transaction, so a change
   can't be saved without also being queued for upload, or the other way round.
   The outbox is keyed by record id: ten edits to one note while offline
   upload as one change.

   Exposes window.AtlasStore. */

(function () {
  'use strict';

  const DB_NAME = 'atlas-ipad';
  const DB_VERSION = 1;
  const listeners = new Set();
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        // Versioned so a later release can add stores without losing anything.
        if (e.oldVersion < 1) {
          const records = db.createObjectStore('records', { keyPath: 'id' });
          records.createIndex('topic', 'topic');
          records.createIndex('kind', 'kind');
          db.createObjectStore('outbox', { keyPath: 'id' });
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
    return dbPromise;
  }

  /* Run fn inside a transaction; resolves with fn's return value once the
     transaction has COMMITTED — i.e. once the data is on disk. */
  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      const s = {};
      for (const name of [].concat(stores)) s[name] = tx.objectStore(name);
      Promise.resolve(fn(s, tx)).then((r) => (result = r), (err) => {
        try { tx.abort(); } catch { /* already finished */ }
        reject(err);
      });
    });
  }

  const req = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  /* ---------- meta ---------- */

  async function getMeta(k, fallback) {
    const row = await run('meta', 'readonly', (s) => req(s.meta.get(k)));
    return row ? row.v : fallback;
  }

  function setMeta(k, v) {
    return run('meta', 'readwrite', (s) => {
      if (v === undefined) s.meta.delete(k);
      else s.meta.put({ k, v });
    });
  }

  /* ---------- clock ---------- */

  let device = null;
  let last = { ms: 0, c: 0 };

  const b36 = (n, w) => n.toString(36).padStart(w, '0');
  const fmt = (t) => `${b36(t.ms, 9)}-${b36(t.c, 4)}-${device}`;
  function parse(clock) {
    const [ms, c] = String(clock).split('-');
    return { ms: parseInt(ms, 36) || 0, c: parseInt(c, 36) || 0 };
  }

  const ready = (async () => {
    try {
      device = await getMeta('device');
      if (!device) {
        device = Math.random().toString(36).slice(2, 10);
        await setMeta('device', device);
      }
      last = await getMeta('clock', last);
    } catch {
      device = device || 'nodb';
    }
  })();

  function tick() {
    const now = Date.now();
    last = now > last.ms ? { ms: now, c: 0 } : { ms: last.ms, c: last.c + 1 };
    return fmt(last);
  }

  // Adopt a remote clock so our next local edit sorts after anything seen.
  function observe(clock) {
    const t = parse(clock);
    if (t.ms > last.ms || (t.ms === last.ms && t.c > last.c)) last = t;
  }

  /* ---------- records ---------- */

  function emit(records, origin) {
    for (const fn of listeners) {
      try {
        fn(records, origin);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /* A change made on this device: stamp it, save it, queue it. Accepts one
     record or an array (one transaction, one undo step). */
  async function put(input) {
    await ready;
    const list = [].concat(input).map((r) => ({
      id: r.id,
      kind: r.kind,
      topic: r.topic,
      data: r.data || {},
      deleted: !!r.deleted,
      clock: tick(),
      at: Date.now(),
    }));
    await run(['records', 'outbox', 'meta'], 'readwrite', (s) => {
      for (const r of list) {
        s.records.put(r);
        s.outbox.put(r);
      }
      s.meta.put({ k: 'clock', v: last });
    });
    emit(list, 'local');
    return Array.isArray(input) ? list : list[0];
  }

  /* Records from the server (or an import). Newest clock wins; a remote record
     that beats a queued local edit also cancels that upload. Returns the
     records that actually changed something here. */
  async function applyRemote(remote, { queue = false } = {}) {
    await ready;
    const changed = [];
    await run(['records', 'outbox', 'meta'], 'readwrite', async (s) => {
      for (const r of remote) {
        observe(r.clock);
        const local = await req(s.records.get(r.id));
        if (local && local.clock >= r.clock) continue;
        const rec = {
          id: r.id,
          kind: r.kind,
          topic: r.topic,
          data: r.data || {},
          deleted: !!r.deleted,
          clock: r.clock,
          at: Date.now(),
        };
        s.records.put(rec);
        if (queue) s.outbox.put(rec);
        else {
          const pending = await req(s.outbox.get(r.id));
          if (pending && pending.clock < r.clock) s.outbox.delete(r.id);
        }
        changed.push(rec);
      }
      s.meta.put({ k: 'clock', v: last });
    });
    if (changed.length) emit(changed, 'remote');
    return changed;
  }

  const get = (id) => run('records', 'readonly', (s) => req(s.records.get(id)));
  const byTopic = (topic) => run('records', 'readonly', (s) => req(s.records.index('topic').getAll(topic)));
  const byKind = (kind) => run('records', 'readonly', (s) => req(s.records.index('kind').getAll(kind)));
  const all = () => run('records', 'readonly', (s) => req(s.records.getAll()));

  /* ---------- outbox ---------- */

  const outbox = () => run('outbox', 'readonly', (s) => req(s.outbox.getAll()));
  const pendingCount = () => run('outbox', 'readonly', (s) => req(s.outbox.count()));

  /* The server took these. Drop each from the outbox unless it was edited
     again while the upload was in flight (its clock moved on). */
  function ack(sent) {
    return run('outbox', 'readwrite', async (s) => {
      for (const r of sent) {
        const cur = await req(s.outbox.get(r.id));
        if (cur && cur.clock === r.clock) s.outbox.delete(r.id);
      }
    });
  }

  /* Queue records for upload again, unchanged (used when this iPad's data
     moves to a different account). */
  function requeue(list) {
    return run('outbox', 'readwrite', (s) => {
      for (const r of list) s.outbox.put(r);
    });
  }

  /* ---------- stroke drafts ---------- */

  /* The stroke being drawn is checkpointed here every quarter second, so iOS
     closing the app mid-stroke costs at most that much ink. */
  const saveDraft = (draft) => setMeta('draft', draft);
  const takeDraft = async () => {
    const d = await getMeta('draft', null);
    if (d) await setMeta('draft', undefined);
    return d;
  };

  /* ---------- housekeeping ---------- */

  /* Deleted marks can be restored for 30 days. After that the bulky stroke
     data is dropped locally; the tombstone stays so the delete still syncs. */
  async function compact(days = 30) {
    const cutoff = Date.now() - days * 864e5;
    await run('records', 'readwrite', async (s) => {
      const rows = await req(s.records.getAll());
      for (const r of rows) {
        if (r.deleted && r.data && r.data.del && r.data.del < cutoff && !r.data.compacted) {
          s.records.put({ ...r, data: { del: r.data.del, compacted: true } });
        }
      }
    });
  }

  window.AtlasStore = {
    ready,
    put,
    applyRemote,
    get,
    byTopic,
    byKind,
    all,
    outbox,
    pendingCount,
    ack,
    requeue,
    getMeta,
    setMeta,
    saveDraft,
    takeDraft,
    compact,
    observe,
    newId: (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
})();
