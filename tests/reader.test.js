const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../reader-core.js');
const A = 'https://www.youtube.com/watch?v=alpha';
const B = 'https://www.youtube.com/watch?v=beta';
const doc = (id = 'doc-a', source_url = A, notes = 'Original') => ({
  id, source_url, notes, title: 'A Reader video', summary: 'Summary from Reader', tags: { science: { name: 'Science' } }, parent_id: null,
});
function harness({ stored = {}, responder, tabUrl = A, cardValid = true } = {}) {
  const data = { readerToken: 'fixture-token', ...structuredClone(stored) };
  const requests = [];
  const challenges = [];
  let clock = 100000;
  let listener;
  let tab = { id: 1, url: tabUrl };
  const context = vm.createContext({ URL, AbortSignal, Date, console,
    chrome: {
      runtime: { id: 'extension', lastError: null, getURL: s => s, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        get(defaults, cb) { cb({ ...defaults, ...data }); },
        set(values, cb) { Object.assign(data, values); cb?.(); },
      } }, action: { onClicked: { addListener() {} } }, tabs: { get(id, callback) { callback(tab); },
        sendMessage(id, message, options, callback) { challenges.push({ id, message, options }); callback({ ...message, ok: cardValid }); } },
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const result = await responder?.(url, options, data) || { results: [doc()] };
      if (result instanceof Error) throw result;
      const status = result.status || 200;
      return { ok: status >= 200 && status < 300, status,
        headers: { get() { return result.retryAfter || null; } },
        json: async () => result, text: async () => JSON.stringify(result) };
    },
  });
  context.importScripts = (...files) => files.filter(s => s.startsWith('reader-')).forEach(file =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  const service = context.MVSReaderService.create({ storage: context.chrome.storage.local, fetch: context.fetch, now: () => clock });
  const create = context.MVSReaderService.create;
  context.MVSReaderService.create = options => create({ ...options, now: () => clock });
  return { data, requests, challenges, context, service, advance(ms) { clock += ms; }, setTab(value) { tab = value; },
    get: (pageUrl = A, cursor) => service.handle({ type: 'reader-panel-get', pageUrl, cursor }),
    note: (values = {}) => service.handle({ type: 'reader-panel-save-note', pageUrl: A, id: 'doc-a', notes: 'Edited', baseNotes: 'Original', ...values }),
    delete: (values = {}) => service.handle({ type: 'reader-panel-delete', pageUrl: A, id: 'doc-a', confirmed: true,
      title: 'A Reader video', baseNotes: 'Original', updatedAt: '', ...values }),
    message: (message, sender = { id: 'extension', frameId: 0, url: A, tab: { id: 1, url: A } }) =>
      new Promise(resolve => listener(message, sender, resolve)),
  };
}

test('canonical identity matches watch, mobile, music, embed, short links, live and Shorts', () => {
  for (const value of [A + '&t=22#x', 'https://m.youtube.com/watch?v=alpha',
    'https://music.youtube.com/watch?v=alpha', 'https://youtu.be/alpha?t=3',
    'https://youtube.com/embed/alpha', 'https://youtube.com/shorts/alpha', 'https://youtube.com/live/alpha']) {
    assert.equal(C.canonical(value), A);
  }
  for (const value of ['http://youtube.com/watch?v=alpha', 'https://user@youtube.com/watch?v=alpha',
    'https://youtube.com:444/watch?v=alpha', 'https://youtube.com.evil.test/watch?v=alpha',
    'https://youtube.com/watch?v=a/b', 'https://youtube.com/embed/alpha/extra', 'https://youtu.be/alpha/extra', 'javascript:alert(1)', null]) {
    assert.equal(C.canonical(value), null);
  }
});

const cardMessage = (type = 'reader-card-get', extra = {}) => ({ type, pageUrl: A, targetUrl: B, lease: 'fixture-lease', ...extra });
const cardStored = { readerDocuments: { [B]: { id: 'doc-b', at: 1 } }, readerSavedUrls: { [B]: 1 } };
const cardDoc = () => doc('doc-b', B);
const cardDelete = extra => cardMessage('reader-card-delete', { id: 'doc-b', title: 'A Reader video', updatedAt: '', baseNotes: 'Original', confirmed: true, ...extra });

