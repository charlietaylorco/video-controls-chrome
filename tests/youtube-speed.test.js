const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
function helper(name) {
  const start = source.indexOf(`  const ${name} =`);
  const end = source.indexOf('\n  const ', start + 1);
  return source.slice(start, end);
}

function fixture() {
  const listeners = new Map();
  class Element {
    closest() { return this.editable ? this : null; }
    contains(node) { return node === this || node === video; }
  }
  class HTMLVideoElement extends Element {
    playbackRate = 1; isConnected = true;
    getClientRects() { return this.hidden ? [] : [{}]; }
  }
  const video = new HTMLVideoElement();
  const player = new Element(); player.querySelector = () => video;
  const document = { activeElement: null, fullscreenElement: null,
    getElementById: () => player, addEventListener(type, fn) { listeners.set(type, fn); } };
  const window = { location: new URL('https://www.youtube.com/watch?v=alpha'),
    addEventListener(type, fn, capture) { listeners.set(type, fn); if (type === 'keydown') assert.equal(capture, true); } };
  window.top = window;
  const context = { window, document, Element, HTMLVideoElement, URL, Set, DOMException,
    RATE_PRECISION: 2, previewVideo: null, activeVideo: video, isApplyingRate: false,
    videoState: new WeakMap(), updateUi() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'youtube-speed-keys.js'), 'utf8'), context);
  vm.runInNewContext([
    ...['roundRate', 'clampRate', 'getState', 'getBaseRate', 'setPlaybackRate', 'applyRate', 'isHandledBrowserDomException'].map(helper),
    source.match(/  window.MVSYouTubeSpeedKeys\?\.setStepHandler\([\s\S]*?\n  \}\);/)[0],
    'globalThis.state = getState;'
  ].join('\n'), context);
  return { video, player, window, document, context,
    fire(type = 'keydown', overrides = {}) {
      const event = { key: '>', code: 'Period', keyCode: 190, shiftKey: true,
        composedPath: () => [video], preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...overrides };
      listeners.get(type)?.(event); return event;
    } };
}

test('real rate helpers cross 2x in both directions and repeat in quarter steps to existing bounds', () => {
  const f = fixture(); f.video.playbackRate = 1.75;
  for (const expected of [2, 2.25, 2.5, 2.75, 3]) {
    assert.equal(f.fire('keydown', { repeat: true }).stopped, true);
    assert.equal(f.video.playbackRate, expected);
  }
  for (const expected of [2.75, 2.5, 2.25, 2, 1.75]) {
    f.fire('keydown', { key: '<', code: 'Comma' }); assert.equal(f.video.playbackRate, expected);
  }
  for (let i = 0; i < 100; i++) f.fire();
  assert.equal(f.video.playbackRate, 16); assert.equal(f.fire().stopped, true);
  for (let i = 0; i < 100; i++) f.fire('keydown', { key: '<' });
  assert.equal(f.video.playbackRate, 0.01); assert.equal(f.video.defaultPlaybackRate, 0.01);
});

test('keyboard uses saved hover rate, live menu rate and existing clamp/rounding without overlay settings', () => {
  const f = fixture(); f.context.previewVideo = f.video; f.context.state(f.video).baseRate = 3;
  f.video.playbackRate = 1; f.fire(); assert.equal(f.video.playbackRate, 3.25);
  f.context.previewVideo = null; f.video.playbackRate = 1.33;
  f.fire(); assert.equal(f.video.playbackRate, 1.58);
  assert.equal(f.context.state(f.video).baseRate, 1.58);
});

test('a browser-rejected rate retains the saved rate and still suppresses native fallback', () => {
  const f = fixture();
  Object.defineProperty(f.video, 'playbackRate', { get: () => .0625,
    set() { throw new DOMException('Rate is unsupported', 'NotSupportedError'); } });
  assert.equal(f.fire('keydown', {key:'<'}).stopped, true);
  assert.equal(f.context.state(f.video).baseRate, .0625);
});

