const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const own = 'chrome-extension://extension/watch.html';
function fixture({ tabs = [], fresh, defer = false } = {}) {
  let action, message, release;
  const created = [], activated = [], focused = [], queried = [];
  const chrome = { runtime: { id: 'extension', getURL: file => `chrome-extension://extension/${file}`, onMessage: { addListener(fn) { message = fn; } } },
    action: { onClicked: { addListener(fn) { action = fn; } } },
    tabs: {
      query(options, cb) { queried.push(options); if (defer) release = () => cb(tabs); else cb(tabs); },
      get(id, cb) { cb(fresh || tabs.find(tab => tab.id === id)); },
      update(id, patch, cb) { activated.push({ id, ...patch }); cb(tabs.find(tab => tab.id === id)); },
      create(options, cb) { created.push(options); cb?.({ id: 100, ...options }); },
    }, windows: { update(id, patch, cb) { focused.push({ id, ...patch }); cb(); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), { chrome, importScripts() {}, URL, AbortSignal });
  return { action, created, activated, focused, queried, release: () => release(), send: source => new Promise(resolve => message({ type: 'open-watch-list' }, { id: 'extension', tab: source }, resolve)) };
}
const tick = () => new Promise(setImmediate);
test('toolbar creates Recent saves in its own window, leaving YT Lists navigation available', async () => {
  const f = fixture(); f.action({ windowId: 4 }); await tick();
  assert.equal(f.created[0].url, own); assert.equal(f.created[0].windowId, 4); assert.equal(f.activated.length, 0);
  const html = fs.readFileSync(path.join(__dirname, '..', 'watch.html'), 'utf8');
  assert.match(html, /href="feed.html">YT Lists<\/a>/); assert.ok(!html.includes('href="options.html"')); assert.ok(!html.includes('id="theme"'));
});
test('toolbar focuses an exact existing Recent saves tab without reloading or touching unrelated tabs', async () => {
  const f = fixture({ tabs: [{ id: 1, url: 'https://www.youtube.com/watch?v=abc', windowId: 4 }, { id: 2, url: own, windowId: 5 }] });
  f.action({ windowId: 4 }); await tick(); assert.equal(f.created.length, 0); assert.deepEqual(f.activated, [{ id: 2, active: true }]); assert.deepEqual(f.focused, [{ id: 5, focused: true }]);
});
test('pending, lookalike, private-context and navigated-away tabs are never reused', async () => {
  for (const options of [
    { tabs: [{ id: 2, url: own, pendingUrl: 'https://example.com/' }] },
    { tabs: [{ id: 2, url: own + '?different' }, { id: 3, url: own.replace('extension/', 'other/') }] },
    { tabs: [{ id: 2, url: own, incognito: true }] },
    { tabs: [{ id: 2, url: own }], fresh: { id: 2, url: 'https://example.com/' } },
  ]) {
    const f = fixture(options); f.action({ windowId: 4 }); await tick(); assert.equal(f.created.length, 1); assert.equal(f.activated.length, 0);
  }
});
test('rapid toolbar activations and panel open messages share one in-flight open', async () => {
  const f = fixture({ defer: true }); f.action({ windowId: 4 }); f.action({ windowId: 4 }); const reply = f.send({ windowId: 4 });
  assert.equal(f.queried.length, 1); f.release(); assert.equal((await reply).ok, true); assert.equal(f.created.length, 1);
});