test('card requests target the hovered video on Home/subscriptions/search/channel/watch while watch guards stay strict', async () => {
  for (const pageUrl of ['https://www.youtube.com/', 'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/results?search_query=learn', 'https://www.youtube.com/@example/videos', A]) {
    const app = harness({ stored: cardStored, tabUrl: pageUrl, responder: () => ({ results: [cardDoc()] }) });
    const result = await app.message(cardMessage('reader-card-get', { pageUrl }));
    assert.equal(result.document.id, 'doc-b'); assert.equal(result.document.videoUrl, B);
    assert.ok(app.requests[0].url.endsWith('list/?id=doc-b'));
    assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: B })).code, 'invalid_sender');
  }
});

test('unsaved card targets never call Reader; legacy saved cards share at most one bounded discovery page per minute', async () => {
  const unsaved = harness();
  assert.equal((await unsaved.message(cardMessage())).code, 'not_saved'); assert.equal(unsaved.requests.length, 0);
  const falseFlag = harness({ stored: { readerSavedUrls: { [B]: false } } });
  assert.equal((await falseFlag.message(cardMessage())).code, 'not_saved'); assert.equal(falseFlag.requests.length, 0);
  const old = harness({ stored: { readerSavedUrls: { [A]: 1, [B]: 1 } }, responder: () => ({ results: [], nextPageCursor: 'do-not-follow' }) });
  assert.equal((await old.message(cardMessage())).code, 'unlinked');
  assert.equal((await old.message(cardMessage('reader-card-get', { targetUrl: A }))).code, 'unlinked');
  assert.equal(old.requests.length, 1); assert.ok(old.requests[0].url.endsWith('list/?category=video&limit=100'));
  const restarted = harness({ stored: old.data });
  assert.equal((await restarted.message(cardMessage())).code, 'unlinked'); assert.equal(restarted.requests.length, 0);
  old.advance(60001); await old.message(cardMessage()); assert.equal(old.requests.length, 2);
});

test('one card discovery page links all matching saved ids without repeated library scans', async () => {
  const app = harness({ stored: { readerSavedUrls: { [B]: 1 } }, responder: () => ({ results: [cardDoc(), doc()] }) });
  assert.equal((await app.message(cardMessage())).document.id, 'doc-b');
  assert.equal((await app.message(cardMessage())).document.id, 'doc-b');
  assert.equal(app.requests.length, 2); assert.ok(app.requests[1].url.endsWith('list/?id=doc-b'));
  assert.equal(app.data.readerDocuments[A].id, 'doc-a');
});

test('card lease, source page, frame, origin and live-card validation reject unsafe targets without API requests', async () => {
  const app = harness({ stored: cardStored });
  for (const values of [{ targetUrl: 'https://evil.test' }, { pageUrl: 'https://evil.test' }, { pageUrl: B }, { lease: '../bad' }])
    assert.equal((await app.message(cardMessage('reader-card-get', values))).code, 'invalid_sender');
  const sender = { id: 'extension', frameId: 1, url: A, tab: { id: 1 } };
  assert.equal((await app.message(cardMessage(), sender)).code, 'invalid_sender');
  const cancelled = harness({ stored: cardStored, cardValid: false });
  assert.equal((await cancelled.message(cardMessage())).code, 'invalid_sender'); assert.equal(cancelled.requests.length, 0);
  assert.equal(app.requests.length, 0);
});

