(() => {
  'use strict';
  const store = SubscriptionsReviewState;
  const CARD = 'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, yt-lockup-view-model, .yt-lockup-view-model-wiz';
  const HIDDEN = 'data-mvs-subscription-hidden';
  const host = document.createElement('div');
  host.id = 'mvs-subscriptions-tools';
  host.hidden = true;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { --paper:#f8f7f3; --ink:#20221f; --line:#d7d9d2; --muted:#646b61; color:var(--ink); font:14px/1.5 system-ui,sans-serif; }
      :host([data-dark]) { --paper:#20231f; --ink:#f3f5ee; --line:#464d42; --muted:#b4bcae; }
      :host([hidden]) { display:none !important; }
      * { box-sizing:border-box; } button,input { font:inherit; } button,a { -webkit-tap-highlight-color:transparent; }
      button { cursor:pointer; border:1px solid var(--line); border-radius:9px; background:var(--paper); color:var(--ink); padding:9px 14px; }
      button:hover { filter:brightness(.94); } button:active { transform:scale(.98); } button:disabled { opacity:.5; cursor:default; }
      button:focus-visible,a:focus-visible,input:focus-visible,[tabindex]:focus-visible { outline:3px solid #53937a; outline-offset:3px; }
      .primary { background:var(--ink); color:var(--paper); border-color:var(--ink); }
      .toolbar { position:fixed; z-index:1900; right:24px; bottom:24px; display:flex; flex-wrap:wrap; gap:6px; padding:7px; border:1px solid var(--line); border-radius:15px; background:var(--paper); box-shadow:0 6px 28px #0002; max-width:calc(100vw - 32px); }
      .toolbar button { border:none; } .toolbar-status { flex-basis:100%; padding:0 8px; font-size:12px; color:var(--muted); }
      dialog { color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:20px; padding:24px; width:min(680px,calc(100vw - 32px)); max-height:88vh; overflow:auto; box-shadow:0 20px 80px #0005; }
      dialog::backdrop { background:#10171080; }
      header { display:flex; align-items:start; justify-content:space-between; gap:16px; } h1 { margin:2px 0 0; font-size:26px; letter-spacing:-.8px; line-height:1.2; }
      .eyebrow { font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); font-weight:650; }
      .close { padding:6px 12px; } nav { display:flex; gap:6px; margin:20px 0 12px; } nav button[aria-pressed=true] { border-color:var(--ink); background:var(--ink); color:var(--paper); }
      .scope,.status,.hint { color:var(--muted); font-size:12px; } .scope { margin:0 0 14px; } .status { min-height:20px; margin:12px 0 0; } .hint { text-align:center; margin:12px 0 0; }
      .card { position:relative; touch-action:pan-y; border:1px solid var(--line); border-radius:14px; background:var(--paper); overflow:hidden; user-select:none; }
      .card img { width:100%; height:clamp(120px,24vh,240px); object-fit:contain; background:#141a16; display:block; pointer-events:none; }
      .card .copy { padding:16px; } h2 { margin:0 0 8px; font-size:20px; line-height:1.3; letter-spacing:-.3px; overflow-wrap:anywhere; } .meta { color:var(--muted); font-size:13px; }
      .stamp { position:absolute; top:20px; padding:6px 13px; font-weight:750; font-size:20px; border:2px solid; border-radius:7px; opacity:0; pointer-events:none; }
      .stamp.hide { right:20px; color:#912b3c; background:#ffeced; transform:rotate(8deg); } .stamp.later { left:20px; color:#21583e; background:#d9f0df; transform:rotate(-8deg); }
      .controls { display:flex; justify-content:center; flex-wrap:wrap; gap:9px; margin:18px 0 0; } .hide-action { background:#f8dce0; color:#792d3a; border-color:#ecc2ca; } .later-action { background:#d9eddd; color:#244f34; border-color:#bcd7c3; }
      .empty { text-align:center; padding:44px 20px; border:1px dashed var(--line); border-radius:14px; } .empty p { color:var(--muted); }
      .collection-tools { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:14px; } label { flex:1; min-width:180px; font-size:12px; color:var(--muted); } input { display:block; width:100%; padding:9px 12px; background:var(--paper); border:1px solid var(--line); border-radius:9px; color:var(--ink); }
      .rows { display:grid; gap:12px; } .row { display:flex; align-items:start; gap:13px; padding:12px 0; border-top:1px solid var(--line); } .row img { width:112px; aspect-ratio:16/9; object-fit:cover; border-radius:7px; } .row-copy { flex:1; min-width:0; } .row h2 { font-size:15px; overflow-wrap:anywhere; } .row-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; } a { color:inherit; text-decoration:underline; text-underline-offset:3px; } .row-actions a { padding:8px 10px; } .row-actions button { font-size:12px; padding:7px 10px; }
      .more { margin-top:16px; width:100%; } [hidden] { display:none !important; }
      @media(max-width:480px) { dialog { padding:18px; } .toolbar { right:16px; bottom:16px; } .row img { width:84px; } h1 { font-size:23px; } }
      @media(prefers-reduced-motion:reduce) { button:active { transform:none; } }
      @media(prefers-contrast:more) { button,.card,dialog { border:2px solid var(--ink); } }
    </style>
    <div class="toolbar" aria-label="Subscription tools">
      <button class="primary" data-open="review">Review subscriptions</button>
      <button data-open="later">Later · 0</button><button data-open="hidden">Hidden · 0</button>
      <span class="toolbar-status" role="status"></span>
    </div>
    <dialog aria-label="Review subscriptions" aria-describedby="sr-scope">
      <header><div><div class="eyebrow">Subscriptions · This browser</div><h1 id="sr-title">Review subscriptions</h1></div><button class="close" aria-label="Close subscription tools">Close</button></header>
      <nav aria-label="Subscription views"><button data-mode="review" aria-pressed="true">Review</button><button data-mode="later" aria-pressed="false">Later</button><button data-mode="hidden" aria-pressed="false">Hidden</button></nav>
      <p class="scope" id="sr-scope"></p>
      <div class="review">
        <div class="card" tabindex="0" aria-label="Video to review. Drag left to hide or right to save for later."></div>
        <div class="review-empty empty" hidden><h2>Loaded videos reviewed</h2><p>YouTube loads more as you scroll. This covers recognized cards currently loaded on this page, not your whole subscription history.</p><button class="return-feed">Return to feed to load more</button></div>
        <div class="controls"><button class="hide-action" data-decision="hide">← Hide</button><button data-decision="skip">↓ Skip</button><button class="later-action" data-decision="later">Later →</button></div>
        <p class="hint">Drag or use ← Hide · ↓ Skip · → Later</p>
      </div>
      <div class="collection" hidden><div class="collection-tools"><label>Search saved titles or channels<input type="search" placeholder="Search videos"></label><button class="bulk"></button></div><div class="rows"></div><button class="more" hidden>Show more</button></div>
      <div class="controls"><button class="undo" disabled>Undo</button></div>
      <p class="status" role="status" aria-live="polite"></p>
    </dialog>`;
  const $ = (selector) => shadow.querySelector(selector);
  const dialog = $('dialog');
  const cardUI = $('.card');
  let data = store.sanitize(null);
  let root = null;
  let mode = 'review';
  let currentId = '';
  let seen = new Set();
  let undoStack = [];
  let busy = false;
  let ready = false;
  let generation = 0;
  let routeHref = '';
  let timer = null;
  let listLimit = 30;
  let confirmation = '';
  let countedData = null;
  let gesture = null;
  let suppressClick = false;
  let frame = null;
  const cards = new Map();
  const dirty = new Set();
  const isPage = () => store.isSubscriptionsUrl(location.href);
  const focusBlocked = () => document.documentElement.dataset.mvsFeedFocusReady !== 'true' ||
    document.documentElement.classList.contains('ytl-hide-feed-videos');
  const announce = (text) => { $('.status').textContent = text; };
  const send = (payload) => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: store.TYPE, ...payload }, (response) => {
        const error = chrome.runtime.lastError;
        if (error || !response?.ok) reject(new Error(error?.message || response?.error || 'Could not save. Reload this tab and try again.'));
        else resolve(response);
      });
    } catch (error) { reject(error); }
  });
  const outerCard = (node) => {
    let card = node?.nodeType === 1 ? node.closest(CARD) : node?.parentElement?.closest(CARD);
    if (!card || !root?.contains(card)) return null;
    for (let parent = card.parentElement?.closest(CARD); parent && root.contains(parent); parent = card.parentElement?.closest(CARD)) card = parent;
    return card;
  };
  const parseCard = (element) => {
    const anchors = Array.from(element.querySelectorAll('a[href]'));
    const link = anchors.find((anchor) => store.videoId(anchor.getAttribute('href')));
    const id = store.videoId(link?.getAttribute('href'));
    if (!id) return null;
    const title = element.querySelector('#video-title, #video-title-link, .yt-lockup-metadata-view-model__title');
    const titleText = title?.getAttribute('title') || title?.textContent || link?.getAttribute('title');
    if (!titleText?.trim()) return null; // Wait for lazy hydration rather than recording a skeleton.
    return store.sanitizeVideo({ id, title: titleText,
      channel: element.querySelector('ytd-channel-name, #channel-name, .yt-content-metadata-view-model__metadata-row')?.textContent,
      duration: element.querySelector('ytd-thumbnail-overlay-time-status-renderer, .yt-badge-shape__text')?.textContent,
      thumbnail: element.querySelector('img')?.getAttribute('src') });
  };
  const markCard = (element, video) => {
    const hidden = Boolean(video && data.entries[video.id]?.hiddenAt);
    if (hidden && element.getAttribute(HIDDEN) !== video.id) element.setAttribute(HIDDEN, video.id);
    else if (!hidden && element.hasAttribute(HIDDEN)) element.removeAttribute(HIDDEN);
  };
  const refreshCard = (element) => {
    if (!root?.contains(element)) { const removed = cards.delete(element); element.removeAttribute(HIDDEN); return removed; }
    const video = parseCard(element);
    const changed = JSON.stringify(cards.get(element) || null) !== JSON.stringify(video);
    if (video) cards.set(element, video);
    else cards.delete(element);
    markCard(element, video); // Remove a stale hide mark when YouTube recycles this renderer.
    return changed;
  };
  const deck = () => {
    const ids = new Set();
    // Preserve the native newest-first page order. Relative date labels are never sorted.
    return Array.from(root?.querySelectorAll(CARD) || []).flatMap((element) => {
      const video = cards.get(element);
      if (!video || ids.has(video.id) || seen.has(video.id) || data.entries[video.id]) return [];
      ids.add(video.id);
      return [video];
    });
  };
  const cancelGesture = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    const pointer = gesture?.pointer;
    gesture = null;
    if (pointer !== undefined && cardUI.hasPointerCapture(pointer)) cardUI.releasePointerCapture(pointer);
    cardUI.style.transform = '';
    cardUI.style.willChange = '';
    cardUI.querySelectorAll('.stamp').forEach((stamp) => { stamp.style.opacity = ''; });
  };
  const close = () => {
    cancelGesture();
    if (dialog.open) dialog.close();
    confirmation = '';
  };
  const updateToolbar = () => {
    if (countedData !== data) {
      const entries = Object.values(data.entries);
      $('[data-open="later"]').textContent = `Later · ${entries.filter((entry) => entry.laterAt).length}`;
      $('[data-open="hidden"]').textContent = `Hidden · ${entries.filter((entry) => entry.hiddenAt).length}`;
      countedData = data;
    }
    host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
    host.hidden = !isPage() || !root?.isConnected || root.hidden || focusBlocked();
    $('[data-open="review"]').disabled = !ready;
    if (host.hidden) close();
  };
  const accept = (state) => {
    if (state.revision < data.revision) return;
    data = store.sanitize(state);
    for (const [element, video] of cards) markCard(element, video);
    updateToolbar();
    if (dialog.open && !gesture) render();
  };
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const image = (video) => {
    const img = make('img');
    img.src = video.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    return img;
  };
  function renderReview() {
    const videos = deck();
    const current = videos.find((video) => video.id === currentId) || videos[0];
    currentId = current?.id || '';
    cardUI.hidden = !current;
    $('.review-empty').hidden = Boolean(current);
    $('.review .controls').hidden = !current;
    $('.hint').hidden = !current;
    $('.scope').textContent = `${videos.length} loaded video${videos.length === 1 ? '' : 's'} to review · Native page order, newest first. Hidden and Later items are excluded.`;
    if (!current) return;
    cancelGesture();
    const copy = make('div', '', 'copy');
    copy.append(make('h2', current.title), make('div', [current.channel, current.duration].filter(Boolean).join(' · '), 'meta'));
    cardUI.replaceChildren(image(current), copy, make('span', 'HIDE', 'stamp hide'), make('span', 'LATER', 'stamp later'));
  }
  function renderCollection() {
    const query = $('input').value.trim().toLowerCase();
    const entries = Object.values(data.entries).filter((entry) => mode === 'later' ? entry.laterAt : entry.hiddenAt)
      .sort((a, b) => (mode === 'later' ? b.laterAt - a.laterAt : b.hiddenAt - a.hiddenAt));
    const matches = entries.filter(({ video }) => `${video.title} ${video.channel}`.toLowerCase().includes(query));
    const rows = $('.rows');
    rows.replaceChildren();
    for (const { video } of matches.slice(0, listLimit)) {
      const row = make('article', '', 'row');
      const copy = make('div', '', 'row-copy');
      copy.append(make('h2', video.title), make('div', [video.channel, video.duration].filter(Boolean).join(' · '), 'meta'));
      const actions = make('div', '', 'row-actions');
      const watch = make('a', 'Watch');
      watch.href = video.url;
      watch.target = '_blank';
      watch.rel = 'noopener noreferrer';
      actions.append(watch);
      const button = make('button', mode === 'later' ? 'Remove from Later' : 'Restore');
      button.disabled = busy;
      button.addEventListener('click', () => perform(mode === 'later' ? 'remove' : 'restore', video));
      actions.append(button);
      if (mode === 'later') {
        const hide = make('button', 'Hide from subscriptions');
        hide.disabled = busy;
        hide.addEventListener('click', () => perform('hide', video));
        actions.append(hide);
      }
      copy.append(actions);
      row.append(image(video), copy);
      rows.append(row);
    }
    if (!matches.length) rows.append(make('p', entries.length ? 'No matching videos.' : mode === 'later' ? 'Save a video with → Later. It stays visible in your normal subscriptions feed.' : 'No hidden videos. Hiding affects only the subscriptions page in this browser.'));
    $('.more').hidden = matches.length <= listLimit;
    $('.bulk').disabled = busy || !entries.length;
    $('.bulk').textContent = confirmation ? 'Confirm — click again' : mode === 'later' ? 'Clear Later' : 'Restore all';
    $('.scope').textContent = mode === 'later'
      ? `${entries.length} saved video${entries.length === 1 ? '' : 's'} · Opening a video leaves it in Later until you remove it.`
      : `${entries.length} hidden video${entries.length === 1 ? '' : 's'} · Restore works even if the original card is no longer loaded.`;
  }
  function render() {
    $('.review').hidden = mode !== 'review';
    $('.collection').hidden = mode === 'review';
    $('#sr-title').textContent = mode === 'review' ? 'Review subscriptions' : mode === 'later' ? 'Your Later queue' : 'Hidden subscriptions';
    dialog.setAttribute('aria-label', $('#sr-title').textContent);
    shadow.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    if (mode === 'review') renderReview();
    else renderCollection();
    shadow.querySelectorAll('[data-decision]').forEach((button) => { button.disabled = busy; });
    $('.undo').disabled = busy || !undoStack.length;
    $('.undo').textContent = 'Undo';
  }
  const setMode = (next) => {
    cancelGesture();
    mode = next;
    confirmation = '';
    listLimit = 30;
    $('input').value = '';
    announce('');
    render();
  };
  const open = (next) => {
    if (host.hidden || !ready) return;
    if (next === 'review') { seen = new Set(); currentId = ''; undoStack = []; }
    setMode(next);
    if (!dialog.open) dialog.showModal();
    if (mode === 'review' && currentId) cardUI.focus();
    else $('.close').focus();
  };
  async function perform(action, video) {
    if (busy || !ready || !isPage() || focusBlocked()) return;
    cancelGesture();
    if (action === 'skip') {
      seen.add(video.id);
      undoStack.push({ action, video });
      undoStack = undoStack.slice(-20);
      currentId = '';
      render();
      announce('Skipped for this review only.');
      cardUI.focus();
      return;
    }
    busy = true;
    render();
    announce('Saving…');
    try {
      const response = await send({ action, video, id: video?.id });
      accept(response.state);
      if (response.undoToken) undoStack.push({ action, video, token: response.undoToken });
      else undoStack = [];
      undoStack = undoStack.slice(-20);
      if (mode === 'review' && video) { seen.add(video.id); currentId = ''; }
      confirmation = '';
      announce(({ hide: 'Hidden from subscriptions.', later: 'Saved to Later. Still visible in your normal feed.', restore: 'Video restored.', remove: 'Removed from Later.', restoreAll: 'All hidden videos restored.', clearLater: 'Later queue cleared.' })[action]);
    } catch (error) {
      announce(`${error.message} This action was not saved.`);
    } finally {
      busy = false;
      if (dialog.open) {
        render();
        if (mode === 'review' && currentId) cardUI.focus();
        else if (!shadow.activeElement || shadow.activeElement === dialog) $('.undo').disabled ? $('.close').focus() : $('.undo').focus();
      }
    }
  }
  async function undo() {
    if (busy || !undoStack.length || focusBlocked() || !isPage()) return;
    const item = undoStack.at(-1);
    busy = true;
    cancelGesture();
    render();
    try {
      if (item.token) {
        const response = await send({ action: 'undo', token: item.token });
        accept(response.state);
      }
      undoStack.pop();
      seen.delete(item.video.id);
      currentId = item.video.id;
      announce('Decision undone.');
    } catch (error) {
      if (/changed|expired/.test(error.message)) undoStack.pop();
      announce(error.message);
    } finally { busy = false; if (dialog.open) render(); }
  }
  shadow.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => open(button.dataset.open)));
  shadow.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  shadow.querySelectorAll('[data-decision]').forEach((button) => button.addEventListener('click', () => {
    const video = deck().find((video) => video.id === currentId);
    if (video) perform(button.dataset.decision, video);
  }));
  $('.close').addEventListener('click', close);
  $('.return-feed').addEventListener('click', close);
  $('.undo').addEventListener('click', undo);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  $('input').addEventListener('input', () => { listLimit = 30; renderCollection(); });
  $('.more').addEventListener('click', () => { listLimit += 30; renderCollection(); });
  $('.bulk').addEventListener('click', () => {
    const action = mode === 'later' ? 'clearLater' : 'restoreAll';
    if (confirmation === action) perform(action);
    else { confirmation = action; renderCollection(); announce(mode === 'later' ? 'Click Confirm to remove every Later item. This does not hide them.' : 'Click Confirm to restore every hidden subscription video.'); }
  });
  dialog.addEventListener('keydown', (event) => {
    const target = event.composedPath()[0];
    if (target?.matches?.('input, textarea, select, [contenteditable]') || event.isComposing) return;
    const isUndo = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z';
    const action = { ArrowLeft: 'hide', ArrowRight: 'later', ArrowDown: 'skip' }[event.key];
    const plainArrow = mode === 'review' && action && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (event.repeat) {
      if (isUndo || plainArrow) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (isUndo) {
      event.preventDefault(); event.stopPropagation(); undo(); return;
    }
    if (mode !== 'review' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const video = deck().find((video) => video.id === currentId);
    if (action && video) { event.preventDefault(); event.stopPropagation(); perform(action, video); }
  });
  cardUI.addEventListener('pointerdown', (event) => {
    if (busy || mode !== 'review' || !currentId || !event.isPrimary || event.button !== 0) return;
    cancelGesture();
    gesture = { pointer: event.pointerId, id: currentId, x: event.clientX, y: event.clientY, dx: 0, active: false };
    cardUI.setPointerCapture(event.pointerId);
  });
  cardUI.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { cancelGesture(); return; }
      if (Math.abs(dx) < 10) return;
      gesture.active = true;
      cardUI.style.willChange = 'transform';
    }
    gesture.dx = dx;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = null;
      if (!gesture) return;
      const x = gesture.dx;
      cardUI.style.transform = `translateX(${x}px) rotate(${Math.max(-8, Math.min(8, x / 35))}deg)`;
      cardUI.querySelector('.hide').style.opacity = x < 0 ? String(Math.min(1, -x / 100)) : '0';
      cardUI.querySelector('.later').style.opacity = x > 0 ? String(Math.min(1, x / 100)) : '0';
    });
  });
  cardUI.addEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const { dx, active, id } = gesture;
    const threshold = Math.min(120, cardUI.clientWidth * .25);
    const video = deck().find((video) => video.id === id);
    suppressClick = active;
    cancelGesture();
    if (active && Math.abs(dx) >= threshold && video) perform(dx < 0 ? 'hide' : 'later', video);
    else if (dialog.open && mode === 'review') renderReview();
  });
  cardUI.addEventListener('pointercancel', () => {
    cancelGesture();
    if (dialog.open && mode === 'review' && !busy) renderReview();
  });
  cardUI.addEventListener('lostpointercapture', cancelGesture);
  cardUI.addEventListener('click', (event) => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } });
  const flush = () => {
    timer = null;
    let changed = false;
    for (const element of dirty) changed = refreshCard(element) || changed;
    dirty.clear();
    for (const element of cards.keys()) if (!root?.contains(element)) { cards.delete(element); changed = true; }
    updateToolbar();
    if (changed && dialog.open && mode === 'review' && !gesture && !busy) renderReview();
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 100); };
  const cardObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const card = outerCard(mutation.target);
      if (card) dirty.add(card);
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType !== 1) continue;
        const added = outerCard(node);
        if (added) dirty.add(added);
        node.querySelectorAll(CARD).forEach((element) => { const outer = outerCard(element); if (outer) dirty.add(outer); });
      }
    }
    schedule();
  });
  function connectRoot() {
    if (!isPage()) return;
    const next = document.querySelector('ytd-browse[page-subtype="subscriptions"]');
    if (next === root) { updateToolbar(); return; }
    cardObserver.disconnect();
    for (const element of cards.keys()) element.removeAttribute(HIDDEN);
    cards.clear(); dirty.clear();
    root = next;
    if (!root) { updateToolbar(); return; }
    const initial = new Set(Array.from(root.querySelectorAll(CARD)).map(outerCard).filter(Boolean));
    initial.forEach(refreshCard);
    cardObserver.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'title', 'src', 'hidden'] });
    if (!host.isConnected) (document.body || document.documentElement).append(host);
    updateToolbar();
    if (dialog.open && mode === 'review' && !gesture && !busy) renderReview();
  }
  async function navigate() {
    const ticket = ++generation;
    routeHref = location.href;
    // Each route waits for Focus to re-evaluate it, including navigation from an unblocked watch page.
    delete document.documentElement.dataset.mvsFeedFocusReady;
    close();
    ready = false;
    cardObserver.disconnect();
    for (const element of cards.keys()) element.removeAttribute(HIDDEN);
    cards.clear(); dirty.clear(); root = null;
    document.documentElement.classList.toggle('mvs-subscriptions', isPage());
    host.hidden = true;
    if (!isPage()) return;
    connectRoot();
    try {
      const response = await send({ action: 'get' });
      if (ticket !== generation || !isPage()) return;
      ready = true;
      accept(response.state);
      $('.toolbar-status').textContent = '';
      connectRoot();
    } catch (error) {
      if (ticket === generation) { $('.toolbar-status').textContent = `${error.message} Reload this tab to reconnect.`; updateToolbar(); }
    }
  }
  const pageObserver = new MutationObserver(() => {
    // Once connected, page mutations take this constant-time path; card work is scoped above.
    if (location.href !== routeHref) { navigate(); return; }
    if (isPage() && (!root?.isConnected || !root.matches('ytd-browse[page-subtype="subscriptions"]'))) connectRoot();
  });
  pageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['page-subtype'] });
  new MutationObserver(updateToolbar).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mvs-feed-focus-ready', 'dark'] });
  window.addEventListener('yt-navigate-start', close);
  window.addEventListener('yt-navigate-finish', navigate);
  window.addEventListener('popstate', navigate);
  window.addEventListener('pagehide', close);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[store.KEY]) return;
    if (!changes[store.KEY].newValue) data = store.sanitize(null);
    accept(changes[store.KEY].newValue || data);
  });
  navigate();
})();
