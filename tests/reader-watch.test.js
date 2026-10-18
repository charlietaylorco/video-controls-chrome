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
  const fakeReader = { handle: async m => m.type === 'reader-watch-get' ? { ok: true, document: { ...raw(), videoUrl: A, updatedAt: 'v1' } } : { ok: true, id: 'doc-a' } };
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
