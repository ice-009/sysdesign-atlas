/* Sync for the iPad edition: uploads the outbox and downloads changes from
   your Atlas account whenever there is a connection.

   Safari can't run a web app in the background, so this runs while Atlas is
   open: at launch, the moment the connection comes back, when you switch back
   to the app, a few seconds after you stop marking, and every couple of
   minutes. Everything works signed out; signing in uploads the backlog.

   Conflicts:
     - marks and study state: newest edit wins (the store compares clocks);
     - typed notes edited on two devices: both texts are kept, never one
       silently replacing the other.

   Exposes window.AtlasSync. */

(function () {
  'use strict';

  const Atlas = window.Atlas;
  const Store = window.AtlasStore;
  if (!Atlas || !Store) return;

  const API = String(Atlas.data.api || '/api/ipad').replace(/\/$/, '');
  const STATE_KINDS = new Set(['done', 'conf', 'bookmark', 'note']);
  const BATCH_MAX = 200;
  const BATCH_BYTES = 600 * 1024;
  const esc = Atlas.esc;

  const st = {
    token: null,
    email: '',
    account: '', // email of the account this iPad's data last synced with
    cursor: '0',
    lastSync: 0,
    pending: 0,
    busy: false,
    again: false,
    error: '',
    message: '', // shown in Settings, e.g. "This iPad was signed out"
    failures: 0,
  };
  let timer = 0;

  /* ---------- status ---------- */

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return Atlas.fmtDate(ms);
  }

  function status() {
    if (!st.token) {
      return st.pending
        ? { dot: 'wait', text: `${st.pending} change${st.pending === 1 ? '' : 's'} on this iPad only · sign in to back up` }
        : { dot: '', text: 'Not backed up · sign in to sync' };
    }
    if (st.busy) return { dot: 'busy', text: st.pending ? `Syncing ${st.pending} change${st.pending === 1 ? '' : 's'}…` : 'Syncing…' };
    if (!navigator.onLine && st.pending) return { dot: 'wait', text: `${st.pending} change${st.pending === 1 ? '' : 's'} waiting for a connection` };
    if (st.error) return { dot: 'bad', text: st.error };
    if (st.pending) return { dot: 'wait', text: `${st.pending} change${st.pending === 1 ? '' : 's'} waiting to sync` };
    return { dot: 'ok', text: st.lastSync ? `All changes saved to your account · ${ago(st.lastSync)}` : 'Signed in' };
  }

  function paint() {
    const s = status();
    const foot = document.getElementById('atlas-sb-sync');
    if (foot) {
      foot.innerHTML = `<a href="#/settings"><span class="status-dot ${s.dot === 'ok' ? 'ok' : s.dot === 'busy' ? 'busy' : s.dot === 'wait' ? 'wait' : s.dot === 'bad' ? 'bad' : ''}"></span>${esc(s.text)}</a>`;
    }
    const line = document.getElementById('atlas-sync-line');
    if (line) line.textContent = s.text;
  }

  async function refreshPending() {
    try {
      st.pending = await Store.pendingCount();
    } catch {
      /* database unavailable — leave the count as it was */
    }
    paint();
  }

  /* ---------- scheduling ---------- */

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms);
  }

  window.addEventListener('online', () => {
    st.error = '';
    paint();
    schedule(300);
  });
  window.addEventListener('offline', paint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.token) schedule(600);
  });
  setInterval(() => {
    if (st.token && (st.pending || Date.now() - st.lastSync > 5 * 60 * 1000)) syncNow();
    else paint(); // keeps "2 min ago" honest
  }, 120 * 1000);

  // Every local change (marks, progress) lands in the outbox via the store.
  Store.subscribe((records, origin) => {
    if (origin !== 'local') return;
    refreshPending();
    if (st.token) schedule(3000);
  });

  // Study state changes from app.js become records like everything else.
  Atlas.on('state', ({ kind, slug, data, deleted }) => {
    Store.put({ id: `${kind}:${slug}`, kind, topic: slug, data, deleted }).catch((err) =>
      console.error('[sync] could not queue', err)
    );
  });

  /* ---------- the sync loop ---------- */

  function takeBatch(out) {
    out.sort((a, b) => (a.clock < b.clock ? -1 : 1));
    const batch = [];
    let bytes = 0;
    for (const r of out) {
      const size = JSON.stringify(r.data || {}).length + 200;
      if (batch.length && (batch.length >= BATCH_MAX || bytes + size > BATCH_BYTES)) break;
      batch.push(r);
      bytes += size;
    }
    return batch;
  }

  const toWire = (r) => ({ id: r.id, kind: r.kind, topic: r.topic, data: r.data, clock: r.clock, deleted: !!r.deleted });

  async function post(path, body, method = 'POST') {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 30000);
    try {
      return await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(st.token ? { Authorization: `Bearer ${st.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(kill);
    }
  }

  function mergeText(mine, theirs) {
    const a = mine.trim();
    const b = theirs.trim();
    if (a.includes(b)) return mine;
    if (b.includes(a)) return theirs;
    return `${mine.replace(/\s+$/, '')}\n\n— from your other device —\n${theirs.replace(/^\s+/, '')}`;
  }

  /* Apply what the server sent. A note that changed both here (still queued)
     and elsewhere keeps both texts; everything else is newest-wins. */
  async function merge(records, sent) {
    if (!records.length) return;
    const queued = new Map((await Store.outbox()).map((r) => [r.id, r]));
    for (const r of sent) if (!queued.has(r.id)) queued.set(r.id, r);
    const me = `-${await Store.getMeta('device', '')}`;

    const plain = [];
    const notes = [];
    for (const r of records) {
      const mine = queued.get(r.id);
      const theirsIsMine = String(r.clock).endsWith(me); // an echo of our own older write
      if (r.kind === 'note' && mine && !theirsIsMine && !mine.deleted && !r.deleted && mine.clock !== r.clock) {
        const a = String((mine.data && mine.data.text) || '');
        const b = String((r.data && r.data.text) || '');
        if (a.trim() && b.trim() && a.trim() !== b.trim()) {
          notes.push({ r, mine, text: mergeText(a, b) });
          continue;
        }
      }
      plain.push(r);
    }

    const changed = await Store.applyRemote(plain);
    for (const c of changed) {
      if (STATE_KINDS.has(c.kind)) Atlas.applyState(c.kind, c.topic, c.data, c.deleted);
    }
    for (const { r, mine, text } of notes) {
      Store.observe(r.clock);
      const rec = await Store.put({ id: r.id, kind: 'note', topic: r.topic, data: { ...mine.data, text }, deleted: false });
      Atlas.applyState('note', rec.topic, rec.data, false);
      Atlas.toast('A note edited on two devices was kept in full — both versions are in it.');
    }
  }

  async function syncNow() {
    clearTimeout(timer);
    if (!st.token) return paint();
    if (st.busy) {
      st.again = true;
      return;
    }
    if (!navigator.onLine) return paint();

    st.busy = true;
    paint();
    try {
      for (let round = 0; round < 60; round++) {
        const batch = takeBatch(await Store.outbox());
        const res = await post('/sync', { cursor: st.cursor, changes: batch.map(toWire) });
        if (res.status === 401) {
          await forgetToken('This iPad was signed out of your account. Sign in again to keep syncing — nothing on the iPad was lost.');
          return;
        }
        if (res.status === 409) continue; // first-sync race on the server; just go again
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();

        await merge([...(body.changes || []), ...(body.rejected || [])], batch);
        await Store.ack(batch);
        st.cursor = String(body.cursor || st.cursor);
        await Store.setMeta('cursor', st.cursor);
        st.pending = await Store.pendingCount();
        paint();
        if (!body.hasMore && (!st.pending || !batch.length)) break;
      }
      st.lastSync = Date.now();
      await Store.setMeta('lastSync', st.lastSync);
      st.error = '';
      st.failures = 0;
    } catch (err) {
      st.failures++;
      st.error = navigator.onLine ? 'Couldn’t reach your account — will retry' : '';
      // Back off: 5 s, 20 s, 1 min, then every 2 min.
      schedule([5000, 20000, 60000][st.failures - 1] || 120000);
      console.warn('[sync]', err);
    } finally {
      st.busy = false;
      await refreshPending();
      if (st.again) {
        st.again = false;
        schedule(500);
      }
    }
  }

  /* ---------- account ---------- */

  async function forgetToken(message) {
    st.token = null;
    st.email = '';
    st.message = message || '';
    await Store.setMeta('token', undefined);
    await Store.setMeta('email', undefined);
    paint();
    paintSettings();
  }

  async function signIn(email, password) {
    const res = await post('/session', { email, password, device: deviceName() }).catch(() => null);
    if (!res) throw new Error('Couldn’t reach the server. Check your connection and try again.');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Sign-in failed. Try again.');

    // Marks made under a different account are never merged silently.
    if (st.account && st.account !== body.email) {
      const move = confirm(
        `This iPad's marks and progress were last synced with ${st.account}.\n\nAdd them to ${body.email} as well?`
      );
      if (!move) {
        await post('/session', null, 'DELETE').catch(() => {});
        throw new Error(`Not signed in. Export your data first if you want to keep ${st.account}'s marks separate.`);
      }
      await requeueEverything();
    }
    if (st.account !== body.email) {
      st.cursor = '0';
      await Store.setMeta('cursor', '0');
    }

    st.token = body.token;
    st.email = body.email;
    st.account = body.email;
    st.message = '';
    await Store.setMeta('token', st.token);
    await Store.setMeta('email', st.email);
    await Store.setMeta('account', st.account);
    paintSettings();
    await syncNow();
  }

  async function signOut() {
    await post('/session', null, 'DELETE').catch(() => {});
    await forgetToken('Signed out. Your marks are still on this iPad.');
  }

  // Signing in to a different account: everything on this iPad goes up to
  // the new account as well, with its original clocks.
  async function requeueEverything() {
    await Store.requeue(await Store.all());
  }

  function deviceName() {
    const ua = navigator.userAgent;
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    return `${ipad ? 'iPad' : 'Browser'} · Atlas offline edition`;
  }

  /* ---------- Settings → Sync & backup ---------- */

  function paintSettings() {
    const slot = document.querySelector('[data-slot="sync"]');
    if (!slot) return;
    const s = status();
    if (!st.token) {
      slot.innerHTML = `<section class="block"><h2>Sync &amp; backup</h2>
        <div class="list">
          <form class="set-row stack sync-form" id="atlas-signin" novalidate>
            <div><b>Back up to your Atlas account</b>
              <small>Highlights, ink, progress, bookmarks and notes sync whenever you're online, and the website shows the same progress. Everything keeps working offline either way.</small></div>
            ${st.message ? `<div class="sync-msg">${esc(st.message)}</div>` : ''}
            <input id="atlas-email" class="field" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="Email" required>
            <input id="atlas-password" class="field" type="password" autocomplete="current-password" placeholder="Password" required>
            <div class="form-row"><button class="btn primary" type="submit" id="atlas-signin-btn">Sign in</button><span class="form-err" id="atlas-signin-err" role="alert"></span></div>
            <small>No account yet? <a href="/signup" target="_blank" rel="noopener">Create one on the website</a>, then sign in here.</small>
          </form>
        </div></section>`;
      const form = slot.querySelector('#atlas-signin');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('#atlas-signin-btn');
        const err = form.querySelector('#atlas-signin-err');
        const email = form.querySelector('#atlas-email').value.trim();
        const password = form.querySelector('#atlas-password').value;
        if (!email || !password) {
          err.textContent = 'Enter your email and password.';
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        err.textContent = '';
        try {
          await signIn(email, password);
          Atlas.toast('Signed in — your marks are syncing.');
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
          btn.textContent = 'Sign in';
        }
      });
      return;
    }
    slot.innerHTML = `<section class="block"><h2>Sync &amp; backup</h2>
      <div class="list">
        <div class="set-row"><div><b>Signed in as ${esc(st.email)}</b><small id="atlas-sync-line">${esc(s.text)}</small></div>
          <button class="btn small" type="button" data-sync-act="now">Sync now</button></div>
        <div class="set-row"><div><b>Sign out</b><small>Your marks and progress stay on this iPad. Nothing is deleted.</small></div>
          <button class="btn small" type="button" data-sync-act="signout">Sign out</button></div>
      </div></section>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sync-act]');
    if (!btn) return;
    if (btn.dataset.syncAct === 'now') {
      if (!navigator.onLine) Atlas.toast('You’re offline — changes will sync when the connection is back.');
      st.error = '';
      syncNow();
    } else if (btn.dataset.syncAct === 'signout') {
      signOut();
    }
  });

  Atlas.on('render', ({ route }) => {
    if (route && route.name === 'settings') paintSettings();
    paint();
  });

  /* ---------- start ---------- */

  /* Progress, bookmarks and notes saved before sync existed get queued once,
     so the first sign-in uploads them too. */
  async function seedState() {
    if (await Store.getMeta('seeded', false)) return;
    const have = new Set((await Store.all()).map((r) => r.id));
    const list = [];
    for (const t of Atlas.topics) {
      for (const kind of STATE_KINDS) {
        const id = `${kind}:${t.slug}`;
        if (have.has(id)) continue;
        const rec = Atlas.stateRecord(kind, t.slug);
        if (rec && !rec.deleted) list.push({ id, kind, topic: t.slug, ...rec });
      }
    }
    if (list.length) await Store.put(list);
    await Store.setMeta('seeded', true);
  }

  (async () => {
    try {
      await Store.ready;
      st.token = await Store.getMeta('token', null);
      st.email = await Store.getMeta('email', '');
      st.account = await Store.getMeta('account', '');
      st.cursor = await Store.getMeta('cursor', '0');
      st.lastSync = await Store.getMeta('lastSync', 0);
      await seedState();
      await refreshPending();
      if (st.token) schedule(800);
    } catch (err) {
      console.warn('[sync] unavailable', err);
    }
    paint();
  })();

  window.AtlasSync = { syncNow, status, signIn, signOut, state: st };
})();
