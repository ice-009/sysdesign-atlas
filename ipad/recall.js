/* Recall — the learning layer of the iPad edition.

   Topics open with a "Guess first" box (a :::predict callout) and end with
   "Check yourself" cards (a ```recall block; see lib/markdown.ts). This file
   makes them work:

     Topic page   Each guess-first question gets a box for your guess, kept on
                  this device and shown again beside the cards, so you can see
                  what you thought before reading. Each card can be graded
                  after you reveal it — Again, Hard, Good, Easy — which adds it
                  to your deck.
     Review page  The cards that are due, mixed across topics, one at a time:
                  try, reveal, grade. A few new cards a day join from topics
                  you've read. Space reveals, 1–4 grade.
     Elsewhere    A Home tile and a sidebar badge with the count due, and a
                  memory section on the Progress page.

   Scheduling is FSRS-5 (lib/fsrs.ts, bundled by the build as
   window.AtlasFSRS). Each card's state is one record in the AtlasStore — kind
   "srs", id "srs:<topic>:<card>" — so it syncs like everything else; review
   settings are the record "srs:settings". */

(function () {
  'use strict';

  const Atlas = window.Atlas;
  const Store = window.AtlasStore;
  const FSRS = window.AtlasFSRS;
  const A = window.ATLAS;
  if (!Atlas || !FSRS || !A) return;

  const esc = Atlas.esc;
  const icon = Atlas.icon;
  const view = document.getElementById('atlas-view');
  const SECONDS_PER_CARD = 10;
  const GUESS_KEY = 'atlas.guesses';
  const GRADES = [
    [1, 'Again'],
    [2, 'Hard'],
    [3, 'Good'],
    [4, 'Easy'],
  ];
  const DEFAULT_SETTINGS = { newPerDay: 10, target: 0.9, session: 20 };

  const deck = new Map(); //        "slug:id" → card state (+ born: when it joined the deck)
  let settings = { ...DEFAULT_SETTINGS };
  let catalog = null; //             slug → [[id, qHtml, aHtml]]
  let catalogLoading = null;
  let loaded = false;

  const key = (slug, id) => `${slug}:${id}`;
  const now = () => Date.now();
  const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const opts = () => ({ target: settings.target });

  /* ---------- state ---------- */

  function take(r) {
    if (r.topic === 'settings' && r.id === 'srs:settings') {
      settings = r.deleted ? { ...DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS, ...(r.data || {}) };
      return;
    }
    const k = r.id.slice(4); // strip "srs:"
    if (r.deleted) deck.delete(k);
    else if (r.data && typeof r.data.s === 'number') deck.set(k, r.data);
  }

  async function load() {
    if (Store) {
      try {
        await Store.ready;
        for (const r of await Store.byKind('srs')) take(r);
      } catch {
        /* start empty */
      }
    }
    loaded = true;
    refresh();
  }

  function save(slug, id, card) {
    const k = key(slug, id);
    if (card) deck.set(k, card);
    else deck.delete(k);
    if (Store) {
      Store.put({ id: `srs:${k}`, kind: 'srs', topic: slug, data: card || {}, deleted: !card }).catch(() => {});
    }
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    if (Store) Store.put({ id: 'srs:settings', kind: 'srs', topic: 'settings', data: settings }).catch(() => {});
    refresh();
  }

  let lastGrade = null; // { slug, id, prev } — for Undo

  function grade(slug, id, g) {
    const prev = deck.get(key(slug, id)) || null;
    const t = now();
    const next = { ...FSRS.review(prev, g, t, opts()), born: (prev && prev.born) || t };
    save(slug, id, next);
    lastGrade = { slug, id, prev };
    paintBadges();
    return next;
  }

  function undoLast() {
    if (!lastGrade) return null;
    const { slug, id, prev } = lastGrade;
    save(slug, id, prev);
    lastGrade = null;
    paintBadges();
    return { slug, id };
  }

  /* ---------- the catalogue of every card ---------- */

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (!A.cards) return Promise.resolve((catalog = {}));
    if (!catalogLoading) {
      catalogLoading = fetch(A.cards)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((c) => (catalog = c || {}));
    }
    return catalogLoading;
  }

  const cardText = (slug, id) => {
    const list = catalog && catalog[slug];
    const c = list && list.find((x) => x[0] === id);
    return c ? { q: c[1], a: c[2] } : null;
  };

  // A topic counts as read once most of it has been read, or it's marked done.
  const isRead = (slug) => Atlas.isDone(slug) || (window.AtlasTrack ? window.AtlasTrack.percent(slug) >= 0.6 : false);

  function dueEntries(at = now()) {
    const out = [];
    for (const [k, c] of deck) {
      if (!FSRS.isDue(c, at)) continue;
      const i = k.indexOf(':');
      const slug = k.slice(0, i);
      const id = k.slice(i + 1);
      if (catalog && !cardText(slug, id)) continue; // the card no longer exists
      out.push({ slug, id, card: c });
    }
    return out.sort((a, b) => a.card.due - b.card.due);
  }

  const introducedToday = () => {
    const t = startOfToday();
    let n = 0;
    for (const c of deck.values()) if ((c.born || 0) >= t) n++;
    return n;
  };

  function newCandidates() {
    if (!catalog) return [];
    const out = [];
    for (const t of Atlas.topics) {
      const list = catalog[t.slug];
      if (!list || !isRead(t.slug)) continue;
      for (const [id] of list) if (!deck.has(key(t.slug, id))) out.push({ slug: t.slug, id, card: null });
    }
    return out;
  }

  const newAllowance = () => Math.max(0, settings.newPerDay - introducedToday());

  function counts() {
    const due = dueEntries().length;
    const fresh = Math.min(newAllowance(), newCandidates().length);
    return { due, fresh, total: due + fresh };
  }

  // Mix topics: never two cards from the same topic in a row when avoidable.
  function interleave(items) {
    const rest = items.slice();
    const out = [];
    while (rest.length) {
      const prev = out.length ? out[out.length - 1].slug : null;
      let i = rest.findIndex((x) => x.slug !== prev);
      if (i === -1) i = 0;
      out.push(rest.splice(i, 1)[0]);
    }
    return out;
  }

  function buildSession(topicSlug) {
    if (topicSlug) {
      const list = (catalog && catalog[topicSlug]) || [];
      return list.map(([id]) => ({ slug: topicSlug, id, isNew: !deck.has(key(topicSlug, id)) }));
    }
    const size = settings.session;
    const due = dueEntries().slice(0, size).map((e) => ({ ...e, isNew: false }));
    const fresh = newCandidates()
      .slice(0, Math.min(newAllowance(), Math.max(0, size - due.length)))
      .map((e) => ({ ...e, isNew: true }));
    // New cards spread through the due ones rather than all at the end.
    const merged = [];
    const step = fresh.length ? Math.max(1, Math.floor(due.length / fresh.length)) : 0;
    let f = 0;
    due.forEach((e, i) => {
      merged.push(e);
      if (step && (i + 1) % step === 0 && f < fresh.length) merged.push(fresh[f++]);
    });
    while (f < fresh.length) merged.push(fresh[f++]);
    return interleave(merged);
  }

  /* ---------- formatting ---------- */

  const minutes = (n) => Math.max(1, Math.round((n * SECONDS_PER_CARD) / 60));
  const topicOf = (slug) => Atlas.topic(slug);
  function topicLink(slug) {
    const t = topicOf(slug);
    if (!t) return '';
    const s = Atlas.section(t.section);
    return `<a class="rv-topic" href="${Atlas.topicHref(t)}" style="--a:${s ? s.accent : 'var(--accent)'}"><i></i>${esc(s ? s.title : '')} · ${esc(t.title)}</a>`;
  }
  // Cards in review fall due at the start of a day, so say "1 d", not "15 h".
  function until(c) {
    if (c.step === 'review') {
      const days = Math.round((c.due - startOfToday()) / 864e5);
      return FSRS.formatInterval(Math.max(1, days) * 864e5);
    }
    return FSRS.formatInterval(c.due - now());
  }
  function stateChip(c) {
    if (!c) return '<span class="rc-chip new">new</span>';
    if (FSRS.isDue(c, now())) return '<span class="rc-chip due">due</span>';
    return `<span class="rc-chip">in ${esc(until(c))}</span>`;
  }
  function gradeButtons(c) {
    const p = FSRS.preview(c, now(), opts());
    return GRADES.map(([g, label]) => `<button type="button" class="rc-g g${g}" data-rc-grade="${g}"><b>${label}</b> <small>${esc(until(p[g]))}</small></button>`).join('');
  }

  /* ---------- topic pages: guesses and cards ---------- */

  function loadGuesses() {
    try {
      return JSON.parse(localStorage.getItem(GUESS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveGuess(slug, i, text) {
    const all = loadGuesses();
    all[slug] = { ...(all[slug] || {}), [i]: text };
    if (!text) delete all[slug][i];
    try {
      localStorage.setItem(GUESS_KEY, JSON.stringify(all));
    } catch {
      /* not kept */
    }
  }

  function enhancePredict(topic) {
    const box = view.querySelector('.prose .callout-predict');
    if (!box) return;
    const guesses = loadGuesses()[topic.slug] || {};
    box.querySelectorAll('.callout-body li').forEach((li, i) => {
      if (li.querySelector('.pg-guess')) return;
      const area = document.createElement('textarea');
      area.className = 'pg-guess';
      area.rows = 1;
      area.placeholder = 'Your guess — a number, a sentence, anything';
      area.value = guesses[i] || '';
      area.dataset.i = String(i);
      area.setAttribute('aria-label', 'Your guess');
      li.appendChild(area);
      fit(area);
    });
    if (!box.querySelector('.pg-note')) {
      const note = document.createElement('p');
      note.className = 'pg-note';
      note.textContent = 'Write a guess before you read — being wrong first helps you remember the answer. Your guesses wait for you at the end.';
      box.querySelector('.callout-body').appendChild(note);
    }
  }

  function fit(area) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  }

  function guessRecap(topic) {
    const box = view.querySelector('.prose .callout-predict');
    if (!box) return '';
    const guesses = loadGuesses()[topic.slug] || {};
    const items = [...box.querySelectorAll('.callout-body li')]
      .map((li, i) => {
        const q = li.cloneNode(true);
        q.querySelectorAll('textarea').forEach((x) => x.remove());
        return guesses[i] ? `<li><span>${q.innerHTML}</span><em>You guessed: ${esc(guesses[i])}</em></li>` : '';
      })
      .filter(Boolean);
    if (!items.length) return '';
    return `<details class="rc-guesses"><summary>Your guesses from the start · ${items.length}</summary><ol>${items.join('')}</ol><p>Compare them with what you read — the gap is what you just learned.</p></details>`;
  }

  function enhanceCards(topic) {
    const section = view.querySelector('.prose .recall');
    if (!section) return;
    const cards = [...section.querySelectorAll('.recall-card')];
    if (!section.previousElementSibling || !section.previousElementSibling.classList.contains('rc-head')) {
      const head = document.createElement('div');
      head.className = 'rc-head';
      section.before(head);
    }
    paintCardsHead(topic, section, cards);
    for (const el of cards) {
      const id = el.dataset.card;
      const c = deck.get(key(topic.slug, id));
      const sum = el.querySelector('summary');
      let chip = sum.querySelector('.rc-chip');
      if (!chip) {
        sum.querySelector('.recall-show').insertAdjacentHTML('beforebegin', stateChip(c));
      } else chip.outerHTML = stateChip(c);
      if (!el.dataset.rcBound) {
        el.dataset.rcBound = '1';
        el.addEventListener('toggle', () => {
          if (el.open && !el.querySelector('.rc-grade')) {
            el.insertAdjacentHTML(
              'beforeend',
              `<div class="rc-grade"><span>How well did you know it?</span><div class="rc-gs">${gradeButtons(deck.get(key(topic.slug, id)))}</div></div>`
            );
          }
        });
      }
    }
  }

  function paintCardsHead(topic, section, cards) {
    const head = section.previousElementSibling;
    if (!head || !head.classList.contains('rc-head')) return;
    const inDeck = cards.filter((el) => deck.has(key(topic.slug, el.dataset.card))).length;
    const due = cards.filter((el) => FSRS.isDue(deck.get(key(topic.slug, el.dataset.card)), now())).length;
    head.innerHTML = `
      <div class="rc-head-text"><b>${cards.length} cards</b><span>${inDeck ? `${inDeck} in your deck${due ? ` · ${due} due` : ''}` : 'Answer each in your head, then open it and rate yourself.'}</span></div>
      <a class="btn small" href="#/review/t/${encodeURIComponent(topic.slug)}">${icon('cards', 15)} Practise these</a>
      ${guessRecap(topic)}`;
  }

  view.addEventListener('input', (e) => {
    const area = e.target.closest && e.target.closest('.pg-guess');
    if (!area) return;
    fit(area);
    const t = Atlas.currentTopic();
    if (t) saveGuess(t.slug, area.dataset.i, area.value.trim());
  });

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rc-grade]');
    if (!b || !b.closest('.recall-card')) return;
    const el = b.closest('.recall-card');
    const t = Atlas.currentTopic();
    if (!t) return;
    const next = grade(t.slug, el.dataset.card, Number(b.dataset.rcGrade));
    el.querySelector('.rc-grade').innerHTML = `<span class="rc-done">${icon('check', 15, 2.4)} Next review in ${esc(until(next))}</span><button type="button" class="pl-link" data-rc-undo>Undo</button>`;
    const chip = el.querySelector('summary .rc-chip');
    if (chip) chip.outerHTML = stateChip(next);
    paintCardsHead(t, el.closest('.recall'), [...el.closest('.recall').querySelectorAll('.recall-card')]);
  });

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rc-undo]');
    if (!b) return;
    const el = b.closest('.recall-card');
    const t = Atlas.currentTopic();
    if (!t || !el || !lastGrade || lastGrade.id !== el.dataset.card) return;
    undoLast();
    el.querySelector('.rc-grade').innerHTML = `<span>How well did you know it?</span><div class="rc-gs">${gradeButtons(deck.get(key(t.slug, el.dataset.card)))}</div>`;
    const chip = el.querySelector('summary .rc-chip');
    if (chip) chip.outerHTML = stateChip(deck.get(key(t.slug, el.dataset.card)));
    paintCardsHead(t, el.closest('.recall'), [...el.closest('.recall').querySelectorAll('.recall-card')]);
  });

  /* ---------- the review page ---------- */

  let session = null; // { topic, queue, i, revealed, done: [], again, started }

  function startSession(topicSlug) {
    const queue = buildSession(topicSlug);
    session = { topic: topicSlug || '', queue, i: 0, revealed: false, reviewed: 0, again: 0, started: now(), seen: new Set() };
  }

  function reviewPage() {
    const slot = view.querySelector('[data-slot="review"]');
    if (!slot) return;
    if (!loaded || !catalog) {
      slot.innerHTML = '<p class="pl-empty">Loading your cards…</p>';
      return;
    }
    if (!session) startSession(Atlas.current() && Atlas.current().topic);
    slot.innerHTML = `${reviewTop()}<div class="rv-stage">${stageHtml()}</div>${settingsHtml()}`;
  }

  function reviewTop() {
    const c = counts();
    const topicT = session.topic ? topicOf(session.topic) : null;
    const total = Object.values(catalog).reduce((a, l) => a + l.length, 0);
    return `<div class="rv-top">
      ${topicT ? `<div class="rv-mode"><span>Practising one topic:</span> ${topicLink(session.topic)} <a class="pl-link" href="#/review">Back to all due cards</a></div>` : ''}
      <div class="rv-stats">
        <div><b>${c.due}</b><span>due now</span></div>
        <div><b>${c.fresh}</b><span>new today</span></div>
        <div><b>${deck.size}</b><span>in your deck</span></div>
        <div><b>${total}</b><span>cards in Atlas</span></div>
      </div>
    </div>`;
  }

  function stageHtml() {
    const s = session;
    if (!s.queue.length) {
      const read = Atlas.topics.filter((t) => isRead(t.slug) && catalog[t.slug]).length;
      return `<div class="card rv-empty">
        <b>${deck.size ? 'All caught up' : 'No cards yet'}</b>
        <p>${deck.size
          ? `Nothing is due right now.${counts().fresh ? '' : ' New cards join as you read more topics.'} The next card is due ${nextDueText()}.`
          : read
            ? 'Your new-card limit for today is used up — come back tomorrow, or raise it below.'
            : 'Read a topic to the end, and its "Check yourself" cards join your deck here. Or rate a card right on the topic page.'}</p>
      </div>`;
    }
    if (s.i >= s.queue.length) return summaryHtml();
    const item = s.queue[s.i];
    const text = cardText(item.slug, item.id);
    if (!text) {
      s.i++;
      return stageHtml();
    }
    const c = deck.get(key(item.slug, item.id));
    return `<article class="card rv-card" data-rv-slug="${esc(item.slug)}" data-rv-id="${esc(item.id)}">
      <div class="rv-card-top">${topicLink(item.slug)}<span class="rv-count">${s.i + 1} of ${s.queue.length}${item.isNew && !c ? ' · <em>new</em>' : ''}</span></div>
      <div class="rv-q">${text.q}</div>
      <div class="rv-a"${s.revealed ? '' : ' hidden'}>${text.a}</div>
      <div class="rv-actions">
        ${s.revealed
          ? `<div class="rv-grades">${gradeButtons(c)}</div>`
          : `<button type="button" class="btn primary rv-reveal" data-rv="reveal">Show answer <kbd>space</kbd></button>`}
      </div>
      ${lastGrade && s.i > 0 ? '<button type="button" class="pl-link rv-undo" data-rv="undo">Undo last</button>' : ''}
    </article>`;
  }

  function summaryHtml() {
    const s = session;
    const mins = Math.max(1, Math.round((now() - s.started) / 60000));
    const c = counts();
    return `<div class="card rv-summary">
      <span class="eyebrow">Session done</span>
      <b>${s.reviewed} card${s.reviewed === 1 ? '' : 's'} in ${mins} min</b>
      <p>${s.again ? `${s.again} came back with “Again” — they'll return soon, which is exactly how they stick.` : 'Every card answered — nice.'} ${c.total ? `${c.total} more ${c.total === 1 ? 'is' : 'are'} ready if you want to keep going.` : `Next card due ${nextDueText()}.`}</p>
      <div class="rv-summary-actions">${c.total ? '<button type="button" class="btn primary" data-rv="again">Keep going</button>' : ''}<a class="btn" href="#/">Home</a></div>
    </div>`;
  }

  function nextDueText() {
    let next = Infinity;
    for (const c of deck.values()) if (c.step !== 'new' && c.due > now()) next = Math.min(next, c.due);
    if (next === Infinity) return 'when you add cards';
    return next - now() < 864e5 && new Date(next).getDate() === new Date().getDate() ? `in ${FSRS.formatInterval(next - now())}` : `in ${until({ step: 'review', due: next })}`;
  }

  function settingsHtml() {
    const seg = (k, opts2) =>
      `<div class="seg">${opts2.map(([v, l]) => `<button type="button" class="${settings[k] === v ? 'on' : ''}" data-rv-set="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
    return `<details class="rv-settings"><summary>${icon('settings', 16)} Review settings</summary>
      <div class="list">
        <div class="set-row"><div><b>New cards a day</b><small>From topics you've read. Fewer means shorter sessions.</small></div>${seg('newPerDay', [[0, 'None'], [5, '5'], [10, '10'], [20, '20']])}</div>
        <div class="set-row"><div><b>Remember</b><small>How sure you want to be of recalling a card when it comes back. Higher means more reviews.</small></div>${seg('target', [[0.85, '85%'], [0.9, '90%'], [0.95, '95%']])}</div>
        <div class="set-row"><div><b>Cards per session</b></div>${seg('session', [[10, '10'], [20, '20'], [40, '40']])}</div>
      </div></details>`;
  }

  function reveal() {
    if (!session || session.revealed || session.i >= session.queue.length) return;
    session.revealed = true;
    paintStage();
  }

  function gradeCurrent(g) {
    const s = session;
    if (!s || !s.revealed || s.i >= s.queue.length) return;
    const item = s.queue[s.i];
    const next = grade(item.slug, item.id, g);
    s.reviewed++;
    if (g === 1) {
      s.again++;
      // Bring it back a few cards later in this sitting.
      s.queue.splice(Math.min(s.queue.length, s.i + 4), 0, { ...item, isNew: false });
    }
    s.lastIndex = s.i;
    s.i++;
    s.revealed = false;
    void next;
    paintStage(true);
  }

  function undoCurrent() {
    const s = session;
    const back = undoLast();
    if (!s || !back || s.lastIndex == null) return;
    // Drop a requeued copy if the undone grade was "Again".
    const later = s.queue.findIndex((x, i) => i > s.lastIndex && x.slug === back.slug && x.id === back.id);
    if (later !== -1 && later > s.lastIndex) s.queue.splice(later, 1);
    s.i = s.lastIndex;
    s.reviewed = Math.max(0, s.reviewed - 1);
    s.revealed = true;
    s.lastIndex = null;
    paintStage();
  }

  function paintStage(focus) {
    const stage = view.querySelector('.rv-stage');
    if (!stage) return reviewPage();
    stage.innerHTML = stageHtml();
    const top = view.querySelector('.rv-top');
    if (top) top.outerHTML = reviewTop();
    if (focus) {
      const btn = stage.querySelector('[data-rv="reveal"]');
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rv], [data-rv-set], .rv-grades [data-rc-grade]');
    if (!b || !view.querySelector('[data-slot="review"]')) return;
    if (b.dataset.rcGrade) return gradeCurrent(Number(b.dataset.rcGrade));
    if (b.dataset.rvSet) {
      saveSettings({ [b.dataset.rvSet]: Number(b.dataset.v) });
      return;
    }
    const act = b.dataset.rv;
    if (act === 'reveal') reveal();
    else if (act === 'undo') undoCurrent();
    else if (act === 'again') {
      startSession('');
      reviewPage();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!view.querySelector('[data-slot="review"]') || !session) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || Atlas.searchOpen()) return;
    if ((e.key === ' ' || e.key === 'Enter') && !session.revealed) {
      e.preventDefault();
      reveal();
    } else if (session.revealed && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      gradeCurrent(Number(e.key));
    } else if (e.key === 'u' && lastGrade) undoCurrent();
  });

  /* ---------- home, progress, badges ---------- */

  function homeTile() {
    const slot = view.querySelector('[data-slot="home-review"]');
    if (!slot) return;
    if (!loaded || !catalog) {
      slot.innerHTML = '';
      return;
    }
    const c = counts();
    if (!deck.size && !c.fresh) {
      slot.innerHTML = `<a class="card rv-home quiet" href="#/review">${icon('cards', 20)}<span><b>Review</b><small>Finish a topic and its cards join your daily review.</small></span></a>`;
      return;
    }
    slot.innerHTML = `<a class="card rv-home${c.total ? '' : ' quiet'}" href="#/review">
      <span class="rv-home-ico">${icon('cards', 22)}</span>
      <span class="rv-home-text"><b>${c.total ? `${c.total} card${c.total === 1 ? '' : 's'} to review` : 'Review: all caught up'}</b>
        <small>${c.total ? `about ${minutes(c.total)} min${c.fresh ? ` · ${c.fresh} new from topics you've read` : ''}` : `${deck.size} cards in your deck · next ${nextDueText()}`}</small></span>
      ${c.total ? '<span class="btn small primary">Start</span>' : ''}
    </a>`;
  }

  function progressSection() {
    const slot = view.querySelector('[data-slot="progress-recall"]');
    if (!slot || !loaded) return;
    const t = now();
    const cards = [...deck.values()].filter((c) => c.step !== 'new');
    const mature = cards.filter(FSRS.isMature).length;
    const reviewCards = cards.filter((c) => c.step === 'review');
    const avg = reviewCards.length ? reviewCards.reduce((a, c) => a + FSRS.recallChance(c, t), 0) / reviewCards.length : 0;
    const due = dueEntries(t).length;
    // Due per day for the next two weeks.
    const days = [];
    const sod = startOfToday();
    for (let i = 0; i < 14; i++) {
      const from = sod + i * 864e5;
      const to = from + 864e5;
      days.push(cards.filter((c) => (i === 0 ? c.due < to : c.due >= from && c.due < to)).length);
    }
    const max = Math.max(1, ...days);
    slot.innerHTML = `<section class="block"><h2>Memory</h2>
      <div class="rv-mem">
        <div class="card tr-stat"><b>${cards.length}</b><span>cards learned</span></div>
        <div class="card tr-stat"><b>${due}</b><span>due now</span></div>
        <div class="card tr-stat"><b>${mature}</b><span>remembered 3+ weeks</span></div>
        <div class="card tr-stat"><b>${reviewCards.length ? Math.round(avg * 100) : '–'}<small>%</small></b><span>predicted recall right now</span></div>
      </div>
      <div class="card tr-pad rv-forecast"><span class="eyebrow">Cards due, next 14 days</span>
        <div class="rv-bars">${days.map((n, i) => `<div class="rv-bar${i === 0 ? ' today' : ''}" title="${n} due"><i style="height:${Math.round((n / max) * 100)}%"></i><span>${n || ''}</span></div>`).join('')}</div>
        <p class="pl-empty">Spacing reviews out — each a little longer than the last — is one of the two study methods with the strongest evidence. The schedule is FSRS, a memory model fitted to millions of real reviews.</p>
      </div></section>`;
  }

  function paintBadges() {
    const el = document.getElementById('atlas-review-count');
    if (!el) return;
    const n = loaded && catalog ? counts().total : 0;
    el.hidden = !n;
    el.textContent = n ? String(n) : '';
  }

  function refresh() {
    paintBadges();
    homeTile();
    progressSection();
    const t = Atlas.currentTopic();
    if (t) enhanceCards(t);
    if (view.querySelector('[data-slot="review"]') && session) reviewPage();
  }

  Atlas.on('render', ({ route, topic }) => {
    if (route && route.name !== 'review') session = null;
    if (topic) {
      enhancePredict(topic);
      enhanceCards(topic);
    }
    if (route && route.name === 'review') {
      session = null;
      loadCatalog().then(() => {
        startSession(route.topic || '');
        reviewPage();
      });
    }
    loadCatalog().then(() => {
      homeTile();
      paintBadges();
    });
    progressSection();
  });

  if (Store) {
    Store.subscribe((records, origin) => {
      if (origin !== 'remote') return;
      let hit = false;
      for (const r of records) if (r.kind === 'srs') {
        take(r);
        hit = true;
      }
      if (hit && !(session && view.querySelector('.rv-card'))) refresh();
      else if (hit) paintBadges();
    });
  }

  /* ---------- export, import, reset ---------- */

  Atlas.exporters.push(async () => ({ recall: { deck: Object.fromEntries(deck), settings, guesses: loadGuesses() } }));
  Atlas.importers.push(async (d) => {
    const r = d && d.recall;
    if (!r || typeof r !== 'object') return;
    const recs = [];
    for (const [k, c] of Object.entries(r.deck || {})) {
      const i = k.indexOf(':');
      if (i < 1 || !c || typeof c.s !== 'number') continue;
      recs.push({ id: `srs:${k}`, kind: 'srs', topic: k.slice(0, i), data: c });
    }
    if (r.settings) recs.push({ id: 'srs:settings', kind: 'srs', topic: 'settings', data: r.settings });
    for (const rec of recs) take(rec);
    if (Store && recs.length) await Store.put(recs).catch(() => {});
    if (r.guesses) {
      try {
        localStorage.setItem(GUESS_KEY, JSON.stringify(r.guesses));
      } catch {
        /* not kept */
      }
    }
    refresh();
  });
  Atlas.on('reset', () => {
    const recs = [...deck.keys()].map((k) => ({ id: `srs:${k}`, kind: 'srs', topic: k.slice(0, k.indexOf(':')), data: {}, deleted: true }));
    deck.clear();
    try {
      localStorage.removeItem(GUESS_KEY);
    } catch {
      /* nothing kept */
    }
    if (Store && recs.length) Store.put(recs).catch(() => {});
  });

  window.AtlasRecall = {
    counts: () => counts(),
    deck: () => new Map(deck),
    grade,
    settings: () => ({ ...settings }),
    catalog: loadCatalog,
  };

  load();
  loadCatalog().then(refresh);
})();