test('a card deletion requires the exact linked id and confirmation; successful deletion clears only that video', async () => {
  const app = harness({ stored: { readerDocuments: { ...cardStored.readerDocuments, [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1, [B]: 1 } },
    responder: (url, init) => init.method === 'DELETE' ? { status: 204 } : { results: [cardDoc()] } });
  for (const values of [{ confirmed: false }, { id: 'doc-a' }]) assert.equal((await app.message(cardDelete(values))).ok, false);
  assert.equal(app.requests.length, 0);
  assert.equal((await app.message(cardDelete())).ok, true);
  assert.deepEqual(app.requests.map(r => r.method), [undefined, 'DELETE']);
  assert.ok(app.requests[1].url.endsWith('delete/doc-b/'));
  assert.equal(app.data.readerDocuments[B], undefined); assert.equal(app.data.readerSavedUrls[B], undefined);
  assert.equal(app.data.readerDocuments[A].id, 'doc-a'); assert.equal(app.data.readerSavedUrls[A], 1);
});

test('recycled card or navigation during deletion preflight cancels DELETE, including document-scoped challenges', async () => {
  for (const change of ['card', 'page']) {
    const app = harness({ stored: cardStored, responder: () => {
      if (change === 'card') app.context.chrome.tabs.sendMessage = (id, message, options, cb) => cb({ ...message, ok: false });
      else app.setTab({ id: 1, url: B });
      return { results: [cardDoc()] };
    } });
    const result = await app.message(cardDelete(), { id: 'extension', frameId: 0, url: A, documentId: 'document-1', tab: { id: 1 } });
    assert.equal(result.code, 'invalid_sender'); assert.equal(app.requests.length, 1);
    assert.equal(app.challenges[0].options.documentId, 'document-1');
  }
});

test('card source mismatch, changed notes, offline, 429, absent and uncertain delete outcomes stay explicit without retries', async () => {
  for (const [reply, expected] of [[{ results: [doc('doc-b', A)] }, 'document_changed'],
    [{ results: [{ ...cardDoc(), notes: 'Changed elsewhere' }] }, 'delete_conflict'],
    [{ status: 401 }, 'unauthorized'], [{ status: 429 }, 'rate_limited'], [new Error('offline'), 'network_error']]) {
    const app = harness({ stored: cardStored, responder: () => reply });
    assert.equal((await app.message(cardDelete())).code, expected); assert.equal(app.requests.length, 1);
    assert.equal(app.data.readerSavedUrls[B], 1);
  }
  const uncertain = harness({ stored: cardStored, responder: (url, init) => init.method === 'DELETE' ? new Error('offline') : { results: [cardDoc()] } });
  assert.equal((await uncertain.message(cardDelete())).code, 'delete_uncertain'); assert.equal(uncertain.requests.length, 2);
  assert.equal(uncertain.data.readerSavedUrls[B], 1);
  const absent = harness({ stored: cardStored, responder: () => ({ results: [] }) });
  assert.equal((await absent.message(cardDelete())).alreadyDeleted, true); assert.equal(absent.requests.length, 1);
  assert.equal(absent.data.readerSavedUrls[B], undefined);
});

test('document projection excludes highlights and foreign videos and uses safe Reader links', () => {
  assert.equal(C.cleanDocument(doc('x', B), A), null);
  assert.equal(C.cleanDocument({ ...doc(), parent_id: 'parent' }, A), null);
  assert.equal(C.cleanDocument(doc('../escape'), A), null);
  assert.equal(C.cleanDocument({ ...doc(), is_deleted: true }, A), null);
  const projected = C.cleanDocument({ ...doc(), url: 'javascript:alert(1)', html_content: '<script>x</script>' }, A);
  assert.equal(projected.url, 'https://read.readwise.io/read/doc-a');
  assert.equal(projected.html_content, undefined);
  assert.deepEqual(projected.tags, ['Science']);
});

test('save retains document id for canonical aliases and legacy timestamp cache is left intact', async () => {
  const app = harness({ stored: { readerSavedUrls: { [A]: 123 } }, responder: () => ({ status: 201, id: 'doc-a', url: 'https://read.readwise.io/read/doc-a' }) });
  const result = await app.message({ type: 'save-to-reader', pageUrl: 'https://m.youtube.com/watch?v=alpha&t=2', title: 'Title', author: 'Author' });
  assert.equal(result.ok, true);
  assert.equal(app.data.readerDocuments[A].id, 'doc-a');
  assert.equal(app.data.readerSavedUrls[A], 123);
  assert.equal(app.requests[0].method, 'POST');
  assert.equal(JSON.parse(app.requests[0].body).saved_using, 'minimal-video-speed');
});

test('known ids use a single exact GET and return existing summary, tags and note', async () => {
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } } } });
  const result = await app.get('https://youtu.be/alpha');
  assert.equal(result.document.summary, 'Summary from Reader');
  assert.equal(result.document.notes, 'Original');
  assert.equal(app.requests.length, 1);
  const r = app.requests[0];
  assert.equal(r.url, 'https://readwise.io/api/v3/list/?id=doc-a');
  assert.equal(r.headers.Authorization, 'Token fixture-token');
  assert.equal(r.credentials, 'omit');
  assert.equal(r.redirect, 'error');
  assert.ok(r.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(result).includes('fixture-token'));
});

