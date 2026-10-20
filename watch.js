/* Token-free, bounded extension page. All Reader calls go through the worker. */
(() => {
  const C = globalThis.MVSReaderCore, W = globalThis.MVSReaderWatchCore;
  const $ = id => document.getElementById(id), grid = $('videos');
  const feedback = globalThis.MVSWatchFeedback.create({ routine: $('toast'), error: $('error-toast'), live: $('announcements') });
  const rows = new Map(), errors = new Map(), pending = new Set();
  const rememberError = (url, text) => {
    errors.delete(url); errors.set(url, text);
    while (errors.size > 100) errors.delete(errors.keys().next().value);
  };
  let items = [], filter = 'watch', query = '', channelFilter = '', cursors = [null], hasNext = false, nextCursor = null, pageRequest = 0, refreshRequest = 0;
  let refreshing = false, loaded = false, reloadTimer, deletion = null, deleting = false, theme = 'system';
  // Request readiness must not hide the last settled view during local search.
  let hasSettledView = false, displayedSearch = false, displayedPage = 1;
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
    delete_uncertain: 'Deletion could not be confirmed. Refresh to check Reader before trying again.' + (result.rateLimitSource ? ' ' + C.rateLimitMessage(result) : ''),
    delete_unverified: 'The extension did not verify deletion. Refresh before trying again.',
    delete_cache_error: 'Reader confirmed deletion, but local indicators could not be updated. Refresh to check.',
    watch_storage_error: 'Local Recent saves storage is unavailable or full. Reader may already have changed; check Reader before retrying. Free storage and reopen this page.',
    network_error: 'Reader could not be reached. Cached videos are still available.', location_conflict: 'Reader’s location changed. Review its current location before moving again.',
    location_not_applied: 'Reader kept a different location. That destination may not be enabled in your Library.',
    location_uncertain: 'The move could not be confirmed. Refresh before moving again.', location_cache_error: 'Reader changed, but the local list could not be updated. Refresh to check.',
    auth_changed: 'Reader credentials changed. Refresh before continuing.', invalid_sender: 'This extension page is no longer current. Reopen Recent saves.',
    request_uncertain: 'The request could not be confirmed. Refresh before trying again.', runtime_error: 'The extension is unavailable. Reload the extension and reopen Recent saves.'
  })[result.code] || (result.code === 'rate_limited' ? C.rateLimitMessage(result) : 'Reader could not complete this request. Try Refresh.');
  const announce = (text, error = false) => feedback.show(text, error);
  const cardActions = globalThis.MVSWatchCardActions.create({ send, announce });
  const node = (tag, text, parent, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; parent?.append(n); return n; };
  const icon = (parent, commands) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', commands); svg.append(path); parent.append(svg);
  };
  const menuCurrent = target => loaded && !refreshing && !pending.size && !deletion && items.some(item => item.videoUrl === target.videoUrl && item.readerId === target.id && item.location === target.location && item.status === 'saved');
  const locationMenu = globalThis.MVSWatchLocationMenu.create({ isCurrent: menuCurrent, choose: (target, value) => {
    if (value === 'trash') void prepareDelete(target.videoUrl, target.trigger);
    else void mutate(target.videoUrl, value, target.trigger);
  } });
  const restoreActionFocus = origin => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== origin && !$('deletion').contains(active) && active.isConnected) return;
    if (origin?.isConnected && !origin.disabled) origin.focus({ preventScroll: true });
    else $('filters').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  const controls = () => {
    $('refresh').disabled = refreshing || pending.size > 0 || Boolean(deletion);
    $('refresh').textContent = refreshing ? 'Refreshing…' : 'Refresh this page';
    $('previous').disabled = !loaded || cursors.length < 2 || pending.size > 0 || Boolean(deletion);
    $('next').disabled = !loaded || !hasNext || pending.size > 0 || Boolean(deletion);
    $('page-label').textContent = `Page ${displayedPage} · ${items.length} ${displayedSearch ? 'match' + (items.length === 1 ? '' : 'es') : 'video' + (items.length === 1 ? '' : 's')}`;
    $('search').disabled = pending.size > 0 || Boolean(deletion);
    $('clear-search').disabled = $('search').disabled || !query && !channelFilter;
    $('channel-filter').disabled = $('search').disabled;
    for (const b of $('filters').children) { b.setAttribute('aria-pressed', String(b.dataset.filter === filter)); b.disabled = pending.size > 0 || Boolean(deletion); }
  };
  const makeRow = item => {
    const card = node('article', '', null, 'video'); card.dataset.url = item.videoUrl;
    const mediaBox = node('div', '', card, 'video-media'), thumbnailLink = node('a', '', mediaBox, 'thumbnail-link');
    thumbnailLink.href = item.videoUrl; thumbnailLink.target = '_blank'; thumbnailLink.rel = 'noopener noreferrer';
    const image = node('img', '', thumbnailLink, 'thumbnail');
    const thumbnail = globalThis.MVSWatchThumbnail.attach(image, item.videoUrl, { onUnavailable: () => { thumbnailLink.dataset.thumbnailUnavailable = 'true'; } });
    const copy = node('div', '', card, 'video-copy'), heading = node('h2', '', copy), link = node('a', '', heading);
    link.href = item.videoUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const metadata = node('dl', '', copy, 'metadata');
    const field = label => { const group = node('div', '', metadata); node('dt', label, group, 'sr-only'); return node('dd', '', group); };
    const channel = node('button', '', field('Channel'), 'channel-filter-button'); channel.type = 'button';
    channel.addEventListener('click', () => { const current = items.find(row => row.videoUrl === item.videoUrl); if (loaded && current?.author && !pending.size && !deletion) search.setChannel(current.author); });
    const locationRow = node('div', '', copy, 'location-row'), move = node('button', '', locationRow, 'location-trigger'); move.type = 'button';
    move.setAttribute('aria-haspopup', 'menu'); move.setAttribute('aria-expanded', 'false'); move.setAttribute('aria-controls', locationMenu.id);
    const locationActions = node('div', '', locationRow, 'location-actions destination-actions');
    locationActions.setAttribute('role', 'group'); locationActions.setAttribute('aria-label', 'Video actions');
    const refresh = node('button', '', locationActions, 'card-refresh destination-action'); refresh.type = 'button';
    icon(refresh, 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7');
    const readerLink = node('a', '', locationActions, 'reader-link destination-action'); readerLink.target = '_blank'; readerLink.rel = 'noopener noreferrer'; readerLink.title = 'Open in Reader';
    icon(readerLink, 'M14 3h7v7M10 14 21 3M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5');
    const actions = cardActions.attach(locationActions, item.videoUrl);
    const summary = node('p', '', copy, 'summary-text');
    const footer = node('div', '', copy, 'card-footer'), footerDetails = node('div', '', footer, 'footer-details');
    const note = node('p', '', footerDetails, 'row-status'); note.setAttribute('role', 'status');
    const footerMeta = node('div', '', footerDetails, 'footer-meta'), date = node('time', '', footerMeta), checked = node('span', '', footerMeta);
    const footerActions = node('div', '', footer, 'footer-actions');
    const trash = node('button', '', footerActions, 'card-trash'); trash.type = 'button'; trash.title = 'Delete from Reader';
    icon(trash, 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
    trash.addEventListener('click', () => void prepareDelete(item.videoUrl, trash));
    const target = () => {
      const current = items.find(row => row.videoUrl === item.videoUrl);
      return current && { videoUrl: current.videoUrl, id: current.readerId, location: current.location, title: current.title, trigger: move };
    };
    move.addEventListener('click', () => { const captured = target(); if (captured) locationMenu.toggle(captured); });
    move.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const captured = target(); if (captured) locationMenu.open(captured, event.key === 'ArrowUp' ? 'last' : 'first'); }
    });
    refresh.addEventListener('click', () => void refreshCard(item.videoUrl, refresh));
    return { card, link, channel, date, checked, summary, move, readerLink, refresh, trash, note, thumbnailLink, thumbnail, actions };
  };
  const render = () => {
    const order = items.map(item => item.videoUrl);
    for (const url of rows.keys()) if (!order.includes(url)) { rows.get(url).thumbnail.destroy(); rows.get(url).actions.destroy(); rows.delete(url); }
    const cards = [];
    for (const item of items) {
      let row = rows.get(item.videoUrl); if (!row) { row = makeRow(item); rows.set(item.videoUrl, row); }
      row.actions.update(item.title, loaded && !refreshing && !deletion && !pending.size);
      row.link.textContent = item.title || `YouTube video · ${new URL(item.videoUrl).searchParams.get('v')}`;
      row.thumbnailLink.setAttribute('aria-label', `Watch ${item.title || 'video'} on YouTube`); row.thumbnailLink.title = 'Open on YouTube';
      row.channel.textContent = item.author || 'Not retained';
      row.channel.disabled = !item.author || !loaded || pending.size > 0 || Boolean(deletion);
      row.channel.setAttribute('aria-label', item.author ? `Filter by exact channel: ${item.author}` : 'Channel not retained');
      const savedDate = new Date(item.savedAt), hasSavedDate = Number.isFinite(savedDate.getTime());
      row.date.textContent = hasSavedDate ? `Saved ${savedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Saved date unavailable';
      row.date.dateTime = hasSavedDate ? savedDate.toISOString() : ''; row.date.setAttribute('aria-label', hasSavedDate ? `Saved date: ${savedDate.toLocaleString()}` : 'Saved date unavailable');
      row.checked.textContent = item.checkedAt ? `Checked ${new Date(item.checkedAt).toLocaleString()}` : 'Not checked';
      row.move.textContent = item.status === 'missing' ? 'Not found in Reader' : item.checkedAt ? C.locationLabel(item.location) : 'Not checked';
      const text = item.summary == null ? 'Summary not fetched. Refresh this card to check Reader.' : item.summary || 'Summary not available yet. Reader may still be processing it. Refresh this card to check again.';
      row.summary.textContent = text + (item.summaryTruncated ? '\n\nCached excerpt. Open Reader for the full summary.' : '');
      row.summary.dataset.empty = String(!item.summary);
      row.move.disabled = pending.size > 0 || refreshing || Boolean(deletion) || !item.readerId || item.status !== 'saved' || !loaded;
      row.trash.disabled = row.move.disabled; row.trash.setAttribute('aria-label', `Trash ${item.title || 'video'} from Reader`);
      row.refresh.disabled = pending.size > 0 || refreshing || Boolean(deletion) || !item.readerId || item.status === 'deleted' || !loaded;
      row.move.setAttribute('aria-label', `Saved location for ${item.title || 'video'}`);
      row.refresh.setAttribute('aria-label', `Refresh ${item.title || 'video'} from Reader`); row.refresh.title = 'Refresh this card from Reader';
      row.card.setAttribute('aria-busy', String(pending.has(item.videoUrl) || refreshing));
      row.readerLink.hidden = !item.readerId; if (item.readerId) row.readerLink.href = C.readerUrl(item.readerId);
      row.readerLink.setAttribute('aria-label', `Open ${item.title || 'video'} in Reader`);
      row.note.textContent = pending.has(item.videoUrl) ? 'Working…' : errors.get(item.videoUrl) || (!item.readerId ? 'Reader ID not retained; open the video page to link it.' : '');
      row.note.dataset.error = String(errors.has(item.videoUrl)); cards.push(row.card);
    }
    if (Array.from(grid.children).map(n => n.dataset.url).join('|') !== order.join('|')) {
      locationMenu.close(); grid.replaceChildren(...cards);
    }
    locationMenu.refresh();
    grid.hidden = hasSettledView && items.length === 0; $('empty').hidden = !hasSettledView || items.length > 0;
    const searching = displayedSearch;
    $('empty-title').textContent = searching ? 'No matching videos' : 'No videos in this view';
    $('empty-description').textContent = searching ? 'Try a different search or reset the channel and location filters. Only retained titles, channel names and available cached summaries are searchable.' : 'Save a YouTube video with the extension’s Reader button, or try All saves. Retained older saves may need their Reader ID linked on the video page.';
    $('reset-view').hidden = !searching && filter === 'all';
    grid.setAttribute('aria-busy', String(!loaded)); controls();
  };
  const load = async ({ clearStatus = false } = {}) => {
    const request = ++pageRequest, result = await send({ type: 'watch-list-page', filter, query, channel: channelFilter, cursor: cursors.at(-1) });
    if (request !== pageRequest) return;
    if (!result.ok) { announce(messageFor(result), true); controls(); return; }
    items = result.items.filter(item => C.canonical(item.videoUrl) === item.videoUrl && (!item.readerId || C.validId(item.readerId)));
    hasNext = result.hasNext; nextCursor = result.nextCursor; loaded = hasSettledView = true;
    displayedSearch = Boolean(query.trim() || channelFilter); displayedPage = cursors.length; render();
    $('search-status').textContent = `${items.length} ${query.trim() || channelFilter ? 'matching ' : ''}video${items.length === 1 ? '' : 's'} on page ${cursors.length}${hasNext ? '. More results available.' : '.'}`;
    if (clearStatus && !refreshing && pending.size === 0 && !deletion) announce('');
  };
  const reloadLocal = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (!refreshing && !pending.size && !deletion) void load(); }, 100); };
  const invalidateView = () => { locationMenu.close(); refreshRequest++; pageRequest++; refreshing = false; loaded = false; render(); };
  const changePage = () => { invalidateView(); void load({ clearStatus: true }); };
  const refreshCard = async (url, origin) => {
    const item = items.find(row => row.videoUrl === url);
    if (!item?.readerId || !loaded || refreshing || pending.size || deletion) return;
    const request = refreshRequest, id = item.readerId;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-refresh', videoUrl: url, id });
    pending.delete(url);
    if (request !== refreshRequest || !items.some(row => row.videoUrl === url && row.readerId === id)) { render(); return; }
    if (!reply.ok) rememberError(url, messageFor(reply));
    await load(); announce(reply.ok ? 'Card updated from Reader.' : messageFor(reply), !reply.ok); restoreActionFocus(origin);
  };
  const mutate = async (url, destination, origin) => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    const request = refreshRequest;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-move', videoUrl: url, id: item.readerId, location: destination, baseLocation: item.location });
    pending.delete(url);
    if (request !== refreshRequest) { render(); return; }
    if (!reply.ok) rememberError(url, messageFor(reply));
    await load(); announce(reply.ok ? `Moved to ${C.locationLabel(destination)}.` : messageFor(reply), !reply.ok); restoreActionFocus(origin);
  };
  const prepareDelete = async (url, origin) => {
    const item = items.find(row => row.videoUrl === url); if (!item || pending.has(url)) return;
    const request = refreshRequest;
    pending.add(url); errors.delete(url); render();
    const reply = await send({ type: 'watch-list-prepare-delete', videoUrl: url, id: item.readerId });
    pending.delete(url); render();
    if (request !== refreshRequest) return;
    if (!reply.ok) { rememberError(url, messageFor(reply)); render(); announce(messageFor(reply), true); restoreActionFocus(origin); return; }
    deletion = { ...reply, origin }; $('delete-title').textContent = reply.title || 'Untitled Reader video';
    $('delete-identity').textContent = `${reply.videoUrl} · Reader ID: ${reply.id}`;
    $('delete-status').textContent = ''; $('delete-status').dataset.error = 'false'; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false;
    $('deletion').showModal(); $('cancel-delete').focus(); render();
  };
  const closeDelete = () => {
    if (deleting) return;
    const origin = deletion?.origin; $('deletion').close(); deletion = null; controls();
    void load().then(() => restoreActionFocus(origin));
  };
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
    refreshing = false; await load(); announce(failure ? messageFor(failure) : count ? `Checked ${count} video${count === 1 ? '' : 's'} in Reader.` : 'No linked Reader IDs on this page. Open a video page to link an older save.', Boolean(failure));
  });
  for (const [value, label] of Object.entries(W.filters)) {
    const button = node('button', label, $('filters')); button.type = 'button'; button.dataset.filter = value;
    button.addEventListener('click', () => { filter = value; cursors = [null]; changePage(); });
  }
  const search = globalThis.MVSWatchSearch.create({ input: $('search'), clear: $('clear-search'), chip: $('channel-filter'), onChange: criteria => {
    query = criteria.query; channelFilter = criteria.channel; cursors = [null]; invalidateView();
    const request = pageRequest;
    return () => { if (request === pageRequest) void load({ clearStatus: true }); };
  } });
  $('reset-view').addEventListener('click', () => { filter = 'all'; search.reset(); $('search').focus({ preventScroll: true }); });
  $('previous').addEventListener('click', () => { if (cursors.length > 1) { cursors.pop(); changePage(); } });
  $('next').addEventListener('click', () => { if (nextCursor) { cursors.push(nextCursor); changePage(); } });
  const applyTheme = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
  media.addEventListener('change', applyTheme);
  chrome.storage.local.get({ readerPanelTheme: 'system' }, data => { theme = ['system', 'dark', 'light'].includes(data.readerPanelTheme) ? data.readerPanelTheme : 'system'; applyTheme(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.readerPanelTheme) { theme = ['system', 'dark', 'light'].includes(changes.readerPanelTheme.newValue) ? changes.readerPanelTheme.newValue : 'system'; applyTheme(); }
    if (changes.readerWatchChanged || changes.readerDocuments || changes.readerDocumentUpdates || changes.readerDeletedVideos) reloadLocal();
    if (changes.readerToken) {
      locationMenu.close(); refreshRequest++; refreshing = false;
      if (deletion && !deleting) closeDelete();
      render(); announce('Reader connection changed. Refresh to check current data.', true);
    }
  });
  void load({ clearStatus: true });
})();
