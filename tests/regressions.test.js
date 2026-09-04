const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadBackgroundHelpers(overrides = {}) {
  const listeners = [];
  const context = {
    URL,
    AbortSignal,
    ...overrides,
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        onMessage: { addListener: (listener) => listeners.push(listener) },
      },
      storage: { local: { get(defaults, callback) { callback({ ...defaults, readerToken: "test-token" }); } } },
      tabs: {},
    },
  };
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInNewContext(
    `${source}\nglobalThis.__helpers = { isYouTubeVideoPageUrl, normalizeTargetUrl, isPreferredVideoPageUrl, fetchHtml };`,
    context
  );
  return { ...context.__helpers, onMessage: listeners[0] };
}

function loadDownieButtonState() {
  const source = fs.readFileSync(path.join(root, 'feed.js'), 'utf8');
  const match = source.match(
    /function setDownieButtonState[\s\S]*?\n}\n\nasync function parseReadwiseError/
  );
  assert.ok(match, 'setDownieButtonState should remain available');

  const context = {};
  const functionSource = match[0].replace(/\n\nasync function parseReadwiseError$/, '');
  vm.runInNewContext(`${functionSource}\nglobalThis.__setState = setDownieButtonState;`, context);
  return context.__setState;
}

function loadMergeVisibleListOrder() {
  const source = fs.readFileSync(path.join(root, 'feed.js'), 'utf8');
  const match = source.match(
    /function mergeVisibleListOrder[\s\S]*?\n}\n\nfunction renderLists/
  );
  assert.ok(match, 'mergeVisibleListOrder should remain available');

  const context = {};
  const functionSource = match[0].replace(/\n\nfunction renderLists$/, '');
  vm.runInNewContext(`${functionSource}\nglobalThis.__mergeOrder = mergeVisibleListOrder;`, context);
  return context.__mergeOrder;
}

function fakeButton() {
  return {
    dataset: {},
    disabled: false,
    setAttribute(name, value) {
      this[name] = value;
    },
  };
}

test('YouTube video validation rejects watch and route shells without an id', () => {
  const { isYouTubeVideoPageUrl } = loadBackgroundHelpers();

  assert.equal(isYouTubeVideoPageUrl('https://www.youtube.com/watch'), false);
  assert.equal(isYouTubeVideoPageUrl('https://www.youtube.com/watch?list=WL'), false);
  assert.equal(isYouTubeVideoPageUrl('https://www.youtube.com/shorts/'), false);
  assert.equal(isYouTubeVideoPageUrl('https://www.youtube.com/watch?v=abc123'), true);
  assert.equal(isYouTubeVideoPageUrl('https://www.youtube.com/shorts/abc123'), true);
});

test('YouTube watch URLs still canonicalize to their stable video URL', () => {
  const { normalizeTargetUrl } = loadBackgroundHelpers();

  assert.equal(
    normalizeTargetUrl('https://m.youtube.com/watch?v=abc123&list=WL#details'),
    'https://m.youtube.com/watch?v=abc123'
  );
});

test('Downie button is re-enabled and keeps accurate labels after sending', () => {
  const setState = loadDownieButtonState();
  const button = fakeButton();

  setState(button, 'sending');
  assert.equal(button.disabled, true);
  assert.equal(button['aria-label'], 'Sending to Downie');

  setState(button, 'saved');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.state, 'saved');
  assert.equal(button['aria-label'], 'Sent to Downie');

  setState(button, 'error');
  assert.equal(button.disabled, false);
  assert.equal(button['aria-label'], 'Try sending to Downie again');
});

test('reordering filtered lists preserves every list hidden by the search', () => {
  const mergeOrder = loadMergeVisibleListOrder();
  const previous = ['all', 'list-a', 'reader-saved', 'list-b', 'list-c', 'downie-sent'];

  assert.deepEqual(
    Array.from(mergeOrder(previous, ['list-c', 'list-a'])),
    ['all', 'list-c', 'reader-saved', 'list-b', 'list-a', 'downie-sent']
  );
});

function loadFeedHelpers(names, globals = {}) {
  const source = fs.readFileSync(path.join(root, 'feed.js'), 'utf8');
  const functions = names.map((name) => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `${name} should remain available`);
    return match[0];
  }).join('\n');
  const context = { URL, AbortSignal, ...globals };
  vm.runInNewContext(`${functions}\nglobalThis.helpers = { ${names.join(', ')} };`, context);
  return context.helpers;
}

test('YouTube routes reject foreign hosts, credentials, plaintext and custom ports', () => {
  const { isYouTubeVideoPageUrl } = loadBackgroundHelpers();
  for (const value of [
    'https://attacker.example/shorts/abc', 'https://localhost/live/abc',
    'https://www.youtube.com.attacker.example/live/abc',
    'https://www.youtube.com@attacker.example/shorts/abc',
    'https://user:secret@www.youtube.com/watch?v=abc',
    'http://www.youtube.com/watch?v=abc', 'https://www.youtube.com:8443/watch?v=abc',
    'javascript:alert(1)', 'https://', null, {},
  ]) assert.equal(isYouTubeVideoPageUrl(value), false, String(value));
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']) {
    for (const route of ['/watch?v=abc', '/shorts/abc', '/live/abc', '/embed/abc']) {
      assert.equal(isYouTubeVideoPageUrl(`https://${host}${route}`), true);
    }
  }
});