test('external and old-cache saves resolve by exact source_url with one bounded page per action', async () => {
  const app = harness({ stored: { readerSavedUrls: { [A]: 12 } }, responder: url =>
    url.includes('pageCursor=') ? { results: [doc()], nextPageCursor: null } : { results: [doc('b', B)], nextPageCursor: 'next&cursor' } });
  const first = await app.get();
  assert.equal(first.document, null);
  assert.equal(first.nextCursor, 'next&cursor');
  assert.equal(app.requests.length, 1);
  assert.equal((await app.get(A, first.nextCursor)).document.id, 'doc-a');
  assert.equal(app.requests.length, 2);
  assert.equal(new URL(app.requests[1].url).searchParams.get('pageCursor'), 'next&cursor');
  assert.equal(app.data.readerDocuments[B].id, 'b');
  assert.ok(app.requests.every(r => !r.method));
});

test('deleted and mismatched ids are forgotten before bounded rediscovery', async () => {
  for (const response of [{ results: [] }, { status: 404 }, { results: [doc('old', B)] }]) {
    const app = harness({ stored: { readerDocuments: { [A]: { id: 'old', at: 1 } } },
      responder: url => url.includes('?id=') ? response : { results: [] } });
    const result = await app.get();
    assert.equal(result.document, null);
    assert.equal(app.data.readerDocuments[A], undefined);
    assert.equal(app.requests.length, 2);
  }
});

test('duplicate matches are reported rather than silently selecting a note', async () => {
  const app = harness({ responder: () => ({ results: [doc(), doc('duplicate')] }) });
  assert.equal((await app.get()).code, 'ambiguous');
  assert.equal(app.data.readerDocuments?.[A], undefined);
});

test('refresh clears flags for verified missing ids and deleted list records never enter the index', async () => {
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1 } },
    responder: url => url.includes('?id=') ? { results: [] } : { results: [{ ...doc(), is_deleted: true }] } });
  assert.equal((await app.get()).document, null);
  assert.equal(app.data.readerSavedUrls[A], undefined); assert.equal(app.data.readerDocuments[A], undefined);
});

test('simultaneous lookups coalesce and concurrent identity writes are preserved', async () => {
  let release;
  const app = harness({ responder: async () => { await new Promise(r => { release = r; }); return { results: [doc()] }; } });
  const first = app.get(); const second = app.get();
  await new Promise(setImmediate);
  assert.equal(app.requests.length, 1);
  release();
  assert.deepEqual(await first, await second);
  await Promise.all([app.service.remember(A, 'a'), app.service.remember(B, 'b')]);
  assert.equal(app.data.readerDocuments[A].id, 'a');
  assert.equal(app.data.readerDocuments[B].id, 'b');
});

test('save re-reads captured id and writes only notes, including explicit clearing', async () => {
  for (const notes of ['Edited', '']) {
    const app = harness();
    assert.equal((await app.note({ notes })).ok, true);
    assert.equal(app.requests.length, 2);
    assert.ok(app.requests[0].url.endsWith('list/?id=doc-a'));
    assert.ok(app.requests[1].url.endsWith('update/doc-a/'));
    assert.equal(app.requests[1].method, 'PATCH');
    assert.deepEqual(JSON.parse(app.requests[1].body), { notes });
  }
});

test('note conflicts, deleted docs, wrong source and invalid requests never PATCH', async () => {
  const conflict = harness({ responder: () => ({ results: [doc('doc-a', A, 'Changed elsewhere')] }) });
  assert.equal((await conflict.note()).code, 'conflict');
  assert.equal(conflict.requests.length, 1);
  for (const results of [[], [doc('doc-a', B)], [{ ...doc(), parent_id: 'highlight' }]]) {
    const app = harness({ responder: () => ({ results }) });
    assert.equal((await app.note()).code, 'not_found');
    assert.equal(app.requests.length, 1);
  }
  const invalid = harness();
  for (const values of [{ id: '../escape' }, { pageUrl: 'https://evil.test' }, { notes: null }, { baseNotes: null }]) {
    assert.equal((await invalid.note(values)).code, 'invalid_request');
  }
  assert.equal(invalid.requests.length, 0);
});

