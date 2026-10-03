const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const LIMIT = 'ytListsFeedRevealDailyLimit';
const USAGE = 'ytListsFeedRevealUsage';
const ENABLED = 'ytListsHideFeedVideos';

function harness(file, saved = {}, legacy = {}) {
  const data = { ...saved };
  const nodes = new Map();
  const classes = new Set();
  const listeners = [];
  const timers = new Map();
  let timerId = 0;
  function element(id) {
    return {
      id, value: '', checked: false, dataset: {}, events: {}, children: [],
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
      addEventListener(name, callback) { this.events[name] = callback; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(node) { this.children.push(node); if (node.id) nodes.set(node.id, node); },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      replaceChildren() { this.children = []; },
      remove() { nodes.delete(this.id); },
      querySelector(selector) { return this[selector] ||= element(); },
    };
  }
  const getInput = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  const steppers = [-1, 1].map((delta) => Object.assign(element(), { dataset: { feedRevealDelta: String(delta) } }));
  const documentElement = element();
  documentElement.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } };
  const storageArea = (values, local) => ({
    get(keys, callback) {
      callback(Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]])));
    },
    set(valuesToSet, callback) {
      const changes = Object.fromEntries(Object.entries(valuesToSet).map(([key, value]) => [key, { oldValue: values[key], newValue: value }]));
      Object.assign(values, valuesToSet);
      callback?.();
      if (local) listeners.forEach((listener) => listener(changes, 'local'));
    },
  });
  const context = {
    URL, Date, console, queueMicrotask,
    location: { pathname: '/', href: 'https://www.youtube.com/', origin: 'https://www.youtube.com' },
    MutationObserver: class { observe() {} },
    document: {
      documentElement, head: element(), body: element(),
      getElementById: file === 'options.js' ? getInput : (id) => nodes.get(id) || null,
      createElement: () => element(),
      querySelectorAll: (selector) => selector === '[data-feed-reveal-delta]' ? steppers : [],
    },
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: storageArea(data, true), sync: storageArea(legacy, false),
        onChanged: { addListener(listener) { listeners.push(listener); } },
      },
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    addEventListener() {},
  };
  context.window = context;
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'yt-lists-content.js') {
    // Avoid page/channel discovery; exercise focus behaviour with the actual storage listener.
    source = source.replace('\nprimeFeedFocusMode();', '\n').replace('\nrunAsync(init);', '\n');
    source += `\nglobalThis.focus = {
      refresh: refreshFeedRevealQuotaState, consume: consumeFeedRevealQuota,
      remaining: getFeedRevealRemaining, dayKey: getFeedRevealDayKey,
      apply: applyFeedFocusMode, start: startFeedRevealCountdown,
      enable() { hideFeedVideos = true; applyFeedFocusMode(); },
      reveal() { temporaryFeedReveal = true; applyFeedFocusMode(); },
      pending() { return feedRevealDeadline > 0; }
    };`;
  }
  vm.runInNewContext(source, context);
  return { context, data, legacy, nodes, classes, timers, steppers, input: getInput, focus: context.focus,
    change(values) { context.chrome.storage.local.set(values); } };
}

test('focus defaults to three unblocks and enforces a saved allowance above three', async () => {
  const app = harness('yt-lists-content.js');
  await app.focus.refresh();
  app.focus.enable();
  assert.equal(app.focus.remaining(), 3);
  app.change({ [LIMIT]: 5 });
  for (let count = 1; count <= 5; count++) {
    assert.equal(await app.focus.consume(), true);
    assert.equal(app.data[USAGE].count, count);
  }
  assert.equal(await app.focus.consume(), false);
  assert.equal(app.focus.remaining(), 0);
});

test('lowering and raising the allowance preserves actual usage', async () => {
  const app = harness('yt-lists-content.js', { [LIMIT]: 8 });
  await app.focus.refresh();
  app.focus.enable();
  for (let count = 0; count < 6; count++) await app.focus.consume();
  app.change({ [LIMIT]: 2 });
  assert.equal(app.focus.remaining(), 0);
  assert.equal(await app.focus.consume(), false);
  app.change({ [LIMIT]: 8 });
  assert.equal(app.focus.remaining(), 2);
  assert.equal(app.data[USAGE].count, 6);
});