test('imported channel URLs cannot navigate or fetch outside YouTube', () => {
  const { toAbsoluteUrl, buildChannelUrl, sanitizeImportedLists } = loadFeedHelpers([
    'toAbsoluteUrl', 'buildChannelUrl', 'sanitizeImportedLists',
  ]);
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//evil.example/x',
    'https://user@www.youtube.com/x', 'https://www.youtube.com:444/x', 'http://www.youtube.com/x']) {
    assert.equal(toAbsoluteUrl(value), '');
  }
  assert.equal(toAbsoluteUrl('/@example'), 'https://www.youtube.com/@example');
  assert.equal(buildChannelUrl({ id: '@example' }), 'https://www.youtube.com/@example');
  assert.equal(buildChannelUrl({ id: 'UCtest?x=1#frag', url: 'javascript:alert(1)' }),
    'https://www.youtube.com/channel/UCtest%3Fx%3D1%23frag');
  const lists = sanitizeImportedLists([{ id: 'one', name: 'One', channels: [null, {}, 42,
    { id: '@example', url: 'https://evil.example', name: {}, avatarUrl: 'javascript:alert(1)' }] }]);
  assert.equal(lists[0].channels.length, 1);
  assert.equal(lists[0].channels[0].url, '');
  assert.equal(lists[0].channels[0].name, '@example');
  assert.equal(lists[0].channels[0].avatarUrl, '');
});

test('channel worker pool caps active requests and preserves result order', async () => {
  const { mapConcurrent } = loadFeedHelpers(['mapConcurrent']);
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 25 }, (_, index) => index);
  const result = await mapConcurrent(values, 4, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(Array.from(result), values.map((value) => value * 2));
  assert.equal((await mapConcurrent([], 4, () => assert.fail())).length, 0);
});

test('duration lookups share in-flight work and encode untrusted IDs', async () => {
  const requests = [];
  const release = [];
  const pending = new Map();
  const { ensureDuration } = loadFeedHelpers([
    'fetchDurationFromWatch', 'processDurationQueue', 'ensureDuration',
  ], {
    durationPending: pending, durationCache: new Map(), durationQueue: [],
    durationActive: 0, DURATION_CONCURRENCY: 4, scheduleDurationCachePersist() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      await new Promise((resolve) => release.push(resolve));
      return { ok: true, text: async () => '"lengthSeconds":"120"' };
    },
  });
  const first = ensureDuration('abc&other=1');
  const second = ensureDuration('abc&other=1');
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get('v'), 'abc&other=1');
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  release[0]();
  assert.equal(await first, 120);
  assert.equal(await ensureDuration('abc&other=1'), 120);
  assert.equal(requests.length, 1);
  assert.equal(pending.size, 0);
});

test('failed duration lookups release worker slots', async () => {
  let requests = 0;
  const { ensureDuration } = loadFeedHelpers([
    'fetchDurationFromWatch', 'processDurationQueue', 'ensureDuration',
  ], {
    durationPending: new Map(), durationCache: new Map(), durationQueue: [],
    durationActive: 0, DURATION_CONCURRENCY: 4, scheduleDurationCachePersist() {},
    fetch: async () => { requests++; throw new Error('timed out'); },
  });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ensureDuration(`id${i}`)));
  assert.equal(requests, 10);
  assert.ok(results.every((value) => value === null));
});

test('closing a channel panel detaches its outside click listener', () => {
  const source = fs.readFileSync(path.join(root, 'yt-lists-content.js'), 'utf8');
  const match = source.match(/function removePanel\([^]*?^}/m);
  const handler = () => {};
  let removed = 0;
  const context = {
    panelOutsideHandler: handler, PANEL_ID: 'panel',
    document: {
      removeEventListener(type, listener, capture) {
        assert.equal(type, 'click');
        assert.equal(listener, handler);
        assert.equal(capture, true);
        removed++;
      },
      getElementById() { return { remove() {} }; },
    },
  };
  vm.runInNewContext(`${match[0]}\nremovePanel(); removePanel();`, context);
  assert.equal(removed, 1);
  assert.equal(context.panelOutsideHandler, null);
});


test('Reader message rejects unrelated shorts without making network requests', async () => {
  const { onMessage, isPreferredVideoPageUrl } = loadBackgroundHelpers({
    fetch: () => assert.fail('Invalid video must not reach the network'),
  });
  assert.equal(isPreferredVideoPageUrl('https://evil.example/shorts/abc'), false);
  const response = await new Promise((resolve) => {
    onMessage({ type: 'save-to-reader', pageUrl: 'https://evil.example/shorts/abc' }, {}, resolve);
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'invalid_url');
});

test('metadata requests enforce a deadline and disallow redirects', async () => {
  const { fetchHtml } = loadBackgroundHelpers({
    fetch: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, 'error');
      return { ok: true, text: async () => '<html></html>' };
    },
  });
  assert.equal(await fetchHtml('https://www.youtube.com/watch?v=abc'), '<html></html>');
});
