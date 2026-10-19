const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require('fake-indexeddb');
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
const raw = (id = 'doc-a', source_url = A, location = 'later') => ({ id, source_url, location, title: 'Saved video', author: 'A channel', summary: 'Reader summary', tags: { category: { name: 'Learning' } }, notes: 'Private saved note', updated_at: 'v1' });
const scope = { scope: 'watch-document', isCurrent: () => true };
function app({ stored = {}, responder } = {}) {
  const data = { readerToken: 'fixture-token', ...structuredClone(stored) }, requests = [], reads = [], notifications = [], storageListeners = [];
  const documents = new Map([['doc-a', raw()], ['doc-b', raw('doc-b', B)]]);
  let clock = 100000, uuid = 0, listener;
  const chrome = { runtime: { id: 'extension', lastError: null, getURL: file => `chrome-extension://extension/${file}`,
    onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: {
      get(defaults, cb) { reads.push(Object.keys(defaults)); cb(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, data[key] ?? fallback]))); },
      set(patch, cb) { Object.assign(data, structuredClone(patch)); cb?.(); },
    }, onChanged: { addListener(fn) { storageListeners.push(fn); } } }, tabs: { get(id, cb) { cb({ id, url: 'chrome-extension://extension/watch.html' }); }, create() {} }, action: { onClicked: { addListener() {} } } };
  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    let value = responder ? await responder(url, init, documents) : null;
    if (!value) {
      const id = url.includes('list/?id=') ? new URL(url).searchParams.get('id') : url.split('/').at(-2);
      if (init.method === 'PATCH') { Object.assign(documents.get(id), JSON.parse(init.body)); value = { id }; }
      else if (init.method === 'DELETE') { documents.delete(id); value = { status: 204 }; }
      else value = { results: documents.has(id) ? [structuredClone(documents.get(id))] : [] };
    }
    if (value instanceof Error) throw value;
    const status = value.status || 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: () => value.retryAfter || null }, json: async () => value, text: async () => JSON.stringify(value) };
  };
  const context = vm.createContext({ URL, AbortSignal, Date, console, chrome, fetch, indexedDB: new IDBFactory(), IDBKeyRange, crypto: { randomUUID: () => `ticket-${++uuid}` } });
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  for (const file of ['reader-core.js', 'reader-watch-core.js', 'reader-watch-store.js', 'reader-service.js', 'reader-watch-service.js']) load(file);
  const store = context.MVSReaderWatchStore.create({ storage: chrome.storage.local, now: () => clock, notify: url => notifications.push(url) });
  const reader = context.MVSReaderService.create({ storage: chrome.storage.local, fetch, now: () => clock, history: store });
  const bridge = context.MVSReaderWatchService.create({ store, reader, now: () => clock, uuid: () => `ticket-${++uuid}` });
  return { data, requests, reads, notifications, documents, store, reader, bridge, context, advance: ms => { clock += ms; },
    changeToken(value) { const oldValue = data.readerToken; data.readerToken = value; storageListeners.forEach(fn => fn({ readerToken: { oldValue, newValue: value } }, 'local')); },
    record: (url = A, id = 'doc-a', metadata = { title: 'Local title', author: 'Local channel' }, options) => store.recordSave(url, id, metadata, options),
    call: (type, values = {}, owner = scope) => bridge.handle({ type, ...values }, owner),
    loadBackground() { context.importScripts = (...files) => files.filter(file => file.startsWith('reader-')).forEach(load); load('background.js'); },
    message: (message, sender) => new Promise(resolve => listener(message, sender, resolve)),
  };
}

test('retained migration deduplicates canonical aliases without reading tokens, scanning Reader or deleting source caches', async () => {
  const stored = { readerSavedUrls: { [A]: 12, 'https://youtu.be/alpha?t=2': 20, [B]: 0, 'https://read.readwise.io/read/unmatched': 30 },
    readerDocuments: { [A]: { id: 'doc-a', at: 21 }, [B]: { id: 'external-reader-id', at: 30 } } };
  const a = app({ stored }); const page = await a.store.page({ filter: 'all' });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].videoUrl, A); assert.equal(page.items[0].savedAt, 20); assert.equal(page.items[0].readerId, 'doc-a');
  assert.equal(a.requests.length, 0); assert.ok(!a.reads.flat().includes('readerToken'));
  assert.deepEqual(a.data.readerSavedUrls, stored.readerSavedUrls);
  await a.store.ready(); assert.equal((await a.store.page({ filter: 'all' })).items.length, 1);
});

