const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const KEY = 'subscriptionsReviewV1';
const plain = (value) => JSON.parse(JSON.stringify(value));
const video = (id = 'abcdefghijk', title = 'A subscription video') => ({ id, title, channel: 'Example channel' });
const sender = { id: 'test', tab: { id: 1 }, url: 'https://www.youtube.com/feed/subscriptions', frameId: 0 };

function worker(saved = {}) {
  const data = plain(saved);
  const writes = [];
  const reads = [];
  let listener;
  let failure = false;
  const context = vm.createContext({ URL, AbortSignal, TextEncoder, Date, crypto: { randomUUID }, console,
    chrome: {
      runtime: { id: 'test', lastError: null, getURL: (url) => `chrome-extension://test/${url}`, onMessage: { addListener(fn) { listener = fn; } } },
      action: { onClicked: { addListener() {} } },
      storage: { local: {
        get(keys, callback) { reads.push(keys); setImmediate(() => callback(plain(data))); },
        set(values, callback) {
          setImmediate(() => {
            if (failure) context.chrome.runtime.lastError = { message: 'QUOTA_BYTES exceeded' };
            else { writes.push(plain(values)); Object.assign(data, plain(values)); }
            callback();
            context.chrome.runtime.lastError = null;
          });
        },
      } },
    },
  });
  context.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const request = (action, values = {}, source = sender) => new Promise((resolve) => {
    assert.equal(listener({ type: 'subscriptions-review', action, ...values }, source, resolve), true);
  });
  const model = vm.runInContext('SubscriptionsReviewState', context);
  return { data, writes, reads, request, model, fail(value) { failure = value; } };
}

test('subscription decisions never read, import, or write YT Lists data', async () => {
  const app = worker({ ytListsArchived: { abcdefghijk: 123 }, ytLists: [{ id: 'old', channels: [] }] });
  const initial = await app.request('get');
  assert.deepEqual(plain(initial.state.entries), {});
  assert.equal((await app.request('later', { video: video() })).ok, true);
  assert.ok(app.data[KEY].entries.abcdefghijk.laterAt);
  assert.equal(app.data.ytListsArchived.abcdefghijk, 123);
  assert.ok(app.reads.every((keys) => keys.length === 1 && keys[0] === KEY));
  assert.ok(app.writes.every((values) => Object.keys(values).length === 1 && Object.hasOwn(values, KEY)));
});

test('concurrent tabs serialize distinct mutations and preserve both decisions', async () => {
  const app = worker();
  const responses = await Promise.all([
    app.request('hide', { video: video() }),
    app.request('later', { video: video('lmnopqrstuv') }),
  ]);
  assert.ok(responses.every((result) => result.ok));
  assert.equal(app.data[KEY].revision, 2);
  assert.ok(app.data[KEY].entries.abcdefghijk.hiddenAt);
  assert.ok(app.data[KEY].entries.lmnopqrstuv.laterAt);
});

test('decisions and undo tokens survive a cold service-worker restart', async () => {
  const first = worker();
  const saved = await first.request('later', { video: video() });
  const restarted = worker(first.data);
  assert.ok((await restarted.request('get')).state.entries.abcdefghijk.laterAt);
  assert.equal((await restarted.request('undo', { token: saved.undoToken })).ok, true);
  assert.deepEqual(plain(restarted.data[KEY].entries), {});
});

test('undo restores exact prior Later state after moving a video to Hidden', async () => {
  const app = worker();
  const saved = await app.request('later', { video: video() });
  const before = plain(saved.state.entries.abcdefghijk);
  const hidden = await app.request('hide', { video: video() });
  assert.equal(hidden.state.entries.abcdefghijk.laterAt, 0);
  const undone = await app.request('undo', { token: hidden.undoToken });
  assert.deepEqual(plain(undone.state.entries.abcdefghijk), before);
});

test('stale undo cannot override a newer decision on the same video in another tab', async () => {
  const app = worker();
  const hidden = await app.request('hide', { video: video() });
  await app.request('later', { video: video() });
  const undone = await app.request('undo', { token: hidden.undoToken });
  assert.equal(undone.ok, false);
  assert.match(undone.error, /changed|expired/);
  assert.ok(app.data[KEY].entries.abcdefghijk.laterAt);
});

