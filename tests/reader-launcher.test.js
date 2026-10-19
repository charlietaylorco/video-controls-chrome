const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture({ saved = {}, deferred = false, pathname = '/', hostname = 'www.youtube.com' } = {}) {
  const readKeys = [], messages = [], nodes = [], timers = new Map(), events = new Map(), docEvents = new Map(), storageEvents = new Set(), observers = [], themeEvents = new Set();
  let sequence = 0, readCallback;
  const element = tag => {
    const node = { tag, children: [], attributes: {}, parentElement: null, events: new Map(),
      get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected || this.host?.isConnected); },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, fn) { this.events.set(type, fn); },
      attachShadow(options) { this.shadowMode = options.mode; const root = element('shadow'); root.host = this; return root; },
    }; nodes.push(node); return node;
  };
  const document = { createElement: element, createElementNS: (_, tag) => element(tag),
    getElementById: id => nodes.find(node => node.id === id && node.isConnected) || null,
    addEventListener(type, fn) { docEvents.set(type, fn); }, removeEventListener(type) { docEvents.delete(type); } };
  document.documentElement = element('html'); const body = element('body'), header = element('masthead'), native = element('native-button');
  const legacy = element('button'); legacy.id = 'mvs-recent-saves-header'; const legacyStyle = element('style'); legacyStyle.id = 'mvs-recent-saves-header-style';
  document.documentElement.append(body, legacyStyle); body.append(header); header.append(native, legacy);
  const media = { matches: false, addEventListener(type, fn) { themeEvents.add(fn); }, removeEventListener(type, fn) { themeEvents.delete(fn); } };
  const location = { hostname, pathname };
  const window = { location, matchMedia: () => media,
    MutationObserver: class { constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); } observe(target, options) { this.targets.push({ target, options }); } disconnect() { this.targets = []; } },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); } };
  const chrome = { runtime: { sendMessage(message, cb) { messages.push(message); cb(); } }, storage: {
    local: { get(defaults, cb) { readKeys.push(...Object.keys(defaults)); const result = { ...defaults, ...saved }; if (deferred) readCallback = () => cb(result); else cb(result); } },
    onChanged: { addListener(fn) { storageEvents.add(fn); }, removeListener(fn) { storageEvents.delete(fn); } },
  } };
  const context = vm.createContext({ document, window, chrome, location });
  const source = fs.readFileSync(path.join(__dirname, '..', 'reader-launcher.js'), 'utf8'); vm.runInContext(source, context);
  const flush = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { context, source, nodes, messages, readKeys, document, body, header, native, legacy, legacyStyle, events, docEvents, observers, timers, storageEvents, media, location, flush,
    get host() { return nodes.find(node => node.id === 'mvs-recent-saves-launcher'); },
    get button() { return nodes.find(node => node.tag === 'shadow')?.children.find(node => node.tag === 'button'); },
    change(patch, area = 'local') { storageEvents.forEach(fn => fn(Object.fromEntries(Object.entries(patch).map(([key,newValue]) => [key,{newValue}])), area)); },
    fullscreen(value, webkit = false) { document[webkit ? 'webkitFullscreenElement' : 'fullscreenElement'] = value; docEvents.get(webkit ? 'webkitfullscreenchange' : 'fullscreenchange')(); },
    mutate() { observers.forEach(observer => { if (observer.targets.length) observer.callback(); }); flush(); },
    systemTheme(value) { media.matches = value; themeEvents.forEach(fn => fn()); },
    resolveRead() { readCallback?.(); },
    navigate(path = '/') { location.pathname = path; events.get('yt-navigate-finish')?.(); flush(); },
  };
}

test('floating launcher defaults bottom-left in a closed isolated root, cleans legacy header UI and opens the existing route', () => {
  const f = fixture(); assert.equal(f.host.parentElement, f.document.documentElement); assert.equal(f.host.shadowMode,'closed');
  assert.equal(f.host.attributes['data-position'],'bottom-left'); assert.equal(f.host.attributes['data-theme'],'light');
  assert.deepEqual(f.header.children,[f.native]); assert.equal(f.legacy.isConnected,false); assert.equal(f.legacyStyle.isConnected,false);
  assert.equal(f.button.attributes['aria-label'],'Recent saves'); assert.equal(f.button.title,'Recent saves'); assert.equal(f.button.type,'button');
  f.button.events.get('click')({preventDefault(){},stopPropagation(){}}); assert.equal(f.messages.length,1); assert.equal(f.messages[0].type,'open-watch-list');
  for (const type of ['keydown','keyup','keypress']) { let stopped = false; f.button.events.get(type)({stopPropagation(){stopped=true;}}); assert.equal(stopped,true); }
});

test('all four positions, live disable/re-enable, invalid/deleted settings and restart defaults are independent of Reader panel settings', () => {
  const f = fixture({ saved: { showReaderPanel:true } }); assert.equal(f.host.attributes['data-panel'],'true');
  for (const position of ['top-left','top-right','bottom-left','bottom-right']) {
    f.change({recentSavesLauncherPosition:position}); assert.equal(f.host.attributes['data-position'],position); assert.equal(f.host.isConnected,true);
    assert.equal(fixture({saved:{recentSavesLauncherPosition:position}}).host.attributes['data-position'],position);
  }
  f.change({showRecentSavesLauncher:false}); assert.equal(f.host.isConnected,false); f.mutate(); assert.equal(f.host.isConnected,false);
  f.change({showRecentSavesLauncher:true}); assert.equal(f.host.isConnected,true);
  f.change({recentSavesLauncherPosition:'invalid'}); assert.equal(f.host.attributes['data-position'],'bottom-left');
  f.change({showRecentSavesLauncher:undefined}); assert.equal(f.host.isConnected,true);
  assert.equal(fixture({saved:{showRecentSavesLauncher:false}}).host.isConnected,false);
  assert.equal(f.messages.length,0);
});