test('same note needs no PATCH and concurrent saves detect the changed baseline', async () => {
  let notes = 'Original';
  const app = harness({ responder: (url, init) => {
    if (init.method === 'PATCH') { notes = JSON.parse(init.body).notes; return {}; }
    return { results: [doc('doc-a', A, notes)] };
  } });
  assert.equal((await app.note({ notes: 'Original' })).ok, true);
  const [first, second] = await Promise.all([app.note(), app.note({ notes: 'Other draft' })]);
  assert.equal(first.ok, true);
  assert.equal(second.code, 'conflict');
  assert.equal(app.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('401, missing token, offline and uncertain update failures are explicit and redact errors', async () => {
  assert.equal((await harness({ stored: { readerToken: '' } }).get()).code, 'missing_token');
  assert.equal((await harness({ responder: () => ({ status: 401 }) }).get()).code, 'unauthorized');
  const offline = harness({ responder: () => new Error('secret-token-in-error') });
  const result = await offline.get();
  assert.equal(result.code, 'network_error');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
  const uncertain = harness({ responder: (url, init) => init.method === 'PATCH' ? new Error('offline') : { results: [doc()] } });
  assert.equal((await uncertain.note()).code, 'save_uncertain');
});

test('429 persists a Retry-After cooldown across service restarts and never auto-retries', async () => {
  const app = harness({ responder: () => ({ status: 429, retryAfter: '120' }) });
  const result = await app.get();
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.retryAt, 220000);
  assert.equal((await app.get()).code, 'rate_limited');
  assert.equal(app.requests.length, 1);
  const restarted = harness({ stored: app.data });
  assert.equal((await restarted.get()).code, 'rate_limited');
  assert.equal(restarted.requests.length, 0);
  app.advance(120001);
  await app.get();
  assert.equal(app.requests.length, 2);
});

test('local list budget caps repeated explicit reads before the public API limit', async () => {
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } } } });
  for (let i = 0; i < 18; i++) assert.equal((await app.get()).ok, true);
  assert.equal((await app.get()).code, 'rate_limited');
  assert.equal(app.requests.length, 18);
  app.advance(60001);
  assert.equal((await app.get()).ok, true);
});

test('credentials changed between conflict check and write prevent the write', async () => {
  const app = harness({ responder: (url, init, stored) => { stored.readerToken = 'different-account'; return { results: [doc()] }; } });
  assert.equal((await app.note()).code, 'auth_changed');
  assert.equal(app.requests.length, 1);
});

test('background validates extension, top frame, sender host and video identity', async () => {
  const app = harness();
  const valid = { id: 'extension', frameId: 0, url: A, tab: { id: 1 } };
  for (const sender of [{ ...valid, id: 'other' }, { ...valid, frameId: 1 }, { ...valid, documentLifecycle: 'cached' },
    { ...valid, url: 'https://evil.test' }, { ...valid, url: 'http://www.youtube.com/watch?v=alpha' },
    { ...valid, url: 'https://user@www.youtube.com/watch?v=alpha' }, { ...valid, tab: null }]) {
    assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: A }, sender)).code, 'invalid_sender');
  }
  assert.equal(app.requests.length, 0);
  assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: A }, valid)).ok, true);
});

test('background accepts a current SPA video when the content script sender still names its original video', async () => {
  const app = harness({ tabUrl: B, responder: () => ({ results: [doc('doc-b', B)] }) });
  const result = await app.message({ type: 'reader-panel-get', pageUrl: B },
    { id: 'extension', frameId: 0, url: A, tab: { id: 1, url: A } });
  assert.equal(result.ok, true); assert.equal(result.document.id, 'doc-b');
});

