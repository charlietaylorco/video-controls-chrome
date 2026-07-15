const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadBackgroundHelpers() {
  const listeners = [];
  const context = {
    URL,
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        onMessage: { addListener: (listener) => listeners.push(listener) },
      },
      storage: { local: {} },
      tabs: {},
    },
  };
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInNewContext(
    `${source}\nglobalThis.__helpers = { isYouTubeVideoPageUrl, normalizeTargetUrl };`,
    context
  );
  return context.__helpers;
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