test('save metadata persists once per video; repeat save updates recency while opening an existing save does not', async () => {
  const a = app(); await a.record(); a.advance(1000); await a.record(A, 'doc-a', { title: 'New title' }, { openExisting: true });
  let row = await a.store.get(A); assert.equal(row.savedAt, 100000); assert.equal(row.firstSavedAt, 100000); assert.equal(row.title, 'New title'); assert.equal(row.author, 'Local channel');
  await a.record(A); row = await a.store.get(A); assert.equal(row.savedAt, 101000); assert.equal(row.firstSavedAt, 100000);
  assert.equal((await a.store.page({ filter: 'all' })).items.length, 1);
});

test('indexed pages contain at most twelve items, stable next cursors and no duplicates for tied timestamps', async () => {
  const a = app(); for (let i = 0; i < 29; i++) await a.record(`https://www.youtube.com/watch?v=video_${i}`, `id-${i}`);
  const seen = new Set(); let cursor = null, pages = 0;
  do {
    const page = await a.store.page({ filter: 'all', cursor }); assert.ok(page.items.length <= 12); pages++;
    for (const row of page.items) { assert.ok(!seen.has(row.videoUrl)); seen.add(row.videoUrl); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 29); assert.equal(pages, 3); assert.equal(a.requests.length, 0);
  await assert.rejects(a.store.page({ filter: '__proto__' }));
  await assert.rejects(a.store.page({ cursor: [1, 'https://evil.test/'] }));
});

test('history survives beyond old two-thousand-entry caches and summary eviction does not remove saves', async () => {
  const a = app();
  for (let i = 0; i < 2001; i++) await a.record(`https://www.youtube.com/watch?v=history_${i}`, `id-${i}`);
  assert.equal((await a.store.get('https://www.youtube.com/watch?v=history_0')).readerId, 'id-0');
  for (let i = 0; i < 201; i++) {
    a.advance(1); const videoUrl = `https://www.youtube.com/watch?v=history_${i}`;
    await a.store.verify(videoUrl, { id: `id-${i}`, videoUrl, title: 'Cached', summary: 'Summary', location: 'later' });
  }
  const row = await a.store.get('https://www.youtube.com/watch?v=history_0'); assert.equal(row.title, 'Cached');
  const page = await a.store.page({ filter: 'all' }); assert.equal(page.items.length, 12);
  const oldest = await a.store.page({ filter: 'all', cursor: [100000, 'https://www.youtube.com/watch?v=history_1'] });
  assert.equal(oldest.items.find(row => row.videoUrl.endsWith('history_0'))?.summary, null);
  await a.record('https://www.youtube.com/watch?v=history_0', 'id-0', { title: 'Oldest retained needle' }, { openExisting: true });
  const found = await a.store.page({ query: 'oldest needle' }); assert.equal(found.items[0].videoUrl, 'https://www.youtube.com/watch?v=history_0');
  assert.equal(a.requests.length, 0);
});

test('To watch includes unknown/new/later/shortlist but excludes verified archive/feed/missing/deleted', async () => {
  const a = app(); const locations = ['', 'new', 'later', 'shortlist', 'archive', 'feed'];
  for (const [i, location] of locations.entries()) {
    const videoUrl = `https://www.youtube.com/watch?v=filter_${i}`; await a.record(videoUrl, `id-${i}`);
    if (location) await a.store.verify(videoUrl, { id: `id-${i}`, videoUrl, location, summary: '' });
  }
  assert.equal((await a.store.page()).items.length, 4);
  assert.equal((await a.store.page({ filter: 'archive' })).items.length, 1);
  await a.store.mark('https://www.youtube.com/watch?v=filter_1', 'id-1', 'missing');
  await a.store.mark('https://www.youtube.com/watch?v=filter_2', 'id-2', 'deleted');
  assert.equal((await a.store.page()).items.length, 2); assert.equal((await a.store.page({ filter: 'all' })).items.length, 5);
  await a.store.mark('https://www.youtube.com/watch?v=filter_2', 'id-2', 'missing');
  assert.equal((await a.store.get('https://www.youtube.com/watch?v=filter_2')).status, 'deleted');
});

test('refresh uses exact known id, deduplicates in-flight reads and returns no credentials or note text', async () => {
  const a = app(); await a.record();
  const replies = await Promise.all(Array.from({ length: 5 }, () => a.call('watch-list-refresh', { videoUrl: A, id: 'doc-a' })));
  assert.ok(replies.every(r => r.ok)); assert.equal(a.requests.length, 1); assert.ok(a.requests[0].url.endsWith('list/?id=doc-a'));
  const page = await a.call('watch-list-page', { filter: 'watch' }); assert.equal(page.items[0].summary, 'Reader summary');
  assert.ok(!JSON.stringify(page).includes('Private saved note')); assert.ok(!JSON.stringify(page).includes('fixture-token'));
  assert.equal(a.requests.length, 1);
});

test('legacy missing IDs never trigger Reader library discovery; stale refresh cannot overwrite a replacement save', async () => {
  const unlinked = app({ stored: { readerSavedUrls: { [A]: 12 } } });
  assert.equal((await unlinked.call('watch-list-refresh', { videoUrl: A })).code, 'unlinked'); assert.equal(unlinked.requests.length, 0);
  let release; const a = app({ responder: () => new Promise(resolve => { release = () => resolve({ results: [raw()] }); }) });
  await a.record(); const pending = a.call('watch-list-refresh', { videoUrl: A });
  while (!release) await new Promise(setImmediate);
  await a.record(A, 'new-id', { title: 'Replacement' }); release();
  assert.equal((await pending).code, 'document_changed'); assert.equal((await a.store.get(A)).readerId, 'new-id'); assert.equal((await a.store.get(A)).title, 'Replacement');
});

test('local Reader budgets and 429 cooldowns apply to Watch list without automatic retry', async () => {
  const a = app(); await a.record();
  for (let i = 0; i < 18; i++) assert.equal((await a.call('watch-list-refresh', { videoUrl: A })).ok, true);
  assert.equal((await a.call('watch-list-refresh', { videoUrl: A })).code, 'rate_limited'); assert.equal(a.requests.length, 18);
  const limited = app({ responder: () => ({ status: 429, retryAfter: '120' }) }); await limited.record();
  assert.equal((await limited.call('watch-list-refresh', { videoUrl: A })).code, 'rate_limited');
  await limited.call('watch-list-refresh', { videoUrl: A }); assert.equal(limited.requests.length, 1); assert.ok(limited.data.readerPanelBudget.blockedUntil >= 220000);
});

test('move reuses verified location-only transport and leaves saved notes untouched', async () => {
  const a = app(); await a.record(); await a.call('watch-list-refresh', { videoUrl: A });
  const reply = await a.call('watch-list-move', { videoUrl: A, id: 'doc-a', location: 'shortlist', baseLocation: 'later' });
  assert.equal(reply.ok, true); assert.equal((await a.store.get(A)).location, 'shortlist');
  assert.deepEqual(JSON.parse(a.requests.find(r => r.method === 'PATCH').body), { location: 'shortlist' });
  assert.equal(a.documents.get('doc-a').notes, 'Private saved note');
  const conflict = await a.call('watch-list-move', { videoUrl: A, location: 'archive', baseLocation: 'later' });
  assert.equal(conflict.code, 'location_conflict'); assert.equal(a.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('delete needs one-use document-scoped confirmation; verified transport updates durable history and old markers', async () => {
  const a = app({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1 } } });
  const prepared = await a.call('watch-list-prepare-delete', { videoUrl: A });
  assert.equal(prepared.ok, true); assert.ok(!JSON.stringify(prepared).includes('Private saved note')); assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal((await a.call('watch-list-delete', { token: prepared.token, confirmed: true }, { ...scope, scope: 'other-document' })).code, 'invalid_confirmation');
  const fresh = await a.call('watch-list-prepare-delete', { videoUrl: A });
  assert.equal((await a.call('watch-list-delete', { token: fresh.token, confirmed: true })).ok, true);
  assert.equal((await a.store.get(A)).status, 'deleted'); assert.equal(a.data.readerDeletedVideos[A].id, 'doc-a');
  assert.equal((await a.store.page({ filter: 'all' })).items.length, 0);
  assert.equal((await a.call('watch-list-delete', { token: fresh.token, confirmed: true })).code, 'invalid_confirmation');
  assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('expired or unverified deletion never creates success or local deletion history', async () => {
  const a = app(); await a.record(); const prepared = await a.call('watch-list-prepare-delete', { videoUrl: A }); a.advance(120001);
  assert.equal((await a.call('watch-list-delete', { token: prepared.token, confirmed: true })).code, 'invalid_confirmation');
  assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 0);
  const fakeReader = { handle: async m => m.type === 'reader-watch-prepare-delete' ? { ok: true, document: { ...raw(), videoUrl: A, updatedAt: 'v1' } } : { ok: true, id: 'doc-a' } };
  const bridge = a.context.MVSReaderWatchService.create({ store: a.store, reader: fakeReader, uuid: () => 'unverified' });
  const ticket = await bridge.handle({ type: 'watch-list-prepare-delete', videoUrl: A }, scope);
  assert.equal((await bridge.handle({ type: 'watch-list-delete', token: ticket.token, confirmed: true }, scope)).code, 'delete_unverified');
  assert.equal((await a.store.get(A)).status, 'saved');
});

test('background only grants Watch list operations to its exact bundled page', async () => {
  const a = app(); a.loadBackground();
  const message = { type: 'watch-list-page', filter: 'watch' };
  for (const sender of [{ id: 'extension', frameId: 0, url: A }, { id: 'other', url: 'chrome-extension://extension/watch.html' },
    { id: 'extension', frameId: 1, url: 'chrome-extension://extension/watch.html' }]) {
    assert.equal((await a.message(message, sender)).code, 'invalid_sender');
  }
  assert.equal((await a.message(message, { id: 'extension', frameId: 0, url: 'chrome-extension://extension/watch.html', documentId: 'owned' })).ok, true);
  assert.equal(a.requests.length, 0);
});

test('failed history writes abort atomically, report storage errors and preserve previous rows and migration input', async () => {
  const a = app(); await a.record(); const original = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'items') throw new DOMException('fixture quota', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    await assert.rejects(a.record(A, 'replacement', { title: 'Must not replace' }), { code: 'watch_storage_error' });
    assert.equal((await a.store.get(A)).readerId, 'doc-a');
    const retained = app({ stored: { readerSavedUrls: { [B]: 20 } } });
    await assert.rejects(retained.store.ready(), { code: 'watch_storage_error' });
    assert.equal(retained.data.readerSavedUrls[B], 20);
    IDBObjectStore.prototype.put = original;
    await retained.store.ready(); assert.equal((await retained.store.page()).items.length, 1);
  } finally { IDBObjectStore.prototype.put = original; }
});

test('one background save hook captures successful overlay/Lists saves with metadata and surfaces partial local failure', async () => {
  const a = app({ responder: (url, init) => url.endsWith('/save/') ? { status: 201, id: 'doc-a', url: 'https://read.readwise.io/read/doc-a' } : null });
  a.loadBackground();
  const save = { type: 'save-to-reader', pageUrl: A, title: 'Captured title', author: 'Captured channel' };
  const reply = await a.message(save, { id: 'extension', frameId: 0, url: A, tab: { id: 1, url: A } });
  assert.equal(reply.ok, true); assert.equal(reply.historyWarning, false);
  const page = await a.message({ type: 'watch-list-page', filter: 'all' }, { id: 'extension', url: 'chrome-extension://extension/watch.html', documentId: 'owned' });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].title, 'Captured title'); assert.equal(page.items[0].author, 'Captured channel'); assert.equal(page.items[0].readerId, 'doc-a');
  assert.equal(a.requests.filter(r => r.method === 'POST').length, 1);
  const broken = app({ responder: () => ({ status: 201, id: 'doc-a', url: 'https://read.readwise.io/read/doc-a' }) });
  broken.context.MVSReaderWatchStore.create = () => ({ ready: async () => { throw Error('quota'); }, recordSave: async () => { throw Error('quota'); } });
  broken.loadBackground(); // Restore the injected failing factory after importScripts reloads its definition.
  broken.context.MVSReaderWatchStore.create = () => ({ ready: async () => { throw Error('quota'); }, recordSave: async () => { throw Error('quota'); } });
  const partial = await broken.message(save, { id: 'extension', url: A, tab: { id: 1, url: A } });
  assert.equal(partial.ok, true); assert.equal(partial.historyWarning, true); assert.equal(broken.requests.filter(r => r.method === 'POST').length, 1);
  assert.ok(broken.data.readerSavedUrls[A]);
});