test('Home-to-video contexts are trusted by origin; current tabs.get data outranks stale sender snapshots', async () => {
  const app = harness({ tabUrl: B, responder: () => ({ results: [doc('doc-b', B)] }) });
  const sender = { id: 'extension', frameId: 0, url: 'https://www.youtube.com/', tab: { id: 1, url: A } };
  assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: B + '&t=20' }, sender)).document.id, 'doc-b');
  for (const current of [{ id: 1, url: A }, { id: 1, url: 'https://evil.test/watch?v=beta' },
    { id: 1, url: 'https://m.youtube.com/watch?v=beta' }, { id: 1, url: B, pendingUrl: A }, { id: 2, url: B }, undefined]) {
    app.setTab(current);
    const count = app.requests.length;
    assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: B }, sender)).code, 'invalid_sender');
    assert.equal(app.requests.length, count);
  }
  app.context.chrome.tabs.get = (id, callback) => {
    app.context.chrome.runtime.lastError = { message: 'Closed tab' }; callback(); app.context.chrome.runtime.lastError = null;
  };
  assert.equal((await app.message({ type: 'reader-panel-get', pageUrl: B }, sender)).code, 'invalid_sender');
});

test('stale save and delete messages are rejected against the live tab before any Reader request', async () => {
  const app = harness({ tabUrl: B });
  for (const message of [{ type: 'reader-panel-save-note', pageUrl: A, id: 'doc-a', baseNotes: 'Original', notes: 'Do not write' },
    { type: 'reader-panel-delete', pageUrl: A, id: 'doc-a', confirmed: true, baseNotes: 'Original', title: 'A Reader video', updatedAt: '' }]) {
    assert.equal((await app.message(message)).code, 'invalid_sender');
  }
  assert.equal(app.requests.length, 0);
});

test('navigation during mutation preflight stops PATCH/DELETE without retrying or changing the target', async () => {
  for (const type of ['reader-panel-save-note', 'reader-panel-delete']) {
    const app = harness({ responder: () => { app.setTab({ id: 1, url: B }); return { results: [doc()] }; } });
    const result = await app.message({ type, pageUrl: A, id: 'doc-a', baseNotes: 'Original', notes: 'Keep draft',
      confirmed: true, title: 'A Reader video', updatedAt: '' });
    assert.equal(result.code, 'invalid_sender'); assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].method, undefined);
  }
});

test('queued stale visits never fetch Reader and read coalescing is scoped by tab and visit', async () => {
  let release;
  const app = harness({ responder: async () => {
    if (!release) await new Promise(resolve => { release = resolve; });
    return { results: [doc()] };
  } });
  let current = true;
  const first = app.service.handle({ type: 'reader-panel-get', pageUrl: A, visit: 1 }, { scope: 1 });
  await new Promise(setImmediate);
  const stale = app.service.handle({ type: 'reader-panel-get', pageUrl: B, visit: 2 }, { scope: 1, isCurrent: () => current });
  const otherTab = app.service.handle({ type: 'reader-panel-get', pageUrl: A, visit: 1 }, { scope: 2 });
  const newVisit = app.service.handle({ type: 'reader-panel-get', pageUrl: A, visit: 3 }, { scope: 1 });
  current = false; release();
  assert.equal((await first).ok, true); assert.equal((await stale).code, 'invalid_sender');
  assert.equal((await otherTab).ok, true); assert.equal((await newVisit).ok, true);
  assert.equal(app.requests.length, 3);
});

test('draft refresh preserves edits, detects conflict and keeps newer edits after pending save', () => {
  const state = C.draft();
  const original = C.cleanDocument(doc(), A);
  C.receive(state, original);
  C.edit(state, 'Unsaved');
  C.receive(state, { ...original, summary: 'New summary' });
  assert.equal(state.value, 'Unsaved');
  assert.equal(state.conflict, null);
  C.receive(state, { ...original, notes: 'External edit' });
  assert.equal(state.value, 'Unsaved');
  assert.equal(state.conflict.notes, 'External edit');
  C.edit(state, 'Typed during save'); C.saved(state, 'Unsaved');
  assert.equal(state.base, 'Unsaved');
  assert.equal(state.value, 'Typed during save');
  assert.equal(state.dirty, true);
  C.edit(state, 'Unsaved');
  assert.equal(state.dirty, false);
});

test('replacement document cannot silently inherit the deleted document baseline', () => {
  const state = C.draft();
  C.receive(state, C.cleanDocument(doc(), A)); C.edit(state, 'Keep me');
  C.receive(state, C.cleanDocument(doc('replacement'), A));
  assert.equal(state.conflict.id, 'replacement');
  assert.equal(state.value, 'Keep me');
});


