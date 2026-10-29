const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const cloud = require('../recent-saves-cloud');
const A = 'https://www.youtube.com/watch?v=alpha', TOKEN = 'a'.repeat(43), SITE = 'https://watchlater.chimping.chatgpt.site';
const row = i => ({ videoUrl: `https://www.youtube.com/watch?v=video_${i}`, readerId: `doc-${i}`, savedAt: 1000 + i, updatedAt: 2000 + i, title: `Video ${i}`, status: 'saved' });
const tick = () => new Promise(setImmediate);
function fixture({ count = 0, responder, permitted = true, saved = null } = {}) {
  const data = { recentSavesCloud: saved, readerToken: 'PRIVATE_READER', raindropToken: 'PRIVATE_RAINDROP' };
  const rows = Array.from({ length: count }, (_, i) => row(i)), dirty = new Map(rows.map(item => [item.videoUrl, item.updatedAt]));
  const requests = [], scheduled = [], acknowledged = [];
  let clock = 10000, sequence = 0;
  const storage = { get(defaults, cb) { cb(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, structuredClone(data[key] ?? value)]))); },
    set(patch, cb) { Object.assign(data, structuredClone(patch)); cb?.(); } };
  const store = {
    async exportPage(cursor, limit) {
      const eligible = [...rows].sort((a, b) => b.savedAt - a.savedAt || b.videoUrl.localeCompare(a.videoUrl)).filter(item => !cursor || item.savedAt < cursor[0] || item.savedAt === cursor[0] && item.videoUrl < cursor[1]);
      const items = eligible.slice(0, limit).map(item => structuredClone(item)), hasNext = eligible.length > limit;
      return { items, hasNext, nextCursor: hasNext ? [items.at(-1).savedAt, items.at(-1).videoUrl] : null };
    },
    async dirtyPage(limit) { const items = rows.filter(item => dirty.has(item.videoUrl)).slice(0, limit).map(item => structuredClone(item)); return { items }; },
    async acknowledge(items) { acknowledged.push(items.map(item => item.videoUrl)); for (const item of items) if (dirty.get(item.videoUrl) === item.updatedAt) dirty.delete(item.videoUrl); }
  };
  const permissions = { contains(_request, cb) { cb(permitted); } }, alarms = { create(name, options) { scheduled.push({ name, ...options }); }, clear(name) { scheduled.push({ name, clear: true }); } };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, init, body });
    const result = responder ? await responder(body, { rows, dirty, data }) : null;
    if (result instanceof Error) throw result;
    const value = result || (body.type === 'cloud-ping' ? { ok: true, scope: 'user-a' } : { ok: true, scope: 'user-a', accepted: body.items.map(item => item.videoUrl) });
    return { status: value.status || 200, ok: (value.status || 200) < 400, json: async () => value };
  };
  const sync = cloud.create({ storage, store, fetch, permissions, alarms, now: () => clock, uuid: () => `generation-${++sequence}` });
  return { sync, data, rows, dirty, requests, scheduled, acknowledged, advance(ms) { clock += ms; }, async pair() { return sync.connect(SITE, TOKEN); } };
}

test('pairing accepts root HTTPS DNS origins and rejects permission escalation targets', () => {
  assert.equal(cloud.origin(SITE + '/'), SITE);
  for (const value of ['http://saves.example.test', SITE + '/path', SITE + '?query=x', SITE + '#secret', 'https://user:pass@saves.example.test', SITE + ':443', 'https://localhost', 'https://192.168.1.1', 'https://[::1]', 'https://host.local', 'https://*.example.test', 'https://bad..example.test']) assert.equal(cloud.origin(value), null, value);
});