test('deleted history rejects late presence; explicit re-save clears the tombstone without reusing an invalid old ID', async () => {
  const a = app(); await a.record(); await a.store.verify(A, { id: 'doc-a', videoUrl: A, summary: 'Old cache', location: 'later' });
  await a.store.mark(A, 'doc-a', 'deleted');
  assert.equal(await a.store.verify(A, { id: 'doc-a', videoUrl: A, summary: 'Late response', location: 'later' }), null);
  assert.equal((await a.store.get(A)).status, 'deleted');
  await a.record(A, null); const row = await a.store.get(A);
  assert.equal(row.status, 'saved'); assert.equal(row.readerId, null); assert.equal(row.checkedAt, 0);
  assert.equal((await a.store.page()).items[0].summary, null);
});

test('verified missing or wrong-source IDs leave To watch while retained rows remain in All saves', async () => {
  const a = app(); await a.record(); a.documents.delete('doc-a');
  assert.equal((await a.call('watch-list-refresh', { videoUrl: A })).code, 'not_found');
  assert.equal((await a.store.page()).items.length, 0); assert.equal((await a.store.page({ filter: 'all' })).items[0].status, 'missing');
  await a.record(); a.documents.set('doc-a', raw('doc-a', B));
  assert.equal((await a.call('watch-list-refresh', { videoUrl: A })).code, 'not_found');
  assert.equal((await a.store.get(A)).status, 'missing'); assert.equal(a.requests.filter(r => r.method === 'POST').length, 0);
});

