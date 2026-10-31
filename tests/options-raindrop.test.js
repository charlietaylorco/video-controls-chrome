const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const flush = () => new Promise(setImmediate);
function settings({ stored = {}, responses = {}, fetcher } = {}) {
  const nodes = new Map(), requests = [], statuses = [], writes = [];
  const runtime = {};
  let failStorage = false;
  function element() {
    return { value: '', textContent: '', disabled: false, children: [], listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); },
      fire(type, extra = {}) { return this.listeners[type]({ preventDefault() {}, ...extra }); }
    };
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const context = { document, AbortSignal, showStatus: value => statuses.push(value), chrome: { runtime,
    storage: { local: {
      get(defaults, cb) { cb({ ...defaults, ...stored }); },
      set(values, cb) {
        writes.push(values);
        if (failStorage) runtime.lastError = { message: 'failed' };
        else Object.assign(stored, JSON.parse(JSON.stringify(values)));
        cb(); delete runtime.lastError;
      }
    } } },
    async fetch(url, init) {
      requests.push({ url, ...init });
      if (fetcher) return fetcher(url, init);
      const data = responses[url.split('/rest/v1/')[1]] || { result: true, items: [] };
      return { ok: true, json: async () => data };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../options-raindrop.js'), 'utf8'), context);
  return { stored, requests, statuses, writes, node: id => document.getElementById('raindrop-' + id),
    refresh: () => document.getElementById('refresh-raindrop-collections').fire('click'),
    saveToken: () => document.getElementById('save-raindrop-token').fire('click'),
    failStorage: () => { failStorage = true; } };
}

test('Raindrop settings start with no tags and Unsorted without requesting collections until the token is saved', async () => {
  const app = settings();
  await flush();
  assert.equal(app.node('tags').value, '');
  assert.equal(app.node('collection').value, '-1');
  assert.equal(app.requests.length, 0);
  app.node('token').value = ' new-token ';
  app.node('token').fire('keydown', { key: 'Enter' });
  await flush();
  assert.equal(app.stored.raindropToken, 'new-token');
  assert.equal(app.requests.length, 2);
  assert.ok(app.requests.every(request => request.headers.Authorization === 'Bearer new-token' && request.redirect === 'error'));
});

test('Raindrop settings restore and save tags and nested collection choices, including clearing both', async () => {
  const app = settings({ stored: { raindropToken: 'token', raindropTags: ['video'], raindropCollectionId: 20 }, responses: {
    collections: { result: true, items: [{ _id: 10, title: 'Learning' }] },
    'collections/childrens': { result: true, items: [{ _id: 20, title: 'Videos', parent: { $id: 10 } }] }
  } });
  await flush();
  assert.equal(app.node('tags').value, 'video');
  assert.equal(app.node('collection').value, '20');
  assert.equal(app.node('collection').children[2].textContent, 'Learning / Videos');
  assert.equal(app.writes.length, 0);
  app.node('tags').value = ' video, watch later, ,video ';
  app.node('tags').fire('change');
  assert.deepEqual(app.stored.raindropTags, ['video', 'watch later']);
  app.node('collection').value = '10'; app.node('collection').fire('change');
  assert.equal(app.stored.raindropCollectionId, 10);
  app.node('tags').value = ''; app.node('tags').fire('change');
  app.node('collection').value = '-1'; app.node('collection').fire('change');
  assert.deepEqual(app.stored.raindropTags, []);
  assert.equal(app.stored.raindropCollectionId, -1);
});

test('Raindrop keeps the saved collection on unauthorized, malformed and failed collection loads', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: true, json: async () => ({ result: false }) }),
    async () => { throw Error('offline'); }
  ]) {
    const app = settings({ stored: { raindropToken: 'token', raindropCollectionId: 123 }, fetcher });
    await flush();
    assert.equal(app.node('collection').value, '123');
    assert.equal(app.stored.raindropCollectionId, 123);
    assert.match(app.node('settings-status').textContent, /Could not load collections/);
    assert.equal(app.writes.length, 0);
    app.refresh(); await flush();
    assert.equal(app.requests.length, 4);
  }
});

test('Raindrop keeps an unavailable saved collection selectable and reports it', async () => {
  const app = settings({ stored: { raindropToken: 'token', raindropCollectionId: 123 } });
  await flush();
  assert.equal(app.node('collection').value, '123');
  assert.match(app.node('settings-status').textContent, /saved collection is unavailable/);
  assert.equal(app.writes.length, 0);
});

test('Raindrop settings revert edits and report a storage failure', async () => {
  const app = settings({ stored: { raindropTags: ['video'], raindropCollectionId: 123 } });
  await flush(); app.failStorage();
  app.node('tags').value = 'other'; app.node('tags').fire('change');
  app.node('collection').value = '-1'; app.node('collection').fire('change');
  app.node('token').value = 'other-token'; app.saveToken(); await flush();
  assert.equal(app.node('tags').value, 'video');
  assert.equal(app.node('collection').value, '123');
  assert.deepEqual(app.statuses, ['Could not save Raindrop tags', 'Could not save Raindrop collection', 'Could not save Raindrop token']);
  assert.equal(app.requests.length, 0);
});

test('A stale collection response cannot replace choices fetched with a newly saved token', async () => {
  const pending = [];
  const app = settings({ stored: { raindropToken: 'old' }, fetcher: () => new Promise(resolve => pending.push(resolve)) });
  app.node('token').value = 'new'; app.saveToken();
  const response = title => ({ ok: true, json: async () => ({ result: true, items: [{ _id: 10, title }] }) });
  pending[2](response('New account')); pending[3](response('New account')); await flush();
  pending[0](response('Old account')); pending[1](response('Old account')); await flush();
  assert.equal(app.node('collection').children[1].textContent, 'New account');
});