test('pairing verifies permission/account and imports all history in bounded acknowledged batches before routing', async () => {
  const f = fixture({ count: 57 });
  assert.equal(await f.sync.destination(), null);
  assert.equal((await f.pair()).phase, 'paired'); assert.equal(await f.sync.destination(), null);
  await f.sync.startImport(); await f.sync.resume(); await f.sync.resume();
  const status = await f.sync.status(); assert.equal(status.ready, true); assert.equal(status.imported, 57);
  assert.equal(await f.sync.destination(), SITE + '/'); assert.equal(f.dirty.size, 0);
  const batches = f.requests.filter(request => request.body.type === 'cloud-import');
  assert.deepEqual(batches.map(request => request.body.items.length), [...Array(11).fill(5), 2]);
  assert.ok(f.requests.every(request => request.url === SITE + '/api/recent-saves' && request.init.credentials === 'omit' && request.init.redirect === 'error'));
  assert.ok(!JSON.stringify(f.requests).includes('PRIVATE_READER')); assert.ok(!JSON.stringify(f.requests).includes('PRIVATE_RAINDROP'));
  assert.ok(!JSON.stringify(status).includes(TOKEN));
});

test('an incomplete acknowledgement retains its cursor and dirty records for durable exponential retry', async () => {
  const f = fixture({ count: 30, responder: body => body.type === 'cloud-import' ? { ok: true, scope: 'user-a', accepted: body.items.slice(1).map(item => item.videoUrl) } : null });
  await f.pair(); await f.sync.startImport(); await f.sync.resume();
  assert.equal(f.data.recentSavesCloud.cursor, null); assert.equal(f.data.recentSavesCloud.imported, 0); assert.equal(f.dirty.size, 30);
  const first = (await f.sync.status()).retryAt; assert.equal(first, 70000);
  f.advance(60000); await f.sync.resume(); assert.equal((await f.sync.status()).retryAt, 190000);
  assert.equal(await f.sync.destination(), null); assert.equal(f.acknowledged.length, 0);
});

test('worker restart resumes an interrupted import from the last acknowledged cursor', async () => {
  const saved = { origin: SITE, token: TOKEN, scope: 'user-a', generation: 'persisted', phase: 'importing', imported: 5, cursor: [1005, row(5).videoUrl], attempts: 0 };
  const f = fixture({ count: 10, saved }); await f.sync.resume();
  assert.equal((await f.sync.status()).ready, true); assert.equal((await f.sync.status()).imported, 10);
  assert.deepEqual(f.requests[0].body.items.map(item => item.savedAt), [1004, 1003, 1002, 1001, 1000]);
});

test('disconnect while a batch is in flight cannot acknowledge it, mark ready, or send another batch', async () => {
  let release;
  const f = fixture({ count: 30, responder: body => body.type === 'cloud-import' ? new Promise(resolve => { release = () => resolve({ ok: true, scope: 'user-a', accepted: body.items.map(item => item.videoUrl) }); }) : null });
  await f.pair(); await f.sync.startImport(); while (!release) await tick();
  await f.sync.disconnect(); release(); await f.sync.resume();
  assert.equal(f.data.recentSavesCloud, null); assert.equal(f.dirty.size, 30); assert.equal(f.acknowledged.length, 0);
  assert.equal(f.requests.filter(request => request.body.type === 'cloud-import').length, 1);
});

test('account mismatch pauses uploads and retains all unsynced records', async () => {
  const f = fixture({ count: 1, responder: body => body.type === 'cloud-import' ? { ok: true, scope: 'other-user', accepted: [row(0).videoUrl] } : null });
  await f.pair(); await f.sync.startImport(); await f.sync.resume();
  assert.equal((await f.sync.status()).phase, 'paused'); assert.equal((await f.sync.status()).code, 'account_changed'); assert.equal(f.dirty.size, 1);
  assert.equal(await f.sync.destination(), null);
});

test('missing optional origin permission prevents any pairing request', async () => {
  const f = fixture({ permitted: false }); const result = await f.pair();
  assert.equal(result.ok, false); assert.equal(result.code, 'permission_required'); assert.equal(f.requests.length, 0);
});

test('a newer update during upload remains dirty and is sent again without duplicating an import', async () => {
  let edited = false;
  const f = fixture({ count: 1, responder: (body, context) => {
    if (body.type === 'cloud-import' && !edited) { edited = true; context.rows[0].title = 'Newer title'; context.rows[0].updatedAt++; context.dirty.set(context.rows[0].videoUrl, context.rows[0].updatedAt); }
    return null;
  } });
  await f.pair(); await f.sync.startImport(); await f.sync.resume();
  const batches = f.requests.filter(request => request.body.type === 'cloud-import');
  assert.equal(batches.length, 2); assert.equal(batches[1].body.items[0].title, 'Newer title'); assert.equal(f.dirty.size, 0);
});

