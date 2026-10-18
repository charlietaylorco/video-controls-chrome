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
    watch_storage_error: 'Local Recent saves storage is unavailable or full. Reader may already have changed; check Reader before retrying. Free storage and reopen this page.',
    network_error: 'Reader could not be reached. Cached videos are still available.', location_conflict: 'Reader’s location changed. Review its current location before moving again.',
    location_not_applied: 'Reader kept a different location. That destination may not be enabled in your Library.',
    location_uncertain: 'The move could not be confirmed. Refresh before moving again.', location_cache_error: 'Reader changed, but the local list could not be updated. Refresh to check.',
    auth_changed: 'Reader credentials changed. Refresh before continuing.', invalid_sender: 'This extension page is no longer current. Reopen Recent saves.',
    request_uncertain: 'The request could not be confirmed. Refresh before trying again.', runtime_error: 'The extension is unavailable. Reload the extension and reopen Recent saves.'
  })[result.code] || (result.code === 'rate_limited' ? `Reader rate limit reached. Try after ${new Date(result.retryAt || Date.now() + 60000).toLocaleTimeString()}.` : 'Reader could not complete this request. Try Refresh.');
  const announce = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const node = (tag, text, parent, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; parent?.append(n); return n; };
  const icon = (parent, commands) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', commands); svg.append(path); parent.append(svg);
  };
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
    const thumbnailLink = node('a', '', card, 'thumbnail-link');
    thumbnailLink.href = item.videoUrl; thumbnailLink.target = '_blank'; thumbnailLink.rel = 'noopener noreferrer'; thumbnailLink.tabIndex = -1;
    const image = node('img', '', thumbnailLink, 'thumbnail'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.width = 480; image.height = 270;
    image.referrerPolicy = 'no-referrer'; image.src = `https://i.ytimg.com/vi/${encodeURIComponent(new URL(item.videoUrl).searchParams.get('v'))}/mqdefault.jpg`;
    const copy = node('div', '', card, 'video-copy'), heading = node('h2', '', copy), link = node('a', '', heading);
    link.href = item.videoUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const metadata = node('dl', '', copy, 'metadata');
    const field = label => { const group = node('div', '', metadata); node('dt', label, group, 'sr-only'); return node('dd', '', group); };
    const channel = field('Channel'), tags = field('Tags'); channel.className = 'channel-name';
    const locationRow = node('div', '', copy, 'location-row'), locationLabel = node('label', '', locationRow);
    node('span', 'Saved location', locationLabel, 'sr-only');
    const move = node('select', '', locationLabel);
    const placeholder = node('option', 'Not checked', move); placeholder.value = ''; placeholder.disabled = true;
    for (const [value, label] of Object.entries(C.locations)) { const option = node('option', label, move); option.value = value; }
    const removeGroup = node('optgroup', '', move); removeGroup.label = 'Remove document';
    const trash = node('option', 'Trash…', removeGroup, 'trash-option'); trash.value = 'trash';
    const readerLink = node('a', '', locationRow, 'reader-link'); readerLink.target = '_blank'; readerLink.rel = 'noopener noreferrer'; readerLink.title = 'Open in Reader';
    icon(readerLink, 'M14 3h7v7M10 14 21 3M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5');
    const summary = node('p', '', copy, 'summary-text');
    const footer = node('div', '', copy, 'card-footer'), footerDetails = node('div', '', footer, 'footer-details');
    const note = node('p', '', footerDetails, 'row-status'); note.setAttribute('role', 'status');
    const footerMeta = node('div', '', footerDetails, 'footer-meta'), date = node('time', '', footerMeta), checked = node('span', '', footerMeta);
    const refresh = node('button', '', footer, 'card-refresh'); refresh.type = 'button';
    icon(refresh, 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7');
    move.addEventListener('change', () => {
      const destination = move.value, current = items.find(row => row.videoUrl === item.videoUrl);
      move.value = current && Object.hasOwn(C.locations, current.location) ? current.location : '';
      if (destination === 'trash') void prepareDelete(item.videoUrl);
      else if (destination) void mutate(item.videoUrl, destination);
    });
    refresh.addEventListener('click', () => void refreshCard(item.videoUrl));
    return { card, link, channel, tags, date, checked, placeholder, summary, move, readerLink, refresh, note };
  };
  const render = () => {
    const order = items.map(item => item.videoUrl);
    for (const url of rows.keys()) if (!order.includes(url)) rows.delete(url);
    const cards = [];
    for (const item of items) {
      let row = rows.get(item.videoUrl); if (!row) { row = makeRow(item); rows.set(item.videoUrl, row); }
      row.link.textContent = item.title || `YouTube video · ${new URL(item.videoUrl).searchParams.get('v')}`;
      row.channel.textContent = item.author || 'Not retained';
      const tags = Array.isArray(item.tags) ? W.tags(item.tags) : null;
      row.tags.textContent = tags ? tags.length ? tags.slice(0, 3).join(' · ') + (tags.length > 3 ? ` +${tags.length - 3}` : '') : 'None' : 'Not fetched';
      row.tags.title = tags?.join(' · ') || '';
      const savedDate = new Date(item.savedAt), hasSavedDate = Number.isFinite(savedDate.getTime());
      row.date.textContent = hasSavedDate ? `Saved ${savedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Saved date unavailable';
      row.date.dateTime = hasSavedDate ? savedDate.toISOString() : ''; row.date.setAttribute('aria-label', hasSavedDate ? `Saved date: ${savedDate.toLocaleString()}` : 'Saved date unavailable');
      row.checked.textContent = item.checkedAt ? `Checked ${new Date(item.checkedAt).toLocaleString()}` : 'Not checked';
      row.placeholder.textContent = item.status === 'missing' ? 'Not found in Reader' : item.checkedAt ? C.locationLabel(item.location) : 'Not checked';
      row.placeholder.hidden = Object.hasOwn(C.locations, item.location) && item.status === 'saved';
      row.move.value = Object.hasOwn(C.locations, item.location) && item.status === 'saved' ? item.location : '';
      const text = item.summary == null ? 'Summary not fetched. Refresh this card to check Reader.' : item.summary || 'Summary not available yet. Reader may still be processing it. Refresh this card to check again.';
      row.summary.textContent = text + (item.summaryTruncated ? '\n\nCached excerpt. Open Reader for the full summary.' : '');
      row.summary.dataset.empty = String(!item.summary);
      row.move.disabled = pending.size > 0 || refreshing || Boolean(deletion) || !item.readerId || item.status !== 'saved' || !loaded;
      row.refresh.disabled = pending.size > 0 || refreshing || Boolean(deletion) || !item.readerId || item.status === 'deleted' || !loaded;
      row.move.setAttribute('aria-label', `Saved location for ${item.title || 'video'}`);
      row.refresh.setAttribute('aria-label', `Refresh ${item.title || 'video'} from Reader`); row.refresh.title = 'Refresh this card from Reader';
      row.card.setAttribute('aria-busy', String(pending.has(item.videoUrl) || refreshing));
      row.readerLink.hidden = !item.readerId; if (item.readerId) row.readerLink.href = C.readerUrl(item.readerId);
      row.readerLink.setAttribute('aria-label', `Open ${item.title || 'video'} in Reader`);
      row.note.textContent = pending.has(item.videoUrl) ? 'Working…' : errors.get(item.videoUrl) || (!item.readerId ? 'Reader ID not retained; open the video page to link it.' : '');
      row.note.dataset.error = String(errors.has(item.videoUrl)); cards.push(row.card);
    }
    if (Array.from(grid.children).map(n => n.dataset.url).join('|') !== order.join('|')) grid.replaceChildren(...cards);
    grid.hidden = loaded && items.length === 0; $('empty').hidden = !loaded || items.length > 0;
    grid.setAttribute('aria-busy', String(!loaded)); controls();
  };
  const load = async ({ clearStatus = false } = {}) => {
    const request = ++pageRequest, result = await send({ type: 'watch-list-page', filter, cursor: cursors.at(-1) });
    if (request !== pageRequest) return;
    if (!result.ok) { announce(messageFor(result), true); controls(); return; }
    items = result.items.filter(item => C.canonical(item.videoUrl) === item.videoUrl && (!item.readerId || C.validId(item.readerId)));
    hasNext = result.hasNext; nextCursor = result.nextCursor; loaded = true; render();
    if (clearStatus && !refreshing && pending.size === 0 && !deletion) announce('');
  };
  const reloadLocal = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (!refreshing && !pending.size && !deletion) void load(); }, 100); };
  const changePage = () => { refreshRequest++; refreshing = false; loaded = false; render(); void load({ clearStatus: true }); };
  const refreshCard = async url => {
    const item = items.find(row => row.videoUrl === url);
    if (!item?.readerId || !loaded || refreshing || pending.size || deletion) return;
    const request = refreshRequest, id = item.readerId;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-refresh', videoUrl: url, id });
    pending.delete(url);
    if (request !== refreshRequest || !items.some(row => row.videoUrl === url && row.readerId === id)) { render(); return; }
    if (!reply.ok) rememberError(url, messageFor(reply));
    await load(); announce(reply.ok ? 'Card updated from Reader.' : messageFor(reply), !reply.ok);
  };
  const mutate = async (url, destination) => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    const request = refreshRequest;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-move', videoUrl: url, id: item.readerId, location: destination, baseLocation: item.location });
    pending.delete(url);
    if (request !== refreshRequest) { render(); return; }
    if (!reply.ok) rememberError(url, messageFor(reply));
    await load(); announce(reply.ok ? `Moved to ${C.locationLabel(destination)}.` : messageFor(reply), !reply.ok);
  };
  const prepareDelete = async url => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    const request = refreshRequest;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-prepare-delete', videoUrl: url, id: item.readerId });
    pending.delete(url); render();
    if (request !== refreshRequest) return;
    if (!reply.ok) { rememberError(url, messageFor(reply)); render(); announce(messageFor(reply), true); return; }
    deletion = reply; $('delete-title').textContent = reply.title || 'Untitled Reader video';
    $('delete-identity').textContent = `${reply.videoUrl} · Reader ID: ${reply.id}`;
    $('delete-status').textContent = ''; $('delete-status').dataset.error = 'false'; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false;
    $('deletion').showModal(); $('cancel-delete').focus(); render();
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
  void load({ clearStatus: true });
})();
