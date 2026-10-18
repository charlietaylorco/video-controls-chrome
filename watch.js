/* Token-free, bounded extension page. All Reader calls go through the worker. */
(() => {
  const C = globalThis.MVSReaderCore, W = globalThis.MVSReaderWatchCore;
  const $ = id => document.getElementById(id), grid = $('videos'), status = $('status');
  const rows = new Map(), errors = new Map(), pending = new Set();
  const rememberError = (url, text) => {
    errors.delete(url); errors.set(url, text);
    while (errors.size > 100) errors.delete(errors.keys().next().value);
  };
  let items = [], filter = 'watch', cursors = [null], hasNext = false, nextCursor = null, pageRequest = 0, refreshRequest = 0;
  let refreshing = false, loaded = false, reloadTimer, deletion = null, deleting = false, theme = 'system';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const send = message => new Promise(resolve => {
    let settled = false;
    const finish = reply => { if (!settled) { settled = true; clearTimeout(timer); resolve(reply || { ok: false, code: 'runtime_error' }); } };
    const timer = setTimeout(() => finish({ ok: false, code: 'request_uncertain' }), 20000);
    try { chrome.runtime.sendMessage(message, reply => finish(chrome.runtime.lastError ? { ok: false, code: 'runtime_error' } : reply)); }
    catch { finish({ ok: false, code: 'runtime_error' }); }
  });
  const messageFor = result => ({ missing_token: 'Add your Reader token in Options, then refresh.', unauthorized: 'Reader rejected the token. Check Options.',
    unlinked: 'Reader ID not retained. Open the video page to link it; this list does not scan Reader history.',
    not_found: 'The matched Reader document is no longer available.', document_changed: 'The document changed. Refresh and review it before trying again.',
    delete_conflict: 'Reader changed since confirmation. Close this dialog and review a fresh confirmation.',
    invalid_confirmation: 'Confirmation expired or was already used. Close and choose Trash again.',
    delete_target_missing: 'The matched document was not found; no DELETE was sent. Refresh before trying again.',
    delete_not_confirmed: 'Reader did not confirm deletion. Refresh to check its current state.',
    delete_still_present: 'Reader accepted DELETE but still returns the document. Refresh to verify its state.',
    delete_uncertain: 'Deletion could not be confirmed. Refresh to check Reader before trying again.',
    delete_unverified: 'The extension did not verify deletion. Refresh before trying again.',
    delete_cache_error: 'Reader confirmed deletion, but local indicators could not be updated. Refresh to check.',
    watch_storage_error: 'Local Watch list storage is unavailable or full. Reader may already have changed; check Reader before retrying. Free storage and reopen this page.',
    network_error: 'Reader could not be reached. Cached videos are still available.', location_conflict: 'Reader’s location changed. Review its current location before moving again.',
    location_not_applied: 'Reader kept a different location. That destination may not be enabled in your Library.',
    location_uncertain: 'The move could not be confirmed. Refresh before moving again.', location_cache_error: 'Reader changed, but the local list could not be updated. Refresh to check.',
    auth_changed: 'Reader credentials changed. Refresh before continuing.', invalid_sender: 'This extension page is no longer current. Reopen Watch list.',
    request_uncertain: 'The request could not be confirmed. Refresh before trying again.', runtime_error: 'The extension is unavailable. Reload the extension and reopen Watch list.'
  })[result.code] || (result.code === 'rate_limited' ? `Reader rate limit reached. Try after ${new Date(result.retryAt || Date.now() + 60000).toLocaleTimeString()}.` : 'Reader could not complete this request. Try Refresh.');
  const announce = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const node = (tag, text, parent, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; parent?.append(n); return n; };
  const controls = () => {
    $('refresh').disabled = refreshing || pending.size > 0 || Boolean(deletion);
    $('refresh').textContent = refreshing ? 'Refreshing…' : 'Refresh this page';
    $('previous').disabled = cursors.length < 2 || pending.size > 0 || Boolean(deletion);
    $('next').disabled = !hasNext || pending.size > 0 || Boolean(deletion);
    $('page-label').textContent = `Page ${cursors.length} · ${items.length} video${items.length === 1 ? '' : 's'}`;
    for (const b of $('filters').children) { b.setAttribute('aria-pressed', String(b.dataset.filter === filter)); b.disabled = pending.size > 0 || Boolean(deletion); }
  };
  const makeRow = item => {
    const card = node('article', '', null, 'video'); card.dataset.url = item.videoUrl;
    const head = node('div', '', card, 'video-head'), thumbnailLink = node('a', '', head);
    thumbnailLink.href = item.videoUrl; thumbnailLink.target = '_blank'; thumbnailLink.rel = 'noopener noreferrer'; thumbnailLink.tabIndex = -1;
    const image = node('img', '', thumbnailLink, 'thumbnail'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.width = 112; image.height = 63;
    image.referrerPolicy = 'no-referrer'; image.src = `https://i.ytimg.com/vi/${encodeURIComponent(new URL(item.videoUrl).searchParams.get('v'))}/mqdefault.jpg`;
    const copy = node('div', '', head), heading = node('h2', '', copy), link = node('a', '', heading);
    link.href = item.videoUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const metadata = node('p', '', copy, 'metadata'), location = node('span', '', copy, 'location-label');
    const preview = node('p', '', card, 'summary-preview'), details = node('details', '', card, 'summary-box');
    node('summary', 'Read summary', details); const summary = node('p', '', details, 'summary-text');
    const actions = node('div', '', card, 'video-actions'), move = node('select', '', actions);
    move.setAttribute('aria-label', 'Move Reader document');
    const placeholder = node('option', 'Move to…', move); placeholder.value = '';
    for (const [value, label] of Object.entries(C.locations)) { const option = node('option', label, move); option.value = value; }
    const readerLink = node('a', 'Open Reader', actions); readerLink.target = '_blank'; readerLink.rel = 'noopener noreferrer';
    const trash = node('button', 'Trash', actions, 'trash'); trash.type = 'button';
    const note = node('p', '', card, 'row-status'); note.setAttribute('role', 'status');
    move.addEventListener('change', () => { const destination = move.value; move.value = ''; if (destination) void mutate(item.videoUrl, destination); });
    trash.addEventListener('click', () => void prepareDelete(item.videoUrl));
    return { card, link, metadata, location, preview, summary, details, move, readerLink, trash, note };
  };
  const render = () => {
    const order = items.map(item => item.videoUrl);
    for (const url of rows.keys()) if (!order.includes(url)) rows.delete(url);
    const cards = [];
    for (const item of items) {
      let row = rows.get(item.videoUrl); if (!row) { row = makeRow(item); rows.set(item.videoUrl, row); }
      row.link.textContent = item.title || `YouTube video · ${new URL(item.videoUrl).searchParams.get('v')}`;
      row.metadata.textContent = [item.author, `Saved ${new Date(item.savedAt).toLocaleDateString()}`].filter(Boolean).join(' · ');
      row.location.textContent = item.status === 'missing' ? 'Not found in Reader' : item.checkedAt ? C.locationLabel(item.location) : 'Location not checked';
      const text = item.summary == null ? 'Summary not fetched. Refresh this page when you want to check Reader.' : item.summary || 'Summary not available yet. Reader may still be processing it.';
      row.preview.textContent = text; row.summary.textContent = text + (item.summaryTruncated ? '\n\nCached excerpt. Open Reader for the full summary.' : '');
      row.details.hidden = !item.summary;
      row.move.disabled = row.trash.disabled = pending.has(item.videoUrl) || refreshing || !item.readerId || item.status !== 'saved';
      row.move.setAttribute('aria-label', `Move ${item.title || 'video'} in Reader`);
      row.trash.setAttribute('aria-label', `Trash ${item.title || 'video'} from Reader`);
      row.readerLink.hidden = !item.readerId; if (item.readerId) row.readerLink.href = C.readerUrl(item.readerId);
      row.note.textContent = pending.has(item.videoUrl) ? 'Working…' : errors.get(item.videoUrl) || (!item.readerId ? 'Reader ID not retained; open the video page to link it.' : item.checkedAt ? `Checked ${new Date(item.checkedAt).toLocaleString()}` : 'Saved locally · not yet checked with Reader');
      row.note.dataset.error = String(errors.has(item.videoUrl)); cards.push(row.card);
    }
    if (Array.from(grid.children).map(n => n.dataset.url).join('|') !== order.join('|')) grid.replaceChildren(...cards);
    grid.hidden = loaded && items.length === 0; $('empty').hidden = !loaded || items.length > 0;
    grid.setAttribute('aria-busy', String(!loaded)); controls();
  };
  const load = async ({ announceDefault = false } = {}) => {
    const request = ++pageRequest, result = await send({ type: 'watch-list-page', filter, cursor: cursors.at(-1) });
    if (request !== pageRequest) return;
    if (!result.ok) { announce(messageFor(result), true); controls(); return; }
    items = result.items.filter(item => C.canonical(item.videoUrl) === item.videoUrl && (!item.readerId || C.validId(item.readerId)));
    hasNext = result.hasNext; nextCursor = result.nextCursor; loaded = true; render();
    if (announceDefault && !refreshing && pending.size === 0 && !deletion) announce('Newest saves first. Browse cached summaries or refresh this page.');
  };
  const reloadLocal = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (!refreshing && !pending.size && !deletion) void load(); }, 100); };
  const changePage = () => { refreshRequest++; refreshing = false; loaded = false; render(); void load({ announceDefault: true }); };
  const mutate = async (url, destination) => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-move', videoUrl: url, id: item.readerId, location: destination, baseLocation: item.location });
    pending.delete(url); if (!reply.ok) rememberError(url, messageFor(reply));
    await load(); announce(reply.ok ? `Moved to ${C.locationLabel(destination)}.` : messageFor(reply), !reply.ok);
  };
  const prepareDelete = async url => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-prepare-delete', videoUrl: url, id: item.readerId });
    pending.delete(url); render();
    if (!reply.ok) { rememberError(url, messageFor(reply)); render(); announce(messageFor(reply), true); return; }
    deletion = reply; $('delete-title').textContent = reply.title || 'Untitled Reader video';
    $('delete-identity').textContent = `${reply.videoUrl} · Reader ID: ${reply.id}`;
    $('delete-status').textContent = ''; $('delete-status').dataset.error = 'false'; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false;
    $('deletion').showModal(); $('cancel-delete').focus(); controls();
  };
  const closeDelete = () => { if (deleting) return; $('deletion').close(); deletion = null; controls(); void load(); };
  $('cancel-delete').addEventListener('click', closeDelete);
  $('deletion').addEventListener('cancel', event => { event.preventDefault(); closeDelete(); });
  $('confirm-delete').addEventListener('click', async () => {
    if (!deletion || deleting) return;
    const captured = deletion; deleting = true; $('delete-status').textContent = 'Checking Reader before deleting…';
    $('confirm-delete').disabled = $('cancel-delete').disabled = true;
    const result = await send({ type: 'watch-list-delete', token: captured.token, confirmed: true });
    deleting = false;
    if (result.ok) { closeDelete(); announce('Deleted from Reader.'); }
    else { $('delete-status').textContent = messageFor(result); $('delete-status').dataset.error = 'true'; $('cancel-delete').disabled = false; $('cancel-delete').focus(); }
  });
  $('refresh').addEventListener('click', async () => {
    if (!loaded) { await load(); return; }
    const request = ++refreshRequest, captured = [...items]; refreshing = true; render();
    let count = 0, failure = null;
    for (const item of captured) {
      if (request !== refreshRequest) return;
      if (!item.readerId || item.status === 'deleted') continue;
      announce(`Checking ${++count} of ${captured.filter(row => row.readerId).length} videos…`);
      const result = await send({ type: 'watch-list-refresh', videoUrl: item.videoUrl, id: item.readerId });
      if (request !== refreshRequest) return;
      if (!result.ok) { rememberError(item.videoUrl, messageFor(result)); failure = result; if (['rate_limited', 'unauthorized', 'missing_token'].includes(result.code)) break; }
      else errors.delete(item.videoUrl);
    }
    if (request !== refreshRequest) return;
    refreshing = false; await load(); announce(failure ? messageFor(failure) : count ? 'This page is up to date with Reader.' : 'No linked Reader IDs on this page. Open a video page to link an older save.', Boolean(failure));
  });
  for (const [value, label] of Object.entries(W.filters)) {
    const button = node('button', label, $('filters')); button.type = 'button'; button.dataset.filter = value;
    button.addEventListener('click', () => { filter = value; cursors = [null]; changePage(); });
  }
  $('previous').addEventListener('click', () => { if (cursors.length > 1) { cursors.pop(); changePage(); } });
  $('next').addEventListener('click', () => { if (nextCursor) { cursors.push(nextCursor); changePage(); } });
  const applyTheme = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; $('theme').value = theme; };
  media.addEventListener('change', applyTheme);
  chrome.storage.local.get({ readerPanelTheme: 'system' }, data => { theme = ['system', 'dark', 'light'].includes(data.readerPanelTheme) ? data.readerPanelTheme : 'system'; applyTheme(); });
  $('theme').addEventListener('change', () => chrome.storage.local.set({ readerPanelTheme: $('theme').value }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.readerPanelTheme) { theme = ['system', 'dark', 'light'].includes(changes.readerPanelTheme.newValue) ? changes.readerPanelTheme.newValue : 'system'; applyTheme(); }
    if (changes.readerWatchChanged || changes.readerDocuments || changes.readerDocumentUpdates || changes.readerDeletedVideos) reloadLocal();
    if (changes.readerToken) {
      refreshRequest++; refreshing = false;
      if (deletion && !deleting) closeDelete();
      render(); announce('Reader connection changed. Refresh to check current data.');
    }
  });
  void load({ announceDefault: true });
})();