function history() {
  const stored = { readerSavedUrls: {}, readerDocuments: {}, readerToken: 'PRIVATE_READER' };
  const storage = { get(defaults, cb) { cb(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, stored[key] ?? value]))); } };
  let now = 1000;
  const context = vm.createContext({ URL, indexedDB: new IDBFactory(), IDBKeyRange, Date });
  for (const file of ['reader-core.js', 'reader-watch-core.js', 'reader-watch-store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return { store: context.MVSReaderWatchStore.create({ storage, now: () => now }), advance() { now++; } };
}

test('real IndexedDB export includes deleted records across >12 rows and joins available summaries without notes or tokens', async () => {
  const f = history();
  for (let i = 0; i < 33; i++) { f.advance(); await f.store.recordSave(row(i).videoUrl, row(i).readerId, { title: row(i).title, description: 'Source description' }); }
  await f.store.verify(row(1).videoUrl, { id: row(1).readerId, videoUrl: row(1).videoUrl, summary: 'Retained summary', notes: 'PRIVATE_NOTE', location: 'later' });
  await f.store.mark(row(2).videoUrl, row(2).readerId, 'deleted');
  const first = await f.store.exportPage(); assert.equal(first.items.length, 25); assert.equal(first.hasNext, true);
  const second = await f.store.exportPage(first.nextCursor); assert.equal(second.items.length, 8); assert.equal(second.hasNext, false);
  const all = [...first.items, ...second.items]; assert.equal(new Set(all.map(item => item.videoUrl)).size, 33);
  assert.equal(all.find(item => item.videoUrl === row(2).videoUrl).status, 'deleted');
  assert.equal(all.find(item => item.videoUrl === row(1).videoUrl).summary, 'Retained summary');
  assert.equal(all[0].description, 'Source description'); assert.ok(!JSON.stringify(all).includes('PRIVATE_'));
  await assert.rejects(f.store.exportPage(null, 26));
});

test('real durable dirty acknowledgements never erase a newer local mutation', async () => {
  const f = history(); await f.store.recordSave(A, 'doc-a', { title: 'Before' });
  const batch = await f.store.dirtyPage(); assert.equal(batch.items.length, 1);
  await f.store.recordSave(A, 'doc-a', { title: 'After' }); await f.store.acknowledge(batch.items);
  const newer = await f.store.dirtyPage(); assert.equal(newer.items.length, 1); assert.equal(newer.items[0].title, 'After');
  await f.store.acknowledge(newer.items); assert.equal((await f.store.dirtyPage()).items.length, 0);
});

function backgroundFixture(state, { granted = true, tabs = [], useWebsite = true } = {}) {
  let action, listener, storageListener, removed;
  const created = [], activated = [], handled = [];
  const chrome = { runtime: { id: 'extension', getURL: file => `chrome-extension://extension/${file}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { get(defaults, cb) { cb({ ...defaults, recentSavesCloud: state, recentSavesOpenWebsite: useWebsite }); }, set(_patch, cb) { cb?.(); } }, onChanged: { addListener(fn) { storageListener = fn; } } },
    permissions: { contains(_request, cb) { cb(granted); }, onRemoved: { addListener(fn) { removed = fn; } } },
    action: { onClicked: { addListener(fn) { action = fn; } } }, tabs: {
      query(_request, cb) { cb(tabs); }, get(id, cb) { cb(tabs.find(tab => tab.id === id)); },
      create(options, cb) { created.push(options); cb?.({ id: 100, ...options }); },
      update(id, patch, cb) { activated.push({ id, ...patch }); cb(tabs.find(tab => tab.id === id)); }
    }
  };
  const context = { chrome, URL, AbortSignal, fetch() {}, importScripts() {},
    MVSReaderWatchStore: { create() { return {}; } },
    MVSRecentSavesCloud: { ...cloud, create() { return { resume() {}, async handle(message) { handled.push(message); return { ok: true }; } }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  return { created, activated, handled, action, removePermission: () => removed(), change: value => storageListener({ recentSavesCloud: { newValue: value } }, 'local'),
    send: (message, sender) => new Promise(resolve => listener(message, sender, resolve)) };
}

test('toolbar switches only a completed verified import to its exact permitted hosted route', async () => {
  const ready = { origin: SITE, phase: 'ready', importComplete: true };
  for (const [state, granted, expected] of [[ready, true, SITE + '/'], [{ ...ready, phase: 'importing' }, true, 'chrome-extension://extension/watch.html'], [ready, false, 'chrome-extension://extension/watch.html']]) {
    const f = backgroundFixture(state, { granted }); f.action({ windowId: 4 }); await tick(); assert.equal(f.created[0].url, expected);
  }
  const f = backgroundFixture(ready, { tabs: [{ id: 1, url: SITE + '/?lookalike' }, { id: 2, url: SITE + '/', incognito: true }, { id: 3, url: SITE + '/', pendingUrl: 'https://elsewhere.test' }] });
  f.action({ windowId: 4 }); await tick(); assert.equal(f.created.length, 1); assert.equal(f.activated.length, 0);
  f.removePermission(); f.action({ windowId: 4 }); await tick(); assert.equal(f.created[1].url, 'chrome-extension://extension/watch.html');
});

test('cloud setup messages accept only the exact active bundled options page', async () => {
  const f = backgroundFixture(null), message = { type: 'recent-saves-cloud', action: 'status' };
  for (const sender of [{ id: 'foreign', url: 'chrome-extension://extension/options.html' }, { id: 'extension', url: SITE + '/' }, { id: 'extension', url: 'chrome-extension://extension/options.html?lookalike' }, { id: 'extension', url: 'chrome-extension://extension/options.html', frameId: 1 }]) assert.equal((await f.send(message, sender)).ok, false);
  assert.equal(f.handled.length, 0);
  assert.equal((await f.send(message, { id: 'extension', url: 'chrome-extension://extension/options.html', frameId: 0 })).ok, true);
  assert.equal(f.handled.length, 1);
});

test('Reader credential changes pause an in-flight import without acknowledging another account’s data', async () => {
  let release;
  const f = fixture({ count: 2, responder: body => body.type === 'cloud-import' ? new Promise(resolve => { release = () => resolve({ ok: true, scope: 'user-a', accepted: body.items.map(item => item.videoUrl) }); }) : null });
  await f.pair(); await f.sync.startImport(); while (!release) await tick();
  await f.sync.invalidateSource(); release(); await f.sync.resume();
  assert.equal((await f.sync.status()).phase, 'paused'); assert.equal((await f.sync.status()).code, 'reader_account_changed');
  assert.equal(f.acknowledged.length, 0); assert.equal(f.dirty.size, 2); assert.equal(await f.sync.destination(), null);
});

test('local history JSON export works without pairing and never calls the website', async () => {
  const f = fixture({ count: 13 }); let cursor = null, items = [];
  do { const result = await f.sync.handle({ action: 'export', cursor }); assert.equal(result.ok, true); assert.ok(result.items.length <= 5); items.push(...result.items); cursor = result.nextCursor; } while (cursor);
  assert.equal(items.length, 13); assert.equal(f.requests.length, 0); assert.ok(!JSON.stringify(items).includes('PRIVATE_'));
});

test('private Site sign-in failure visibly pauses retries while keeping dirty history', async () => {
  const f = fixture({ count: 1, responder: body => body.type === 'cloud-import' ? Object.assign(new Error('private gate'), { code: 'sign_in_required' }) : null });
  await f.pair(); await f.sync.startImport(); await f.sync.resume();
  assert.equal((await f.sync.status()).phase, 'paused'); assert.equal((await f.sync.status()).code, 'sign_in_required'); assert.equal(f.dirty.size, 1);
  assert.equal(await f.sync.destination(), null);
});

test('local Recent saves stays the default even after a completed cloud import', async () => {
  const f = backgroundFixture({origin:SITE,phase:'ready',importComplete:true}, {useWebsite:false});
  f.action({windowId:4});await tick();
  assert.equal(f.created[0].url,'chrome-extension://extension/watch.html');
  assert.ok(fs.readFileSync(path.join(__dirname,'../options.html'),'utf8').includes('href="watch.html"'));
});