test('late deletion lookup cannot erase an id retained by a newer save', async () => {
  let release;
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'old', at: 1 } } },
    responder: async url => {
      if (url.includes('?id=old')) await new Promise(resolve => { release = resolve; });
      return { results: [] };
    } });
  const loading = app.get();
  await new Promise(setImmediate);
  await app.service.remember(A, 'newly-saved');
  release(); await loading;
  assert.equal(app.data.readerDocuments[A].id, 'newly-saved');
});

test('confirmed deletion verifies exact source then DELETEs only the captured id and clears matching flags', async () => {
  const alias = 'https://youtu.be/alpha?t=12';
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 }, [B]: { id: 'doc-b', at: 1 } },
    readerSavedUrls: { [A]: 1, [alias]: 2, [B]: 3, 'https://read.readwise.io/new/read/doc-a': 4 } },
    responder: (url, init) => init.method === 'DELETE' ? { status: 204 } : { results: [doc()] } });
  const result = await app.delete();
  assert.equal(result.ok, true); assert.equal(result.alreadyDeleted, false); assert.equal(result.id, 'doc-a');
  assert.deepEqual(app.requests.map(r => [r.url, r.method]), [
    ['https://readwise.io/api/v3/list/?id=doc-a', undefined], ['https://readwise.io/api/v3/delete/doc-a/', 'DELETE']]);
  assert.equal(app.requests[1].body, undefined);
  assert.equal(app.data.readerDocuments[A], undefined); assert.equal(app.data.readerDocuments[B].id, 'doc-b');
  assert.deepEqual({ ...app.data.readerSavedUrls }, { [B]: 3 });
});

test('delete rejects missing confirmation, invalid identity and untrusted senders before API use', async () => {
  const app = harness();
  for (const values of [{ confirmed: false }, { confirmed: undefined }, { id: '../escape' }, { pageUrl: B + '/bad' },
    { pageUrl: 'https://evil.test' }, { title: null }, { updatedAt: null }, { baseNotes: null }]) {
    assert.equal((await app.delete(values)).code, 'invalid_delete');
  }
  assert.equal((await app.message({ type: 'reader-panel-delete', pageUrl: A },
    { id: 'extension', frameId: 0, url: 'https://evil.test', tab: { id: 1 } })).code, 'invalid_sender');
  assert.equal(app.requests.length, 0);
});

test('changed source, highlights, replacement mapping or changed document stop deletion', async () => {
  for (const changed of [doc('doc-a', B), { ...doc(), parent_id: 'parent' }]) {
    const app = harness({ responder: () => ({ results: [changed] }) });
    assert.equal((await app.delete()).code, 'document_changed');
    assert.equal(app.requests.length, 1);
  }
  for (const changed of [{ notes: 'New Reader note' }, { title: 'Renamed' }, { updated_at: 'later' }]) {
    const app = harness({ responder: () => ({ results: [{ ...doc(), ...changed }] }) });
    const result = await app.delete();
    assert.equal(result.code, 'delete_conflict'); assert.equal(result.document.id, 'doc-a');
    assert.equal(app.requests.length, 1);
  }
  const replacement = harness({ stored: { readerDocuments: { [A]: { id: 'new', at: 1 } } } });
  assert.equal((await replacement.delete()).code, 'document_changed'); assert.equal(replacement.requests.length, 0);
});

test('already missing/deleted and DELETE 404 clear stale identity without claiming a new deletion', async () => {
  for (const response of [{ results: [] }, { status: 404 }, { results: [{ ...doc(), is_deleted: true }] }, null]) {
    const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1 } },
      responder: (url, init) => init.method === 'DELETE' ? { status: 404 } : response || { results: [doc()] } });
    const result = await app.delete();
    assert.equal(result.ok, true); assert.equal(result.alreadyDeleted, true);
    assert.equal(app.data.readerDocuments[A], undefined); assert.equal(app.data.readerSavedUrls[A], undefined);
    assert.equal(app.requests.length, response ? 1 : 2);
  }
});