test('punctuation variants work while unrelated keys/modifiers/composition stay untouched', () => {
  const f = fixture();
  for (const event of [{key:'.'}, {key:'>',code:''}, {key:'Unidentified'}, {key:'',code:'',keyCode:190}]) {
    assert.equal(f.fire('keydown', event).stopped, true);
  }
  for (const event of [{key:','}, {key:'<',code:''}, {key:'Unidentified',code:'Comma'}, {key:'',code:'',keyCode:188}]) {
    assert.equal(f.fire('keydown', event).stopped, true);
  }
  for (const event of [{shiftKey:false}, {ctrlKey:true}, {metaKey:true}, {altKey:true},
    {getModifierState: () => true}, {isComposing:true}, {keyCode:229}, {defaultPrevented:true},
    {key:'k'}, {key:'/'}, {key:':'}, {key:'。'}, {key:'Dead'}]) {
    const before = f.video.playbackRate;
    assert.equal(f.fire('keydown', event).stopped, undefined, JSON.stringify(event));
    assert.equal(f.video.playbackRate, before);
  }
});

test('editable composed targets, active fields, design mode and related key sequences are safe', () => {
  const f = fixture(), field = new f.video.constructor(); field.editable = true;
  assert.equal(f.fire('keydown', {composedPath: () => [field]}).stopped, undefined);
  f.document.activeElement = field; assert.equal(f.fire().stopped, undefined);
  f.document.activeElement = null; f.document.designMode = 'on'; assert.equal(f.fire().stopped, undefined);
  f.document.designMode = 'off';
  assert.equal(f.fire('keyup').stopped, undefined, 'unowned keyup passes');
  f.fire(); assert.equal(f.fire('keypress').stopped, true);
  assert.equal(f.fire('keyup', {key:'.',shiftKey:false}).stopped, true);
  assert.equal(f.fire('keyup').stopped, undefined);
  f.fire(); f.fire('blur'); assert.equal(f.fire('keyup').stopped, undefined);
});

test('route checks and player lookup are fresh and fail closed during navigation/no video/fullscreen elsewhere', () => {
  const f = fixture();
  for (const url of ['https://example.com/watch?v=a', 'https://music.youtube.com/watch?v=a',
    'https://www.youtube.com/', 'https://www.youtube.com/shorts/a', 'https://www.youtube.com/live/a',
    'https://www.youtube.com/embed/a', 'https://www.youtube.com/watch']) {
    f.window.location = new URL(url); assert.equal(f.fire().stopped, undefined, url);
  }
  f.window.location = new URL('https://www.youtube.com/watch?v=beta');
  f.fire('yt-navigate-start'); assert.equal(f.fire().stopped, undefined);
  f.fire('yt-page-data-updated'); assert.equal(f.fire().stopped, undefined);
  f.fire('yt-navigate-finish'); assert.equal(f.fire().stopped, true);
  f.video.isConnected = false; assert.equal(f.fire().stopped, undefined);
  f.video.isConnected = true; f.video.hidden = true; assert.equal(f.fire().stopped, undefined);
  f.video.hidden = false; f.document.getElementById = () => null; assert.equal(f.fire().stopped, undefined);
  f.document.getElementById = () => f.player;
  f.document.fullscreenElement = {contains: () => false}; assert.equal(f.fire().stopped, undefined);
  f.document.fullscreenElement = f.player; assert.equal(f.fire().stopped, true);
});

test('early registration is limited to top-level YouTube and overlay settings/handlers are preserved', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const script = manifest.content_scripts.find(s => s.js.includes('youtube-speed-keys.js'));
  assert.equal(script.run_at, 'document_start'); assert.ok(!script.all_frames);
  assert.deepEqual(script.matches, ['https://www.youtube.com/*','https://youtube.com/*','https://m.youtube.com/*']);
  assert.match(source, /applyRate\(activeVideo, getBaseRate\(activeVideo\) - settings.adjustmentStep\)/);
  assert.match(source, /applyRate\(activeVideo, getBaseRate\(activeVideo\) \+ settings.adjustmentStep\)/);
  let registered = 0;
  const bootstrap = fs.readFileSync(path.join(root, 'youtube-speed-keys.js'), 'utf8');
  const window = { addEventListener() { registered++; } }; window.top = window;
  const context = {window, document:{addEventListener() {}}};
  vm.runInNewContext(bootstrap, context); const first = registered;
  vm.runInNewContext(bootstrap, context); assert.equal(registered, first);
  const iframe = {top:window, addEventListener() { assert.fail('iframe must not register'); }};
  vm.runInNewContext(bootstrap, {window:iframe}); assert.equal(iframe.MVSYouTubeSpeedKeys, undefined);
});
