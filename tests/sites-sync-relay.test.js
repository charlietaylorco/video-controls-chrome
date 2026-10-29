const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { create, ORIGIN, KEY } = require('../sites-sync-bridge');
const TOKEN = 'x'.repeat(43), NONCE = 'owned-nonce-01234567890123456789';
const URL_SYNC = ORIGIN + '/extension-sync#rs-' + NONCE;
const A = 'https://www.youtube.com/watch?v=alpha';
function content({ href = URL_SYNC, reply = { ok: true, scope: 'user-a' }, type = 'application/json' } = {}) {
  let listener; const requests = [], notifications = [];
  const location = new URL(href), window = {}; window.top = window;
  const chrome = { runtime: { id: 'extension', getURL: file => `chrome-extension://extension/${file}`, onMessage: { addListener(fn) { listener = fn; } },
    sendMessage(message, cb) { notifications.push(message); cb?.({ ok: true }); } } };
  const fetch = async (url, init) => { requests.push({ url, init }); return { status: 200, headers: { get: () => type }, json: async () => reply }; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sites-sync-content.js'), 'utf8'), { location, window, chrome, fetch, AbortSignal });
  return { requests, notifications, listener, send: (message, sender = { id: 'extension', url: 'chrome-extension://extension/background.js' }) => new Promise(resolve => listener(message, sender, resolve)) };
}
const message = (body = { type: 'cloud-ping' }) => ({ type: 'sites-sync-request', nonce: NONCE, requestId: NONCE, token: TOKEN, body });

test('Site content relay runs only in the exact top-level sync route and nonce', () => {
  for (const href of [ORIGIN + '/', ORIGIN + '/extension-sync', ORIGIN + '/extension-sync?different#rs-' + NONCE, 'https://foreign.example/extension-sync#rs-' + NONCE]) assert.equal(content({ href }).listener, undefined);
  assert.equal(typeof content().listener, 'function');
});

test('isolated relay accepts only its own worker and narrow metadata requests', async () => {
  const f = content();
  for (const [request, sender] of [[message(), { id: 'foreign' }], [message(), { id: 'extension', url: ORIGIN + '/' }], [{ ...message(), nonce: 'wrong' }, { id: 'extension' }], [message({ type: 'cloud-export' }), { id: 'extension' }], [message({ type: 'cloud-import', items: [{ videoUrl: A, readerToken: 'DO_NOT_SEND' }] }), { id: 'extension' }]]) assert.equal((await f.send(request, sender)).ok, false);
  assert.equal(f.requests.length, 0);
  const result = await f.send(message()); assert.equal(result.body.scope, 'user-a');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/recent-saves');
  assert.equal(f.requests[0].init.credentials, 'same-origin'); assert.equal(f.requests[0].init.redirect, 'error');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(!JSON.stringify(f.requests).includes('OAI-Sites-Authorization'));
});

test('Site gate HTML becomes an explicit sign-in requirement, never a fake successful import', async () => {
  const f = content({ type: 'text/html' }); const result = await f.send(message());
  assert.equal(result.code, 'sign_in_required'); assert.equal(result.body, undefined);
});

test('content relay strips arbitrary server fields before returning a response', async () => {
  const f = content({ reply: { ok: true, scope: 'user-a', token: 'PRIVATE', notes: 'PRIVATE', accepted: [A] } });
  const result = await f.send(message()); assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.deepEqual(Array.from(result.body.accepted), [A]);
});

function browser({ stored = null, initial = [], redirect = null, defer = false } = {}) {
  const runtimeListeners = [], alarmListeners = [], records = { [KEY]: stored }, tabs = new Map(initial.map(tab => [tab.id, { ...tab }]));
  const created = [], removed = [], sends = [], idle = new Map(); let tabSequence = 100, timerSequence = 10000, requestRelease, requestReply;
  const chrome = { runtime: { id: 'extension', lastError: null, onMessage: { addListener(fn) { runtimeListeners.push(fn); } } },
    storage: { session: { get(defaults, cb) { cb({ ...defaults, ...structuredClone(records) }); }, set(patch, cb) { Object.assign(records, structuredClone(patch)); cb?.(); } } },
    alarms: { create() {}, onAlarm: { addListener(fn) { alarmListeners.push(fn); } } }, tabs: {} };
  const ready = tab => {
    const nonce = /^#rs-(.+)$/.exec(new URL(tab.url).hash)?.[1];
    for (const listener of runtimeListeners) listener({ type: 'sites-sync-ready', nonce }, { id: 'extension', tab, url: tab.url, frameId: 0, documentId: 'live-document', documentLifecycle: 'active' }, () => {});
  };
  chrome.tabs.create = (options, cb) => { created.push(options); const tab = { id: ++tabSequence, ...options, url: redirect || options.url, incognito: false }; tabs.set(tab.id, tab); cb(tab); queueMicrotask(() => ready(tab)); };
  chrome.tabs.get = (id, cb) => { if (!tabs.has(id)) { chrome.runtime.lastError = { message: 'gone' }; cb(); chrome.runtime.lastError = null; } else cb(tabs.get(id)); };
  chrome.tabs.remove = (id, cb) => { removed.push(id); tabs.delete(id); cb?.(); };
  chrome.tabs.sendMessage = (id, request, options, cb) => {
    const tab = tabs.get(id); sends.push({ id, request, options });
    if (request.type === 'sites-sync-check') { ready(tab); cb({ ok: true, nonce: request.nonce, url: tab.url }); return; }
    const reply = { nonce: request.nonce, requestId: request.requestId, url: tab.url, status: 200, body: { ok: true, scope: 'user-a', ...(request.body.type === 'cloud-import' ? { accepted: request.body.items.map(item => item.videoUrl) } : {}) } };
    if (defer) { requestReply = reply; requestRelease = () => cb(requestReply); } else cb(reply);
  };
  const timers = { setTimeout(fn, ms) { if (ms === 2000) { const id = ++timerSequence; idle.set(id, fn); return id; } return setTimeout(fn, ms); }, clearTimeout(id) { if (!idle.delete(id)) clearTimeout(id); } };
  const bridge = create({ chrome, timers, uuid: () => NONCE, timeoutMs: 50, pollMs: 1 });
  return { bridge, chrome, records, tabs, created, removed, sends, idle, release: () => requestRelease?.(), get pending() { return Boolean(requestRelease); }, setReply(value) { requestReply = value; } };
}
const ping = (bridge, body = { type: 'cloud-ping' }) => bridge.request(ORIGIN + '/api/recent-saves', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body) });
const tick = () => new Promise(setImmediate);