test('zero disables reveals and cancels a pending countdown immediately', async () => {
  const app = harness('yt-lists-content.js');
  await app.focus.refresh();
  app.focus.enable();
  app.focus.start();
  assert.equal(app.focus.pending(), true);
  assert.ok([...app.timers.values()].some(({ delay }) => delay === 30000));
  app.change({ [LIMIT]: 0 });
  assert.equal(app.focus.pending(), false);
  assert.equal(await app.focus.consume(), false);
  assert.equal(app.nodes.get('yt-lists-feed-focus').querySelector('[data-action="reveal"]').disabled, true);
  assert.match(app.nodes.get('yt-lists-feed-focus').querySelector('.focus-status').textContent, /Unblocking is disabled/);
});

test('completing the delay reveals the feed once and rechecks the saved allowance', async () => {
  for (const allowed of [true, false]) {
    const app = harness('yt-lists-content.js');
    await app.focus.refresh();
    app.focus.enable();
    app.focus.start();
    const revealTimer = [...app.timers.values()].find(({ delay }) => delay === 30000);
    // Simulate a setting change not yet delivered to this tab's storage listener.
    if (!allowed) app.data[LIMIT] = 0;
    revealTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.classes.has('ytl-hide-feed-videos'), !allowed);
    assert.equal(app.data[USAGE]?.count || 0, allowed ? 1 : 0);
    assert.equal(app.focus.pending(), false);
  }
});

test('turning focus off cancels pending reveals, removes blocking, and preserves usage', async () => {
  const app = harness('yt-lists-content.js');
  await app.focus.refresh();
  app.focus.enable();
  await app.focus.consume();
  app.focus.start();
  app.change({ [ENABLED]: false });
  assert.equal(app.focus.pending(), false);
  assert.equal(app.classes.has('ytl-hide-feed-videos'), false);
  assert.equal(app.nodes.has('yt-lists-feed-focus'), false);
  assert.equal(await app.focus.consume(), false);
  app.change({ [ENABLED]: true });
  assert.equal(app.classes.has('ytl-hide-feed-videos'), true);
  assert.equal(app.focus.remaining(), 2);
  app.focus.reveal();
  app.change({ [ENABLED]: false });
  app.change({ [ENABLED]: true });
  assert.equal(app.classes.has('ytl-hide-feed-videos'), true);
});

test('the local reset boundary restores allowance and non-feed pages do not consume it', async () => {
  const app = harness('yt-lists-content.js', { [USAGE]: { dayKey: '2000-01-01', count: 9 }, [LIMIT]: 7 });
  await app.focus.refresh();
  assert.equal(app.focus.remaining(), 7);
  assert.equal(app.focus.dayKey(new Date(2026, 9, 3, 1, 59).getTime(), 120), '2026-10-02');
  assert.equal(app.focus.dayKey(new Date(2026, 9, 3, 2, 0).getTime(), 120), '2026-10-03');
  app.focus.enable();
  app.context.location.pathname = '/watch';
  assert.equal(await app.focus.consume(), false);
});

test('invalid saved allowances fall back to three; numeric values are bounded integers', async () => {
  for (const [value, expected] of [[null, 3], ['5', 3], [NaN, 3], [Infinity, 3], [-1, 0], [101, 100], [4.9, 4]]) {
    const app = harness('yt-lists-content.js', { [LIMIT]: value });
    await app.focus.refresh();
    assert.equal(app.focus.remaining(), expected);
  }
});

test('options persist and reflect the focus toggle and daily limit', () => {
  const app = harness('options.js', { [ENABLED]: true, [LIMIT]: 5 });
  const toggle = app.input('hide-feed-videos');
  const limit = app.input('feed-reveal-daily-limit');
  assert.equal(toggle.checked, true);
  assert.equal(limit.value, '5');
  toggle.checked = false;
  toggle.events.change();
  assert.equal(app.data[ENABLED], false);
  assert.equal(app.legacy[ENABLED], false);
  limit.value = '7';
  limit.events.change();
  assert.equal(app.data[LIMIT], 7);
  app.steppers[1].events.click();
  assert.equal(app.data[LIMIT], 8);
  app.change({ [ENABLED]: true, [LIMIT]: 0 });
  assert.equal(toggle.checked, true);
  assert.equal(limit.value, '0');
  app.steppers[0].events.click();
  assert.equal(app.data[LIMIT], 0);
  limit.value = '';
  limit.events.change();
  assert.equal(app.data[LIMIT], 3);
});

test('options retain legacy focus settings and defaults when nothing was saved locally', () => {
  const app = harness('options.js', {}, { [ENABLED]: true });
  assert.equal(app.input('hide-feed-videos').checked, true);
  assert.equal(app.input('feed-reveal-daily-limit').value, '3');
  const fresh = harness('options.js');
  assert.equal(fresh.input('hide-feed-videos').checked, false);
});