test('delete authentication, rate limits, network and unexpected success responses never report success or clear flags', async () => {
  for (const [response, expected] of [[{ status: 401 }, 'unauthorized'], [{ status: 403 }, 'unauthorized'],
    [{ status: 429, retryAfter: '120' }, 'rate_limited'], [new Error('secret error'), 'delete_uncertain'],
    [{ status: 500 }, 'delete_uncertain'], [{ status: 200 }, 'delete_uncertain']]) {
    const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1 } },
      responder: (url, init) => init.method === 'DELETE' ? response : { results: [doc()] } });
    const result = await app.delete();
    assert.equal(result.ok, false); assert.equal(result.code, expected);
    assert.equal(app.requests.length, 2); assert.equal(app.data.readerDocuments[A].id, 'doc-a');
    assert.equal(app.data.readerSavedUrls[A], 1); assert.ok(!JSON.stringify(result).includes('secret'));
    if (expected === 'rate_limited') {
      assert.equal((await app.delete()).code, 'rate_limited'); assert.equal(app.requests.length, 2);
    }
  }
  const missing = harness({ stored: { readerToken: '' } });
  assert.equal((await missing.delete()).code, 'missing_token'); assert.equal(missing.requests.length, 0);
});

test('delete preflight rechecks credentials and a replacement saved during GET', async () => {
  const auth = harness({ responder: (url, init, data) => { data.readerToken = 'another-account'; return { results: [doc()] }; } });
  assert.equal((await auth.delete()).code, 'auth_changed'); assert.equal(auth.requests.length, 1);
  let release;
  const app = harness({ responder: async () => { await new Promise(r => { release = r; }); return { results: [doc()] }; } });
  const deleting = app.delete(); await new Promise(setImmediate);
  await app.service.remember(A, 'replacement'); release();
  assert.equal((await deleting).code, 'document_changed'); assert.equal(app.requests.length, 1);
});

test('a newer save during DELETE keeps its mapping and timestamp flags', async () => {
  let release;
  const app = harness({ stored: { readerDocuments: { [A]: { id: 'doc-a', at: 1 } }, readerSavedUrls: { [A]: 1 } },
    responder: async (url, init) => {
      if (init.method !== 'DELETE') return { results: [doc()] };
      await new Promise(r => { release = r; }); return { status: 204 };
    } });
  const deleting = app.delete(); await new Promise(setImmediate);
  await app.service.remember(A, 'replacement', () => { app.data.readerSavedUrls = { [A]: 200 }; });
  release(); assert.equal((await deleting).ok, true);
  assert.equal(app.data.readerDocuments[A].id, 'replacement'); assert.equal(app.data.readerSavedUrls[A], 200);
});

test('delete budgets survive restart and local cache errors do not become a false success', async () => {
  const limited = harness({ stored: { readerPanelBudget: { delete: Array(18).fill(100000) } } });
  assert.equal((await limited.delete()).code, 'rate_limited'); assert.equal(limited.requests.length, 1);
  const app = harness({ responder: (url, init) => {
    if (init.method === 'DELETE') { app.context.chrome.storage.local.set = (data, cb) => {
      app.context.chrome.runtime.lastError = { message: 'storage unavailable' }; cb?.();
      app.context.chrome.runtime.lastError = null;
    }; return { status: 204 }; }
    return { results: [doc()] };
  } });
  assert.equal((await app.delete()).code, 'delete_cache_error');
  assert.equal(app.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('deletion clears clean notes, preserves dirty and newer drafts, and cannot clear a replacement', () => {
  for (const value of [null, 'Unsaved before deletion', 'Typed while pending', '']) {
    const state = C.draft(); C.receive(state, C.cleanDocument(doc(), A));
    if (value !== null) C.edit(state, value);
    assert.equal(C.removed(state, 'doc-b'), false); assert.equal(state.doc.id, 'doc-a');
    assert.equal(C.removed(state, 'doc-a'), true); assert.equal(state.doc, null);
    assert.equal(state.value, value === null ? '' : value); assert.equal(state.dirty, value !== null);
    if (value !== null) {
      C.receive(state, C.cleanDocument(doc('replacement'), A));
      assert.equal(state.conflict.id, 'replacement'); assert.equal(state.value, value);
    }
  }
});
