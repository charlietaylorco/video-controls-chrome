// Exercise the real background dispatcher with disposable HTTP/tab/storage mocks.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), own = 'chrome-extension://extension/watch.html', video = 'https://www.youtube.com/watch?v=alpha';
function fixture({ token = 'fake-token', status = 200, offline = false, tabError = false, noTab = false } = {}) {
  let listener;
  const data = { raindropToken: token }, requests = [], created = [], updated = [];
  const chrome = { runtime: { id: 'extension', lastError: null, getURL: f => 'chrome-extension://extension/' + f, onMessage: { addListener(fn) { listener = fn; } } },
    action: { onClicked: { addListener() {} } }, storage: { local: {
      get(defaults, cb) { cb({ ...defaults, ...data }); }, set(values, cb) { Object.assign(data, values); cb?.(); }
    } }, tabs: {
      create(options, cb) { created.push(options); chrome.runtime.lastError = tabError ? { message: 'Cannot launch' } : null; cb(noTab ? undefined : { id: 8 }); chrome.runtime.lastError = null; },
      update(id, options, cb) { updated.push({ id, ...options }); cb({ id }); }
    } };
  const context = vm.createContext({ chrome, URL, AbortSignal, console, importScripts() {}, fetch: async (url, init) => {
    requests.push({ url, ...init }); if (offline) throw Error('offline');
    return { ok: status === 200, status, json: async () => ({ result: true }) };
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'reader-core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const send = (message, sender = { id: 'extension', url: own, frameId: 0, tab: { id: 2, windowId: 3 } }) => new Promise(resolve => listener(message, sender, resolve));
  return { data, requests, created, updated, send, action: (action, pageUrl = video, sender) => send({ type: 'watch-card-action', action, pageUrl }, sender) };
}
test('Recent saves Raindrop action reuses canonical URL, Unsorted request and saved flags without Reader calls', async () => {
  const f = fixture(); assert.equal((await f.action('raindrop', 'https://youtu.be/alpha?t=4')).ok, true);
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.url, 'https://api.raindrop.io/rest/v1/raindrop'); assert.equal(request.headers.Authorization, 'Bearer fake-token');
  assert.deepEqual(JSON.parse(request.body), { link: video, collection: { $id: -1 }, pleaseParse: {} });
  assert.ok(f.data.raindropSavedUrls[video]); assert.equal(f.created.length, 0); assert.equal(f.updated.length, 0);
});
test('Recent saves Downie handoff opens a separate tab with the existing protocol and records only sent status', async () => {
  const f = fixture(); assert.equal((await f.action('downie')).ok, true);
  assert.equal(f.created.length, 1); assert.equal(f.created[0].url, 'downie://XUOpenLink?url=https://www.youtube.com/watch?v=alpha');
  assert.equal(f.created[0].active, false); assert.equal(f.created[0].openerTabId, 2); assert.equal(f.created[0].windowId, 3);
  assert.equal(f.updated.length, 0); assert.equal(f.requests.length, 0); assert.ok(f.data.downieSentUrls[video]);
  const page = fixture(); assert.equal((await page.action('downie', video, { id: 'extension', url: own })).ok, true);
  assert.equal(page.created[0].openerTabId, undefined);
});
test('card dispatcher rejects foreign frames/pages, non-active senders, unknown actions and unsafe targets before effects', async () => {
  const f = fixture();
  for (const sender of [{ id: 'other', url: own }, { id: 'extension', url: own + '?fake' }, { id: 'extension', url: own, frameId: 1 },
    { id: 'extension', url: own, documentLifecycle: 'prerender' }, { id: 'extension', url: 'https://www.youtube.com/' }]) {
    assert.equal((await f.action('downie', video, sender)).ok, false);
  }
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=alpha', 'https://example.com/video.mp4', 'https://u:p@www.youtube.com/watch?v=alpha']) assert.equal((await f.action('raindrop', url)).ok, false);
  assert.equal((await f.action('reader')).ok, false);
  assert.equal(f.requests.length + f.created.length + f.updated.length, 0);
});
test('missing/rejected Raindrop credentials, network failures and unavailable Downie never mark successful actions', async () => {
  for (const [options, action, code] of [[{ token: '' }, 'raindrop', 'missing_token'], [{ status: 401 }, 'raindrop', 'unauthorized'],
    [{ offline: true }, 'raindrop', 'save_failed'], [{ tabError: true }, 'downie', 'launch_failed'], [{ noTab: true }, 'downie', 'launch_failed']]) {
    const f = fixture(options); const reply = await f.action(action); assert.equal(reply.ok, false); assert.equal(reply.code, code);
    assert.equal(f.data.raindropSavedUrls, undefined); assert.equal(f.data.downieSentUrls, undefined);
  }
});
test('existing content-script Downie dispatch still updates its sender tab using the existing URL encoding', async () => {
  const f = fixture(); const reply = await f.send({ type: 'open-in-downie', pageUrl: video }, { url: video, tab: { id: 5 } });
  assert.equal(reply.ok, true); assert.equal(f.created.length, 0); assert.equal(f.updated[0].id, 5);
  assert.equal(f.updated[0].url, 'downie://XUOpenLink?url=https://www.youtube.com/watch?v=alpha');
});