test('storage failure is reported, retains previous decisions, and does not poison the writer', async () => {
  const app = worker();
  await app.request('hide', { video: video() });
  app.fail(true);
  assert.equal((await app.request('later', { video: video('lmnopqrstuv') })).ok, false);
  assert.equal(app.data[KEY].revision, 1);
  app.fail(false);
  assert.equal((await app.request('later', { video: video('lmnopqrstuv') })).ok, true);
  assert.equal(app.data[KEY].revision, 2);
});

test('restoring, removing and bulk actions affect only their own collections', async () => {
  const app = worker();
  await app.request('hide', { video: video() });
  await app.request('later', { video: video('lmnopqrstuv') });
  await app.request('remove', { id: 'abcdefghijk' });
  await app.request('restore', { id: 'lmnopqrstuv' });
  assert.ok(app.data[KEY].entries.abcdefghijk.hiddenAt);
  assert.ok(app.data[KEY].entries.lmnopqrstuv.laterAt);
  await app.request('restoreAll');
  assert.deepEqual(Object.keys(app.data[KEY].entries), ['lmnopqrstuv']);
  await app.request('clearLater');
  assert.deepEqual(plain(app.data[KEY].entries), {});
});

test('worker rejects foreign pages, frames, malformed actions and IDs without writing', async () => {
  const app = worker();
  for (const source of [
    { ...sender, url: 'https://evil.example/feed/subscriptions' },
    { ...sender, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    { ...sender, url: 'http://www.youtube.com/feed/subscriptions' },
    { ...sender, frameId: 1 },
    { ...sender, id: 'another-extension' },
    { ...sender, tab: undefined },
  ]) assert.equal((await app.request('hide', { video: video() }, source)).ok, false);
  assert.equal((await app.request('hide', { video: video('../evil') })).ok, false);
  assert.equal((await app.request('hide', { video: video(12345678901) })).ok, false);
  assert.equal((await app.request('unknown')).ok, false);
  assert.equal(app.writes.length, 0);
});

test('URL and metadata validation canonicalize links and reject hostile thumbnail destinations', () => {
  const { model } = worker();
  assert.equal(model.videoId('/watch?v=abcdefghijk&list=WL'), 'abcdefghijk');
  assert.equal(model.videoId('/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(model.videoId('/live/abcdefghijk'), 'abcdefghijk');
  for (const url of ['https://evil.example/watch?v=abcdefghijk', 'javascript:alert(1)', '/watch?v=abc',
    'https://user@www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com:444/watch?v=abcdefghijk']) assert.equal(model.videoId(url), '');
  const result = model.sanitizeVideo({ ...video(), url: 'javascript:alert(1)', thumbnail: 'https://evil.example/track', title: 'x'.repeat(2000) });
  assert.equal(result.url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(result.thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(result.title.length, 300);
});

test('unknown state versions are not overwritten, and dictionary-like IDs are ordinary videos', async () => {
  const app = worker({ [KEY]: { version: 99, entries: { abcdefghijk: { video: video(), hiddenAt: 100 } } } });
  assert.equal((await app.request('get')).ok, false);
  assert.equal((await app.request('later', { video: video() })).ok, false);
  assert.equal(app.data[KEY].version, 99);
  delete app.data[KEY];
  assert.equal((await app.request('later', { video: video('constructor') })).ok, true);
  assert.ok(app.data[KEY].entries.constructor.laterAt);
});

test('bounded decision storage refuses overflow without dropping saved items', async () => {
  const app = worker();
  const entries = {};
  for (let i = 0; i < app.model.MAX_RECORDS; i++) {
    const id = `v${String(i).padStart(10, '0')}`;
    entries[id] = { video: video(id), hiddenAt: 100, laterAt: 0 };
  }
  app.data[KEY] = { version: 1, revision: 1, entries, history: [] };
  const result = await app.request('later', { video: video() });
  assert.equal(result.ok, false);
  assert.match(result.error, /storage is full/);
  assert.equal(Object.keys(app.data[KEY].entries).length, app.model.MAX_RECORDS);
  assert.equal(app.writes.length, 0);
});

test('manifest adds no permissions and wires subscription-only helpers before existing behavior', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'tabs', 'downloads']);
  const script = manifest.content_scripts.find((script) => script.js.includes('subscriptions-content.js'));
  assert.deepEqual(script.js, ['subscriptions-state.js', 'subscriptions-content.js']);
  assert.deepEqual(script.matches, ['https://www.youtube.com/*', 'https://youtube.com/*']);
  assert.ok(manifest.content_scripts.some((script) => script.js.includes('yt-lists-content.js')));
});