test('fullscreen removes the floating control without changing preference and exit restores the same host', () => {
  const f = fixture(), host = f.host;
  f.fullscreen({}); assert.equal(host.isConnected,false); f.navigate(); f.mutate(); assert.equal(host.isConnected,false);
  f.fullscreen(null); assert.equal(host.isConnected,true); assert.equal(f.host,host);
  f.fullscreen({},true); assert.equal(host.isConnected,false); f.fullscreen(null,true); assert.equal(host.isConnected,true);
  f.change({showRecentSavesLauncher:false}); f.fullscreen({}); f.fullscreen(null); assert.equal(host.isConnected,false);
});

test('SPA/removal/root remount/repeated injection never duplicates or integrates with native header; observers avoid feed subtrees', () => {
  const f = fixture(), host = f.host; f.navigate(); f.navigate(); f.host.remove(); f.mutate(); assert.equal(host.isConnected,true);
  const previousRoot = f.document.documentElement;
  f.document.documentElement = f.document.createElement('html'); f.mutate(); assert.equal(host.parentElement,f.document.documentElement); assert.equal(previousRoot.children.includes(host),false);
  vm.runInContext(f.source,f.context); assert.equal(f.nodes.filter(n=>n.id==='mvs-recent-saves-launcher').length,1);
  assert.ok(f.observers[0].targets.every(row=>!row.options.subtree));
  f.observers[0].callback(); assert.equal(f.timers.size,0);
  f.navigate('/embed/video'); assert.equal(host.isConnected,false); f.navigate('/results'); assert.equal(host.isConnected,true);
});

test('themes update without reading credentials; a late initial settings read cannot undo a live opt-out', () => {
  const f = fixture(); f.systemTheme(true); assert.equal(f.host.attributes['data-theme'],'dark'); assert.ok(!f.readKeys.includes('readerToken'));
  f.change({readerPanelTheme:'system'}); assert.equal(f.host.attributes['data-theme'],'dark');
  f.change({readerPanelTheme:'light'}); assert.equal(f.host.attributes['data-theme'],'light');
  f.change({readerPanelTheme:'dark'}); assert.equal(f.host.attributes['data-theme'],'dark');
  const delayed = fixture({deferred:true}); assert.equal(delayed.host.isConnected,false);
  delayed.change({showRecentSavesLauncher:false,recentSavesLauncherPosition:'top-left'}); delayed.resolveRead(); assert.equal(delayed.host.isConnected,false);
  delayed.change({showRecentSavesLauncher:true}); assert.equal(delayed.host.attributes['data-position'],'top-left');
  const controller = f.context.__mvsRecentLauncher; controller.destroy(); assert.equal(f.host.isConnected,false); assert.equal(f.storageEvents.size,0); assert.equal(f.events.size,0); assert.equal(f.docEvents.size,0);
  for (const observer of f.observers) assert.equal(observer.targets.length,0);
  f.change({showRecentSavesLauncher:true}); assert.equal(f.host.isConnected,false);
  const cancelled = fixture({deferred:true}); cancelled.context.__mvsRecentLauncher.destroy(); cancelled.resolveRead(); assert.equal(cancelled.host.isConnected,false);
});

test('standalone embed and music pages do not auto-mount the Recent saves shortcut', () => {
  assert.equal(fixture({pathname:'/embed/video'}).host,undefined);
  assert.equal(fixture({hostname:'music.youtube.com'}).host,undefined);
});


test('direct watch/live routes keep only Recent saves hidden and browsing SPA navigation reuses the same host', () => {
  for (const pathname of ['/watch','/watch/','/live','/live/','/live/video']) {
    const f = fixture({pathname,saved:{showReaderPanel:true,recentSavesLauncherPosition:'top-right'}}), host=f.host;
    const panel=f.document.createElement('reader-panel');f.document.documentElement.append(panel);
    assert.equal(host.isConnected,false);assert.ok(f.context.__mvsRecentLauncher);f.mutate();assert.equal(host.isConnected,false);
    for (const route of ['/','/results','/feed/subscriptions','/@channel','/watching','/live_chat']) {
      f.navigate(route);assert.equal(host.isConnected,true);assert.equal(host.attributes['data-position'],'top-right');assert.equal(panel.isConnected,true);
      f.location.pathname=pathname;f.events.get('yt-navigate-finish')();assert.equal(host.isConnected,false);assert.equal(panel.isConnected,true);
    }
    f.navigate('/');vm.runInContext(f.source,f.context);assert.equal(f.nodes.filter(n=>n.id==='mvs-recent-saves-launcher').length,1);assert.equal(f.messages.length,0);assert.equal(f.timers.size,0);
  }
});

test('watch/live visibility never overrides saved opt-out, corner or fullscreen and adds no polling', () => {
  const f=fixture({pathname:'/watch',saved:{showRecentSavesLauncher:false,recentSavesLauncherPosition:'bottom-right'}});
  f.navigate('/');assert.equal(f.host.isConnected,false);
  f.navigate('/live/video');f.change({showRecentSavesLauncher:true,recentSavesLauncherPosition:'top-left'});assert.equal(f.host.isConnected,false);
  f.navigate('/feed/subscriptions');assert.equal(f.host.isConnected,true);assert.equal(f.host.attributes['data-position'],'top-left');
  f.fullscreen({});f.navigate('/watch');f.navigate('/results');assert.equal(f.host.isConnected,false);
  f.fullscreen(null);assert.equal(f.host.isConnected,true);assert.equal(f.host.attributes['data-position'],'top-left');assert.equal(f.timers.size,0);
});
