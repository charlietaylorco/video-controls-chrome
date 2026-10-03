const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function background({ token = 'test-token', status = 200, result = true, fail = false } = {}) {
  let listener;
  const requests = [];
  const stored = {};
  const context = {
    URL, AbortSignal, importScripts() {},
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: { getURL: value => value, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { get(defaults, callback) { callback({ ...defaults, ...stored, raindropToken: token }); }, set(values, callback) { Object.assign(stored, values); callback(); } } },
    },
    async fetch(url, init) {
      requests.push({ url, ...init });
      if (fail) throw new Error('offline');
      return { ok: status === 200, status, async json() { return { result }; } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  return { requests, state: pageUrl => new Promise(resolve => listener({ type: 'get-raindrop-save-state', pageUrl }, {}, resolve)), save: pageUrl => new Promise(resolve => listener({ type: 'save-to-raindrop', pageUrl }, {}, resolve)) };
}

test('Raindrop saves an embed as a watch link to Unsorted', async () => {
  const app = background();
  assert.equal((await app.save('https://www.youtube.com/embed/abc123?autoplay=1')).ok, true);
  const request = app.requests[0];
  assert.equal(request.url, 'https://api.raindrop.io/rest/v1/raindrop');
  assert.equal(request.headers.Authorization, 'Bearer test-token');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), {
    link: 'https://www.youtube.com/watch?v=abc123', collection: { $id: -1 }, pleaseParse: {},
  });
});

test('Raindrop rejects non-YouTube URLs without a request', async () => {
  const app = background();
  for (const url of ['https://x.com/a/status/1', 'https://youtube.com.evil.test/watch?v=abc', 'https://youtube.com/']) {
    assert.equal((await app.save(url)).code, 'invalid_url');
  }
  assert.equal(app.requests.length, 0);
});

test('Raindrop reports missing credentials, API failures, and network failures', async () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  assert.equal((await background({ token: '' }).save(url)).code, 'missing_token');
  assert.equal((await background({ status: 401 }).save(url)).code, 'unauthorized');
  assert.equal((await background({ status: 429 }).save(url)).ok, false);
  assert.equal((await background({ result: false }).save(url)).ok, false);
  assert.equal((await background({ fail: true }).save(url)).code, 'save_failed');
});

test('icon ordering moves existing buttons, ignores unknowns and keeps newly added actions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const start = source.indexOf('  const defaultIconOrder =');
  const end = source.indexOf('  let buttonStatusTimer', start);
  const actions = ['pip', 'download-x', 'downie', 'reader', 'raindrop'];
  const buttons = Object.fromEntries(actions.map(action => [action, { action }]));
  const children = actions.map(action => buttons[action]);
  const controls = { appendChild(button) { children.splice(children.indexOf(button), 1); children.push(button); } };
  const context = { shadowRoot: { querySelector(selector) {
    return selector === '.controls' ? controls : buttons[selector.match(/data-action="([^"]+)"/)[1]];
  } } };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.applyOrder = applyIconOrder;', context);
  context.applyOrder(['reader', 'reader', 'unknown', 'downie']);
  assert.deepEqual(children.map(button => button.action), ['reader', 'downie', 'pip', 'download-x', 'raindrop']);
  assert.equal(children[0], buttons.reader);
  context.applyOrder(null);
  assert.deepEqual(children.map(button => button.action), actions);
});


test('Raindrop saved state persists across equivalent URLs and leaves other videos unsaved', async () => {
  const app = background();
  const watch = 'https://www.youtube.com/watch?v=abc123';
  assert.equal((await app.state(watch)).saved, false);
  await app.save('https://www.youtube.com/embed/abc123?autoplay=1');
  assert.equal((await app.state(watch + '&t=10')).saved, true);
  assert.equal((await app.state('https://www.youtube.com/watch?v=other')).saved, false);
  const failed = background({ status: 401 });
  await failed.save(watch);
  assert.equal((await failed.state(watch)).saved, false);
});