test('summary size stays bounded separately from history and reports a cached excerpt', async () => {
  const a = app(); await a.record(); await a.store.verify(A, { id: 'doc-a', videoUrl: A, summary: 'x'.repeat(64001), location: 'later' });
  const row = (await a.store.page()).items[0];
  assert.equal(row.summary.length, 64000); assert.equal(row.summaryTruncated, true); assert.equal(row.readerId, 'doc-a');
});

test('changing Reader credentials invalidates a previously prepared Watch list deletion ticket', async () => {
  const a = app({ stored: { readerSavedUrls: { [A]: 1 }, readerDocuments: { [A]: { id: 'doc-a', at: 1 } } } }); a.loadBackground();
  const sender = { id: 'extension', frameId: 0, url: 'chrome-extension://extension/watch.html', documentId: 'owned' };
  const ticket = await a.message({ type: 'watch-list-prepare-delete', videoUrl: A }, sender); assert.equal(ticket.ok, true);
  a.changeToken('replacement-fixture-token');
  const reply = await a.message({ type: 'watch-list-delete', token: ticket.token, confirmed: true }, sender);
  assert.equal(reply.code, 'invalid_confirmation'); assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('absence discovered after confirmation marks a missing match without claiming a delete or sending DELETE', async () => {
  const a = app(); await a.record(); const ticket = await a.call('watch-list-prepare-delete', { videoUrl: A });
  a.documents.delete('doc-a');
  const reply = await a.call('watch-list-delete', { token: ticket.token, confirmed: true });
  assert.equal(reply.code, 'delete_target_missing'); assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal((await a.store.get(A)).status, 'missing'); assert.equal((await a.store.page()).items.length, 0); assert.ok(!a.data.readerDeletedVideos[A]);
});

test('tags are retained only from verified Reader metadata, bounded, and reset for a replacement document', async () => {
  const a = app(); await a.record(); assert.equal((await a.store.page()).items[0].tags, null);
  await a.call('watch-list-refresh', { videoUrl: A });
  assert.deepEqual(Array.from((await a.store.page()).items[0].tags), ['Learning']);
  assert.equal(a.requests.length, 1); // Same exact-ID document read supplies summary, tags and location.
  await a.record(A, 'doc-a', {}, { openExisting: true }); assert.deepEqual(Array.from((await a.store.get(A)).tags), ['Learning']);
  const tags = ['<img src=x onerror=alert(1)>', '', null, 'x'.repeat(300), ...Array.from({ length: 110 }, (_, i) => `Tag ${i}`)];
  await a.store.verify(A, { id: 'doc-a', videoUrl: A, summary: 'Summary', location: 'later', tags });
  let row = (await a.store.page()).items[0]; assert.equal(row.tags.length, 100); assert.equal(row.tags[0], tags[0]); assert.equal(row.tags[1].length, 200);
  await a.record(A, 'replacement'); row = (await a.store.page()).items[0]; assert.equal(row.tags, null); assert.equal(row.summary, null);
  assert.equal(a.requests.length, 1);
});

test('search finds retained title/channel/cached-summary terms beyond the visible page, case-insensitively and without Reader calls', async () => {
  const a = app();
  for (let i = 0; i < 35; i++) {
    a.advance(1); const url = `https://www.youtube.com/watch?v=search_${i}`, id = `search-${i}`;
    await a.record(url, id, { title: i === 0 ? 'Design practice' : 'Ordinary video', author: i === 1 ? 'Hidden Channel' : 'Maker' });
    if (i === 0) await a.store.verify(url, { id, videoUrl: url, title: 'Design practice', author: 'Maker', location: 'later', summary: 'A philosophy of attention', tags: [] });
  }
  assert.equal((await a.call('watch-list-page')).items.length, 12);
  for (const query of ['DESIGN', ' hidden   CHANNEL ', 'ATTENTION', 'ＤＥＳＩＧＮ philosophy']) {
    const reply = await a.call('watch-list-page', { query });
    assert.equal(reply.ok, true); assert.equal(reply.items.length, 1);
  }
  assert.equal((await a.call('watch-list-page', { query: 'not fetched' })).items.length, 0);
  assert.equal((await a.call('watch-list-page', { query: '<img' })).items.length, 0);
  assert.equal(a.requests.length, 0);
});

test('exact channel filtering intersects query/location and paginates every retained match without duplicates', async () => {
  const a = app();
  for (let i = 0; i < 33; i++) {
    const url = `https://www.youtube.com/watch?v=channels_${i}`, id = `channel-${i}`; a.advance(1);
    await a.record(url, id, { title: i % 2 ? 'Quiet craft' : 'Learning', author: i < 26 ? 'Maker' : 'Maker Extra' });
    await a.store.verify(url, { id, videoUrl: url, title: i % 2 ? 'Quiet craft' : 'Learning', author: i < 26 ? 'Maker' : 'Maker Extra', location: i === 0 ? 'archive' : 'later', summary: '' });
  }
  const seen = new Set(); let cursor = null;
  do {
    const page = await a.call('watch-list-page', { channel: '  MAKER  ', cursor });
    for (const item of page.items) { assert.equal(item.author, 'Maker'); assert.ok(!seen.has(item.videoUrl)); seen.add(item.videoUrl); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 25); // exact Maker, excluding the archived item in To watch
  assert.equal((await a.call('watch-list-page', { channel: 'Maker', filter: 'all' })).hasNext, true);
  const archived = await a.call('watch-list-page', { channel: 'Maker', filter: 'archive', query: 'learning' });
  assert.equal(archived.items.length, 1);
  assert.equal((await a.call('watch-list-page', { channel: 'Maker Extra', query: 'quiet craft' })).items.length, 3);
  assert.equal((await a.call('watch-list-page', { channel: 'Make' })).items.length, 0);
  assert.equal(a.requests.length, 0);
});

test('search ignores uncached, empty, stale-ID and missing summaries; clearing criteria restores indexed pages', async () => {
  const a = app(); await a.record(); await a.record(B, 'doc-b');
  await a.store.verify(A, { id: 'doc-a', videoUrl: A, title: 'One', author: 'A channel', summary: 'unique cached phrase', location: 'later' });
  assert.equal((await a.call('watch-list-page', { query: 'unique' })).items.length, 1);
  await a.record(A, 'replacement', { title: 'Replacement', author: 'A channel' });
  assert.equal((await a.call('watch-list-page', { query: 'unique' })).items.length, 0);
  assert.equal((await a.call('watch-list-page', { query: 'summary not fetched' })).items.length, 0);
  assert.equal((await a.call('watch-list-page', { query: '   ' })).items.length, 2);
  await a.store.verify(A, { id: 'replacement', videoUrl: A, title: 'Replacement', author: 'A channel', summary: '', location: 'later' });
  assert.equal((await a.call('watch-list-page', { query: 'not available' })).items.length, 0);
  await a.store.verify(A, { id: 'replacement', videoUrl: A, title: 'Replacement', author: 'A channel', summary: 'unique cached phrase', location: 'later' });
  await a.store.mark(A, 'replacement', 'missing');
  assert.equal((await a.call('watch-list-page', { filter: 'all', query: 'unique' })).items.length, 0);
  assert.equal((await a.call('watch-list-page', { filter: 'all', query: 'replacement' })).items.length, 1);
  assert.equal(a.requests.length, 0);
});

test('search validates input bounds and treats query text as literal inert data', async () => {
  const a = app(); await a.record(A, 'doc-a', { title: '<img src=x onerror=alert(1)> .*', author: 'A [channel]' });
  assert.equal((await a.call('watch-list-page', { query: '.*', channel: 'A [channel]' })).items.length, 1);
  for (const values of [{ query: {} }, { query: 'x'.repeat(301) }, { channel: ['Maker'] }, { channel: 'x'.repeat(301) }]) {
    assert.equal((await a.call('watch-list-page', values)).code, 'invalid_request');
  }
  assert.equal(a.requests.length, 0);
});

test('superseded local scans stop per page scope without cancelling another tab or calling Reader', async () => {
  const a = app(); await a.record(); await a.record(B, 'doc-b');
  const old = a.call('watch-list-page', { query: 'absent' });
  const latest = a.call('watch-list-page', { query: 'local' });
  const other = a.call('watch-list-page', { query: 'local' }, { ...scope, scope: 'another-page' });
  assert.equal((await old).code, 'stale_search'); assert.equal((await latest).items.length, 2); assert.equal((await other).items.length, 2);
  const stopped = await a.store.page({ query: 'anything', isCurrent: () => false }); assert.equal(stopped.stale, true);
  assert.equal(a.requests.length, 0);
});

async function seedDeletionTrace(a, count = 8) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const videoUrl = `https://www.youtube.com/watch?v=trace_${i}`, id = `trace-${i}`;
    a.documents.set(id, raw(id, videoUrl)); await a.record(videoUrl, id); rows.push({ videoUrl, id });
  }
  return rows;
}
const methods = a => a.requests.map(request => request.method || 'GET');
async function deleteRow(a, row) {
  const prepared = await a.call('watch-list-prepare-delete', row);
  if (!prepared.ok) return prepared;
  return a.call('watch-list-delete', { token: prepared.token, confirmed: true });
}

test('consecutive Recent saves deletes use three exact-ID reads and one DELETE each; initial/cache/redraw pages make zero HTTP requests', async () => {
  const a = app(), rows = await seedDeletionTrace(a);
  for (const filter of ['watch', 'all', 'archive']) await a.call('watch-list-page', { filter });
  assert.equal(a.requests.length, 0);
  for (let i = 0; i < 6; i++) {
    assert.equal((await deleteRow(a, rows[i])).ok, true);
    await a.call('watch-list-page', { filter: 'all' });
    assert.deepEqual(methods(a).slice(i * 4), ['GET', 'GET', 'DELETE', 'GET']);
    assert.ok(a.requests.slice(i * 4).every(request => request.url.includes(rows[i].id)));
  }
  const blocked = await deleteRow(a, rows[6]);
  assert.equal(blocked.code, 'rate_limited'); assert.equal(blocked.rateLimitSource, 'local'); assert.equal(blocked.retryAt, 160000);
  assert.equal(a.requests.length, 24); assert.equal((await a.store.get(rows[6].videoUrl)).status, 'saved');
  a.advance(60000); assert.equal((await deleteRow(a, rows[6])).ok, true);
});

test('twelve explicit refreshes leave room for two strict deletes; blocked preparation wastes no reads and never reports a Reader 429', async () => {
  const a = app(), rows = await seedDeletionTrace(a, 12);
  for (const row of rows) assert.equal((await a.call('watch-list-refresh', row)).ok, true);
  for (const row of rows.slice(0, 2)) assert.equal((await deleteRow(a, row)).ok, true);
  const blocked = await deleteRow(a, rows[2]);
  assert.equal(blocked.rateLimitSource, 'local'); assert.equal(a.requests.length, 20);
  assert.equal(a.requests.filter(request => request.method === 'DELETE').length, 2);
  assert.equal(a.data.readerPanelBudget.blockedUntil, undefined);
});

test('shared panel/hover reads during confirmation cannot strand a DELETE without local verification capacity', async () => {
  const a = app(), [row] = await seedDeletionTrace(a, 1);
  await a.reader.remember(row.videoUrl, row.id);
  const prepared = await a.call('watch-list-prepare-delete', row);
  for (let i = 0; i < 16; i++) {
    const type = i % 2 ? 'reader-card-get' : 'reader-panel-get';
    assert.equal((await a.reader.handle({ type, pageUrl: row.videoUrl, targetUrl: row.videoUrl })).ok, true);
  }
  const blocked = await a.call('watch-list-delete', { token: prepared.token, confirmed: true });
  assert.equal(blocked.rateLimitSource, 'local'); assert.equal(blocked.retryAt, 160000);
  assert.equal(a.requests.length, 17); assert.equal(a.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal(a.documents.has(row.id), true);
  // A blocked one-use ticket is not replayed after the cooldown.
  a.advance(60000); assert.equal((await a.call('watch-list-delete', { token: prepared.token, confirmed: true })).code, 'invalid_confirmation');
  assert.equal((await deleteRow(a, row)).ok, true);
});

test('prepare capacity waits for all three read slots and the delete slot, without consuming available requests', async () => {
  const a = app({ stored: { readerPanelBudget: { list: Array.from({ length: 17 }, (_, i) => 50000 + i * 1000), delete: Array(18).fill(70000) } } });
  await a.record(); const blocked = await a.call('watch-list-prepare-delete', { videoUrl: A });
  assert.equal(blocked.rateLimitSource, 'local'); assert.equal(blocked.retryAt, 130000); assert.equal(a.requests.length, 0);
  a.advance(30000); assert.equal((await a.call('watch-list-prepare-delete', { videoUrl: A })).ok, true);
});

test('upstream 429 during verification remains uncertain, persists Reader cooldown across restart and never retries DELETE', async () => {
  let deleted = false;
  const a = app({ responder: (url, init) => {
    if (init.method === 'DELETE') { deleted = true; return { status: 204 }; }
    if (deleted) return { status: 429, retryAfter: '120' };
  } });
  await a.record(); const result = await deleteRow(a, { videoUrl: A });
  assert.equal(result.code, 'delete_uncertain'); assert.equal(result.rateLimitSource, 'reader'); assert.equal(result.retryAt, 220000);
  assert.deepEqual(methods(a), ['GET', 'GET', 'DELETE', 'GET']);
  assert.notEqual((await a.store.get(A)).status, 'deleted');
  const blocked = await a.call('watch-list-prepare-delete', { videoUrl: A });
  assert.equal(blocked.rateLimitSource, 'reader'); assert.equal(a.requests.length, 4);
  const restarted = app({ stored: a.data }); await restarted.record();
  assert.equal((await restarted.call('watch-list-refresh', { videoUrl: A })).rateLimitSource, 'reader'); assert.equal(restarted.requests.length, 0);
});

test('confirmation retry time frees enough staggered read slots, and remains locally sourced after a worker restart', async () => {
  const stored = { readerPanelBudget: { list: Array.from({ length: 17 }, (_, i) => 50000 + i * 1000) } };
  const a = app({ stored }); await a.record();
  const result = await a.call('watch-list-prepare-delete', { videoUrl: A });
  assert.equal(result.retryAt, 111000); assert.equal(result.rateLimitSource, 'local'); assert.equal(a.requests.length, 0);
  const restarted = app({ stored: a.data }); await restarted.record();
  assert.equal((await restarted.call('watch-list-prepare-delete', { videoUrl: A })).rateLimitSource, 'local');
  assert.equal(restarted.requests.length, 0);
  a.advance(11000); assert.equal((await a.call('watch-list-prepare-delete', { videoUrl: A })).ok, true);
});

test('a queued hover read cannot consume the strict deletion verification slot', async () => {
  let release, reads = 0;
  const a = app({ stored: { readerPanelBudget: { list: Array(15).fill(100000) } }, responder: async (url, init) => {
    if (!init.method && ++reads === 2) await new Promise(resolve => { release = resolve; });
  } });
  await a.record(); await a.record(B, 'doc-b'); await a.reader.remember(B, 'doc-b');
  const prepared = await a.call('watch-list-prepare-delete', { videoUrl: A });
  const deletion = a.call('watch-list-delete', { token: prepared.token, confirmed: true });
  while (!release) await new Promise(setImmediate);
  const hover = a.reader.handle({ type: 'reader-card-get', pageUrl: B, targetUrl: B }); release();
  assert.equal((await deletion).ok, true); assert.equal((await hover).rateLimitSource, 'local');
  assert.deepEqual(methods(a), ['GET', 'GET', 'DELETE', 'GET']);
});