test('background reuses one inactive owned tab for a burst, targets its document, then closes only that tab', async () => {
  const userTab = { id: 7, url: ORIGIN + '/extension-sync', active: true }, f = browser({ initial: [userTab] });
  assert.equal((await (await ping(f.bridge)).json()).scope, 'user-a');
  const response = await ping(f.bridge, { type: 'cloud-import', items: [{ videoUrl: A }] }); assert.deepEqual((await response.json()).accepted, [A]);
  assert.equal(f.created.length, 1); assert.equal(f.created[0].active, false);
  assert.equal(f.sends.filter(item => item.request.type === 'sites-sync-request').length, 2);
  assert.ok(f.sends.filter(item => item.request.type === 'sites-sync-request').every(item => item.options.frameId === 0 && item.options.documentId === 'live-document'));
  await f.bridge.close(); assert.deepEqual(f.removed, [101]); assert.equal(f.tabs.has(7), true); assert.equal(f.records[KEY], null);
});

test('worker recovery reuses only its persisted nonce-marked tab and refreshes document identity', async () => {
  const stored = { tabId: 8, nonce: NONCE, url: URL_SYNC, ready: true, documentId: 'previous-document' };
  const f = browser({ stored, initial: [{ id: 8, url: URL_SYNC, incognito: false }] });
  await ping(f.bridge); assert.equal(f.created.length, 0);
  assert.equal(f.sends.at(-1).options.documentId, 'live-document'); await f.bridge.close(); assert.deepEqual(f.removed, [8]);
});

test('a platform sign-in redirect stops sync without sending a token or closing a navigated user tab', async () => {
  const f = browser({ redirect: ORIGIN + '/signin-with-chatgpt' });
  await assert.rejects(ping(f.bridge), error => error.code === 'sign_in_required');
  assert.equal(f.sends.length, 0); await f.bridge.close(); assert.equal(f.removed.length, 0);
});

test('navigation during a request invalidates its response and preserves the navigated tab', async () => {
  const f = browser({ defer: true }), work = ping(f.bridge);
  while (!f.pending) await tick();
  f.tabs.get(101).url = 'https://user.example/'; f.release();
  await assert.rejects(work, error => error.code === 'sign_in_required'); await f.bridge.close(); assert.equal(f.removed.length, 0);
});

test('background relay rejects arbitrary targets and operations before creating a tab', async () => {
  const f = browser();
  await assert.rejects(f.bridge.request('https://foreign.example/api/recent-saves', { method: 'POST' }));
  await assert.rejects(ping(f.bridge, { type: 'cloud-export' }));
  assert.equal(f.created.length, 0);
});

test('a stale session record for a closed relay tab creates a fresh inactive tab', async () => {
  const stored = { tabId: 8, nonce: NONCE, url: URL_SYNC, ready: true, documentId: 'previous-document' };
  const f = browser({ stored }); await ping(f.bridge);
  assert.equal(f.created.length, 1); assert.equal(f.created[0].active, false); await f.bridge.close();
});

test('a JSON request for platform sign-in pauses sync rather than expiring the device token', async () => {
  const f = content({ reply: { ok: false, code: 'auth_required' } });
  assert.equal((await f.send(message())).code, 'sign_in_required');
});
