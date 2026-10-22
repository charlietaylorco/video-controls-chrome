// Real Watch page/search/toast controllers with a deterministic DOM/worker boundary.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = () => new Promise(setImmediate);
function fixture({ settings = {}, deferSettings = false } = {}) {
  let clock = 1000, sequence = 0, responder;
  const timers = new Map(), messages = [], listeners = new Map(), storageListeners = [], ids = new Map(), storageReads = [];
  let releaseSettings;
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false; this.value = ''; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
    get textContent() { return this.ownText + this.children.map(n => n.textContent).join(''); }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
    replaceChildren(...nodes) { for (const n of this.children) n.parentElement = null; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(key, fn) { this.listeners.set(key, [...this.listeners.get(key) || [], fn]); }
    removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) || []).filter(callback => callback !== fn)); }
    fire(type, extra = {}) { const event = { key: '', relatedTarget: null, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; for (const fn of this.listeners.get(type) || []) fn(event); return event; }
    click() { if (!this.disabled && !this.hidden) this.fire('click'); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    contains(node) { return node === this || this.children.some(n => n.contains(node)); }
    focus() { const previous = document.activeElement; document.activeElement = this; for (let n = previous; n; n = n.parentElement) n.fire('focusout', {relatedTarget:this}); for (let n = this; n; n = n.parentElement) n.fire('focusin', {relatedTarget:previous}); }
    getBoundingClientRect() { return { left: 60, top: 100, bottom: 132 }; }
    get scrollHeight() { return 154; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) { return this.children.flatMap(all).find(n => selector === '[aria-pressed="true"]' ? n.attrs['aria-pressed'] === 'true' : n.tagName === selector) || null; }
  }
  const all = node => [node, ...node.children.flatMap(all)];
  const document = { body: new Node('body'), documentElement: new Node('html'), activeElement: null, hidden: false,
    getElementById: id => ids.get(id), createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag),
    addEventListener(type, fn) { listeners.set(type, [...listeners.get(type) || [], fn]); } };
  document.activeElement = document.body;
  for (const id of ['videos','search','clear-search','channel-filter','tag-filter','search-status','filters','refresh','previous','next','page-label','empty','empty-title','empty-description','reset-view','deletion','delete-title','delete-identity','delete-status','cancel-delete','confirm-delete','announcements','toast','error-toast']) {
    const node = new Node(id === 'search' ? 'input' : ['clear-search','channel-filter','tag-filter','refresh','previous','next','reset-view','cancel-delete','confirm-delete'].includes(id) ? 'button' : 'div');
    ids.set(id, node); document.body.append(node);
  }
  for (const id of ['delete-title','delete-identity','delete-status','cancel-delete','confirm-delete']) {
    const child = ids.get(id); document.body.children = document.body.children.filter(node => node !== child); ids.get('deletion').append(child);
  }
  for (const id of ['toast', 'error-toast']) { const box = ids.get(id); box.hidden = true; box.append(new Node('p'), new Node('button')); }
  const defaultItems = Array.from({length: 2}, (_, i) => ({ videoUrl: `https://www.youtube.com/watch?v=item_${i}`, readerId: `doc-${i}`, title: i ? 'Focus and craft' : 'Design practice', author: i ? 'Maker Extra' : 'Maker', summary: 'Cached attention', status: 'saved', location: 'later', checkedAt: 1000, savedAt: 1000 - i }));
  const reply = message => message.type === 'watch-list-page' ? { ok: true, items: defaultItems, hasNext: false, nextCursor: null } : { ok: true };
  class ClockDate extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, URL, Date: ClockDate, console,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock + delay, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    chrome: { runtime: { lastError: null, sendMessage(message, cb) { messages.push(message); Promise.resolve(responder ? responder(message, reply) : reply(message)).then(cb); } }, storage: { local: { get(defaults, cb) {
      storageReads.push(Object.keys(defaults)); const reply = { ...defaults, ...Object.fromEntries(Object.entries(settings).filter(([key]) => key in defaults)) };
      if (deferSettings && 'showRaindrop' in defaults) releaseSettings = () => cb(reply); else cb(reply);
    } }, onChanged: { addListener(fn) { storageListeners.push(fn); } } } },
    window: { innerWidth: 1100, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
  });
  for (const file of ['reader-core.js','reader-watch-core.js','watch-feedback.js','watch-search.js','watch-thumbnail.js','watch-card-actions.js','watch-location-menu.js','watch.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), context);
  const flush = async () => { await tick(); await tick(); };
  const run = async delay => {
    clock += delay;
    for (const [id, timer] of [...timers].sort((a,b) => a[1].at - b[1].at)) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { ids, document, messages, defaultItems, context, timers, flush, run, storageReads, releaseSettings: () => releaseSettings(),
    set responder(fn) { responder = fn; },
    input(value) { ids.get('search').value = value; ids.get('search').fire('input'); },
    visibility(hidden) { document.hidden = hidden; (listeners.get('visibilitychange') || []).forEach(fn => fn()); },
    change(values) { storageListeners.forEach(fn => fn(values, 'local')); },
    activate(target, modifiers = {}) {
      const path = []; for (let n = target; n; n = n.parentElement) path.push(n);
      const event = { ...modifiers, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      if (path.some(n => n.disabled || n.hidden)) return event;
      for (const n of path) { Object.assign(event, n.fire('click', event)); if (event.stopped) break; }
      return event;
    },
    findClass(name) { return all(document.body).filter(n => (n.className || '').split(' ').includes(name)); },
  };
}

test('destination actions sit beside Open in Reader and isolate nested-icon clicks from video navigation', async () => {
  const f = fixture(); await f.flush();
  const card = f.findClass('video')[0], media = f.findClass('video-media')[0], link = f.findClass('thumbnail-link')[0], buttons = f.findClass('card-destination-action');
  assert.equal(buttons.length, 4);
  const destinations = f.findClass('destination-actions')[0], reader = f.findClass('reader-link')[0];
  assert.equal(buttons[0].parentElement.parentElement, destinations); assert.equal(reader.parentElement, destinations);
  const refresh = f.findClass('card-refresh')[0], footer = f.findClass('footer-actions')[0];
  assert.equal(destinations.children[0], refresh); assert.equal(destinations.children[1], reader);
  assert.deepEqual(destinations.children[2].children.map(button => button.dataset.action), ['raindrop', 'downie']);
  assert.equal(footer.children.length, 1); assert.equal(footer.children[0], f.findClass('card-trash')[0]);
  assert.equal(footer.children[0].title, 'Delete from Reader'); assert.match(footer.children[0].attrs['aria-label'], /Trash Design practice from Reader/);
  assert.equal(f.findClass('card-refresh').length, f.findClass('video').length);
  assert.ok(!media.contains(buttons[0]), 'thumbnail stays unobstructed'); assert.equal(media.children.length, 1);
  assert.equal(reader.href, 'https://read.readwise.io/read/doc-0');
  assert.ok(!link.contains(buttons[0])); assert.equal(link.href, f.defaultItems[0].videoUrl);
  const receipt = f.activate(buttons[0].children[0].children[0]); await f.flush();
  assert.equal(receipt.prevented, true); assert.equal(receipt.stopped, true);
  assert.equal(f.messages.at(-1).type, 'watch-card-action'); assert.equal(f.messages.at(-1).action, 'raindrop'); assert.equal(f.messages.at(-1).pageUrl, f.defaultItems[0].videoUrl);
  assert.equal(buttons[0].dataset.saved, 'true'); assert.match(buttons[0].attrs['aria-label'], /Saved in Raindrop: Design practice/);
  f.activate(buttons[1]); await f.flush();
  assert.equal(f.messages.at(-1).action, 'downie'); assert.equal(buttons[1].title, 'Sent to Downie');
  assert.equal(f.findClass('video')[0], card); assert.equal(link.href, f.defaultItems[0].videoUrl);
  assert.equal(f.ids.get('toast').querySelector('p').textContent, 'Sent to Downie.');
  assert.equal(f.messages.filter(m => m.type.startsWith('watch-list-')).length, 1, 'no Reader refresh/save caused by card actions');
});

test('destination actions reuse visibility settings and canonical saved flags, including live changes', async () => {
  const url = 'https://www.youtube.com/watch?v=item_0';
  const f = fixture({ settings: { showDownie: false, raindropSavedUrls: { [url + '&t=20']: 1 }, downieSentUrls: { [url]: 1 } } }); await f.flush();
  const [rain, downie] = f.findClass('card-destination-action');
  assert.equal(rain.title, 'Saved in Raindrop'); assert.equal(downie.hidden, true);
  f.activate(downie); await f.flush(); assert.equal(f.messages.length, 1);
  f.change({ showRaindrop: { newValue: false }, showDownie: { newValue: true } });
  assert.equal(rain.hidden, true); assert.equal(downie.hidden, false); assert.equal(downie.title, 'Sent to Downie');
  f.change({ downieSentUrls: { newValue: {} } }); assert.equal(downie.title, 'Send to Downie');
  assert.equal(downie.type, 'button'); assert.equal(downie.children[0].attrs.focusable, 'false');
});

test('late initial settings cannot override newer visibility changes; the page reads no credentials', async () => {
  const f = fixture({ deferSettings: true }); await f.flush();
  const [rain, downie] = f.findClass('card-destination-action'); assert.equal(rain.hidden, true); assert.equal(downie.hidden, true);
  f.change({ showRaindrop: { newValue: false } }); f.releaseSettings();
  assert.equal(rain.hidden, true); assert.equal(downie.hidden, false);
  assert.ok(!f.storageReads.flat().some(key => /token/i.test(key)));
});

test('pending destination actions suppress duplicate sends and stay bound to removed cards across search', async () => {
  const f = fixture(); await f.flush(); let release;
  f.responder = (message, normal) => message.type === 'watch-card-action' ? new Promise(resolve => { release = () => resolve({ ok: true }); })
    : message.type === 'watch-list-page' ? { ok: true, items: [f.defaultItems[1]], hasNext: false } : normal(message);
  const rain = f.findClass('card-destination-action')[0]; f.activate(rain); f.activate(rain);
  assert.equal(rain.disabled, true); assert.equal(f.messages.filter(m => m.type === 'watch-card-action').length, 1);
  f.input('craft'); await f.run(180); const current = f.findClass('card-destination-action')[0];
  release(); await f.flush(); assert.equal(current.dataset.saved, 'false');
  const count = f.messages.length; rain.click(); await f.flush(); assert.equal(f.messages.length, count);
  assert.equal(f.messages.find(m => m.type === 'watch-card-action').pageUrl, f.defaultItems[0].videoUrl);
});

test('settled destination actions recover focus lost while disabled without stealing another control’s focus', async () => {
  for (const movedFocus of [false, true]) {
    const f = fixture(); await f.flush(); let release;
    f.responder = (message, normal) => message.type === 'watch-card-action' ? new Promise(resolve => { release = () => resolve({ ok: true }); }) : normal(message);
    const button = f.findClass('card-destination-action')[0]; button.focus(); f.activate(button);
    f.document.activeElement = f.document.body; // Native buttons may lose focus when disabled.
    if (movedFocus) f.ids.get('search').focus();
    release(); await f.flush(); assert.equal(f.document.activeElement, movedFocus ? f.ids.get('search') : button);
  }
});

test('destination action styling follows loading, transient success/error and retained saved/sent states', async () => {
  for (const action of ['raindrop', 'downie']) {
    const f = fixture(); await f.flush(); let release;
    f.responder = (message, normal) => message.type === 'watch-card-action' ? new Promise(resolve => { release = resolve; }) : normal(message);
    const button = f.findClass('card-destination-action').find(n => n.dataset.action === action);
    f.activate(button); assert.equal(button.dataset.status, 'loading'); assert.equal(button.disabled, true);
    release({ ok: true }); await f.flush(); assert.equal(button.dataset.status, 'success'); assert.equal(button.dataset.saved, 'true');
    await f.run(1400); assert.equal(button.dataset.status, ''); assert.equal(button.dataset.saved, 'true');
    f.activate(button); release({ ok: false, code: action === 'raindrop' ? 'unauthorized' : 'launch_failed' }); await f.flush();
    assert.equal(button.dataset.status, 'error'); assert.equal(button.dataset.saved, 'true', 'an error must not erase a prior saved/sent flag');
    await f.run(1400); assert.equal(button.dataset.status, ''); assert.equal(button.dataset.saved, 'true');
  }
});

test('action-specific missing-token, rejected-token, launch and uncertain feedback leave Reader/card state unchanged', async () => {
  for (const [action, code, expected] of [['raindrop', 'missing_token', /Add your Raindrop token/], ['raindrop', 'unauthorized', /Check your Raindrop token/],
    ['downie', 'launch_failed', /Check that Downie is installed/], ['downie', 'request_uncertain', /Check Downie before/]]) {
    const f = fixture(); await f.flush(); const card = f.findClass('video')[0];
    f.responder = (message, normal) => message.type === 'watch-card-action' ? { ok: false, code } : normal(message);
    const button = f.findClass('card-destination-action').find(n => n.dataset.action === action); f.activate(button); await f.flush();
    assert.match(f.ids.get('error-toast').querySelector('p').textContent, expected); assert.equal(button.dataset.saved, 'false'); assert.equal(button.disabled, false);
    assert.equal(f.findClass('video')[0], card); assert.equal(f.messages.length, 2);
  }
});

test('typing invalidates old replies before debounce; newer query/filter/paging responses always win', async () => {
  const f = fixture(); await f.flush(); const replies = [];
  f.responder = (message, normal) => message.type === 'watch-list-page' ? new Promise(resolve => replies.push({ message, resolve })) : normal(message);
  f.input('first'); await f.run(180); assert.equal(replies.length, 1);
  f.input('second'); replies[0].resolve({ ok: true, items: [{...f.defaultItems[0], title: 'Stale first'}], hasNext: false }); await f.flush();
  assert.ok(!f.findClass('video').some(n => n.textContent.includes('Stale first')));
  await f.run(180); assert.equal(replies[1].message.query, 'second');
  replies[1].resolve({ ok: true, items: [{...f.defaultItems[0], title: 'Newest second'}], hasNext: true, nextCursor: [1, f.defaultItems[0].videoUrl] }); await f.flush();
  assert.ok(f.findClass('video')[0].textContent.includes('Newest second'));
  f.ids.get('next').click(); await f.flush(); assert.equal(replies[2].message.query, 'second'); assert.ok(replies[2].message.cursor);
  f.ids.get('filters').children.find(n => n.dataset.filter === 'archive').click(); await f.flush();
  assert.equal(replies[3].message.filter, 'archive'); assert.equal(replies[3].message.cursor, null);
  replies[3].resolve({ ok: true, items: [], hasNext: false }); await f.flush();
  replies[2].resolve({ ok: true, items: f.defaultItems, hasNext: false }); await f.flush();
  assert.equal(f.ids.get('empty').hidden, false); assert.equal(f.ids.get('empty-title').textContent, 'No matching videos');
  assert.equal(f.ids.get('videos').hidden, true);
});

test('channel buttons apply exact separate criteria; location/query changes preserve it and clear/reset restore page one', async () => {
  const f = fixture(); await f.flush();
  f.findClass('channel-filter-button')[0].click(); await f.flush();
  assert.equal(f.messages.at(-1).channel, 'Maker'); assert.equal(f.ids.get('channel-filter').hidden, false); assert.equal(f.document.activeElement, f.ids.get('channel-filter'));
  assert.match(f.ids.get('channel-filter').attrs['aria-label'], /exact channel filter: Maker/);
  f.input('attention'); await f.run(180); assert.equal(f.messages.at(-1).query, 'attention'); assert.equal(f.messages.at(-1).channel, 'Maker');
  f.ids.get('filters').children.find(n => n.dataset.filter === 'later').click(); await f.flush();
  assert.equal(f.messages.at(-1).filter, 'later'); assert.equal(f.messages.at(-1).channel, 'Maker');
  f.ids.get('channel-filter').click(); await f.flush(); assert.equal(f.messages.at(-1).channel, ''); assert.equal(f.messages.at(-1).query, 'attention');
  f.ids.get('clear-search').click(); await f.flush(); assert.equal(f.messages.at(-1).query, ''); assert.equal(f.messages.at(-1).filter, 'later'); assert.equal(f.document.activeElement, f.ids.get('search'));
  f.input('no match'); await f.run(180); f.ids.get('reset-view').click(); await f.flush();
  assert.equal(f.messages.at(-1).filter, 'all'); assert.equal(f.messages.at(-1).query, ''); assert.equal(f.messages.at(-1).cursor, null);
  assert.ok(f.messages.every(m => m.type === 'watch-list-page'));
});

test('IME input waits for composition end; Escape clears text and a filter change cancels obsolete debounce work', async () => {
  const f = fixture(); await f.flush(); const input = f.ids.get('search');
  input.fire('compositionstart'); f.input('語'); input.fire('keydown', {key:'Escape',isComposing:true}); await f.run(180); assert.equal(f.messages.length, 1); assert.equal(input.value, '語');
  input.fire('compositionend'); await f.run(180); assert.equal(f.messages.at(-1).query, '語');
  f.input('obsolete'); f.ids.get('filters').children.find(n => n.dataset.filter === 'all').click(); await f.flush();
  const count = f.messages.length; await f.run(180); assert.equal(f.messages.length, count); assert.equal(f.messages.at(-1).query, 'obsolete');
  input.fire('keydown', {key:'Escape'}); await f.flush(); assert.equal(f.messages.at(-1).query, '');
});

test('card success goes to a dismissible live toast without changing grid children or focus; actionable errors persist separately', async () => {
  const f = fixture(); await f.flush(); const card = f.findClass('video')[0], origin = f.findClass('card-refresh')[0];
  assert.equal(origin.parentElement, f.findClass('destination-actions')[0]);
  assert.match(origin.attrs['aria-label'], /Refresh Design practice from Reader/);
  origin.focus(); origin.click(); await f.flush();
  const toast = f.ids.get('toast'), error = f.ids.get('error-toast');
  assert.equal(toast.hidden, false); assert.equal(toast.querySelector('p').textContent, 'Card updated from Reader.');
  assert.equal(f.findClass('video')[0], card); assert.equal(f.document.activeElement, origin);
  await f.run(30); assert.equal(f.ids.get('announcements').textContent, 'Card updated from Reader.');
  f.responder = (message, normal) => message.type === 'watch-list-refresh' ? {ok:false,code:'network_error'} : normal(message);
  origin.click(); await f.flush(); assert.equal(error.hidden, false); assert.match(error.textContent, /could not be reached/);
  await f.run(6000); assert.equal(toast.hidden, true); assert.equal(error.hidden, false); assert.match(f.findClass('row-status')[0].textContent, /could not be reached/);
  f.responder = (message, normal) => normal(message); f.findClass('card-refresh')[1].click(); await f.flush();
  assert.equal(toast.hidden, false); assert.equal(error.hidden, false);
  error.querySelector('button').click(); assert.equal(error.hidden, true);
});

test('toast lifetime pauses for pointer, keyboard focus and hidden documents, resets on a new notice, and never steals focus', async () => {
  const f = fixture(); await f.flush(); const refresh = f.findClass('card-refresh')[0], box = f.ids.get('toast');
  refresh.focus(); refresh.click(); await f.flush(); await f.run(2000); box.fire('pointerenter'); await f.run(10000); assert.equal(box.hidden, false);
  box.fire('pointerleave'); await f.run(3999); assert.equal(box.hidden, false); await f.run(1); assert.equal(box.hidden, true); assert.equal(f.document.activeElement, refresh);
  refresh.click(); await f.flush(); box.querySelector('button').focus(); box.fire('focusin'); await f.run(10000); assert.equal(box.hidden, false);
  box.querySelector('button').click(); assert.equal(box.hidden, true); assert.equal(f.document.activeElement, refresh);
  refresh.click(); await f.flush(); await f.run(5000); f.findClass('card-refresh')[1].click(); await f.flush(); await f.run(5000); assert.equal(box.hidden, false);
  await f.run(1000); assert.equal(box.hidden, true);
  refresh.click(); await f.flush(); await f.run(1000); f.visibility(true); await f.run(10000); assert.equal(box.hidden, false);
  f.visibility(false); await f.run(5000); assert.equal(box.hidden, true);
});

test('successive empty searches keep the settled empty view throughout debounce and stale replies, then transition only for current results', async () => {
  const f = fixture(); await f.flush(); const replies = [];
  f.responder = (message, normal) => message.type === 'watch-list-page' ? new Promise(resolve => replies.push({ message, resolve })) : normal(message);
  f.ids.get('search').focus();
  f.input('elephant'); await f.run(180); replies[0].resolve({ok:true,items:[],hasNext:false}); await f.flush();
  const empty = f.ids.get('empty'), grid = f.ids.get('videos'), label = f.ids.get('page-label').textContent;
  assert.equal(empty.hidden, false); assert.equal(grid.hidden, true);
  const visibility = [];
  for (const [name, node] of [['empty', empty], ['grid', grid]]) {
    let hidden = node.hidden;
    Object.defineProperty(node, 'hidden', { get: () => hidden, set(value) { if (value !== hidden) visibility.push([name,value]); hidden = value; } });
  }
  const stableEmpty = () => { assert.equal(empty.hidden, false); assert.equal(grid.hidden, true); assert.equal(f.ids.get('empty-title').textContent,'No matching videos'); assert.equal(f.ids.get('page-label').textContent,label); assert.deepEqual(visibility,[]); };
  f.input('elephantx'); stableEmpty(); await f.run(179); stableEmpty(); await f.run(1); stableEmpty();
  f.input('elephantxx'); stableEmpty();
  replies[1].resolve({ok:true,items:f.defaultItems,hasNext:false}); await f.flush(); stableEmpty();
  await f.run(180); stableEmpty(); replies[2].resolve({ok:true,items:[],hasNext:false}); await f.flush(); stableEmpty();
  f.input('focus'); stableEmpty(); await f.run(180); stableEmpty();
  replies[3].resolve({ok:true,items:[f.defaultItems[1]],hasNext:false}); await f.flush();
  assert.equal(empty.hidden,true); assert.equal(grid.hidden,false); assert.deepEqual(visibility,[['grid',false],['empty',true]]);
  visibility.length = 0; const card = f.findClass('video')[0];
  f.input('absent again'); assert.equal(grid.hidden,false); assert.equal(empty.hidden,true); assert.equal(f.findClass('video')[0],card);
  await f.run(180); assert.deepEqual(visibility,[]);
  replies[4].resolve({ok:true,items:[],hasNext:false}); await f.flush();
  assert.equal(empty.hidden,false); assert.equal(grid.hidden,true); assert.deepEqual(visibility,[['grid',true],['empty',false]]);
  assert.equal(f.document.activeElement,f.ids.get('search')); assert.ok(f.messages.every(m => m.type === 'watch-list-page'));
});

test('real card thumbnails fall back without Reader messages and removed rows cancel their late image events', async()=>{
  const f=fixture();await f.flush();const image=f.findClass('thumbnail')[0];
  assert.match(image.src,/\/maxresdefault\.jpg$/);assert.equal(image.loading,'lazy');
  image.currentSrc=image.src;image.naturalWidth=120;image.naturalHeight=90;image.fire('load');assert.match(image.src,/\/sddefault\.jpg$/);
  const last=image.src;f.responder=(message,normal)=>message.type==='watch-list-page'?{ok:true,items:[],hasNext:false}:normal(message);
  f.input('no retained rows');await f.run(180);image.currentSrc=last;image.fire('error');assert.equal(image.src,last);
  assert.ok(f.messages.every(message=>message.type==='watch-list-page'));assert.equal(f.findClass('video').length,0);
});

// Real location-menu clicks and footer clicks must share the same deletion route.
for (const surface of ['footer', 'menu']) {
  const trash = (f, modifiers = {}) => {
    if (surface === 'footer') return f.activate(f.findClass('card-trash')[0].children[0], modifiers);
    f.activate(f.findClass('location-trigger')[0]);
    f.activate(f.findClass('destructive-item')[0].children[0], modifiers);
  };
  const mockDelete = f => {
    f.responder = (message, normal) => message.type === 'watch-list-prepare-delete'
      ? { ok: true, token: 'fixture-ticket', videoUrl: f.defaultItems[0].videoUrl, id: 'doc-0', title: 'Fixture document' }
      : normal(message);
  };
  test(`Recent saves ${surface}: normal click confirms; cancelling sends no delete; confirmed click uses prepared ticket`, async () => {
    const f = fixture(); await f.flush(); mockDelete(f);
    trash(f); await f.flush();
    assert.equal(f.ids.get('deletion').open, true); assert.equal(f.document.activeElement, f.ids.get('cancel-delete'));
    assert.equal(f.ids.get('delete-title').textContent, 'Fixture document');
    assert.match(f.ids.get('delete-identity').textContent, /item_0.*doc-0/);
    assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 0);
    f.ids.get('cancel-delete').click(); await f.flush();
    assert.equal(f.ids.get('deletion').open, false); assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 0);
    assert.equal(f.document.activeElement, f.findClass(surface === 'footer' ? 'card-trash' : 'location-trigger')[0]);
    trash(f); await f.flush(); f.ids.get('confirm-delete').click(); await f.flush();
    const writes = f.messages.filter(m => m.type === 'watch-list-delete');
    assert.equal(writes.length, 1); assert.equal(writes[0].token, 'fixture-ticket'); assert.equal(writes[0].confirmed, true);
  });
  test(`Recent saves ${surface}: Cmd-click bypasses modal after preflight, locks pending action, and sends once`, async () => {
    const f = fixture(); await f.flush(); let prepare, remove;
    f.responder = (message, normal) => message.type === 'watch-list-prepare-delete'
      ? new Promise(resolve => { prepare = () => resolve({ ok: true, token: 'fixture-ticket', videoUrl: f.defaultItems[0].videoUrl, id: 'doc-0' }); })
      : message.type === 'watch-list-delete' ? new Promise(resolve => { remove = () => resolve({ ok: true }); }) : normal(message);
    trash(f, { metaKey: true }); trash(f, { metaKey: true });
    assert.equal(f.messages.filter(m => m.type === 'watch-list-prepare-delete').length, 1);
    assert.equal(f.findClass('card-trash')[0].disabled, true); assert.notEqual(f.ids.get('deletion').open, true);
    prepare(); await f.flush();
    assert.notEqual(f.ids.get('deletion').open, true); assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 1);
    assert.equal(f.findClass('video')[0].attrs['aria-busy'], 'true'); assert.equal(f.findClass('row-status')[0].textContent, 'Working…');
    f.findClass('card-trash')[0].fire('click', { metaKey: true }); f.ids.get('confirm-delete').fire('click');
    assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 1);
    remove(); await f.flush(); assert.equal(f.ids.get('toast').querySelector('p').textContent, 'Deleted from Reader.');
    assert.equal(f.findClass('card-trash')[0].disabled, false);
  });
  test(`Recent saves ${surface}: Ctrl/Alt/Shift alone retain confirmation; Cmd errors stay visible`, async () => {
    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      const f = fixture(); await f.flush(); mockDelete(f); trash(f, modifiers); await f.flush();
      assert.equal(f.ids.get('deletion').open, true); assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 0);
    }
    for (const code of ['unauthorized', 'delete_uncertain', 'delete_conflict']) {
      const f = fixture(); await f.flush(); mockDelete(f);
      f.responder = (message, fallback) => message.type === 'watch-list-delete' ? { ok: false, code }
        : message.type === 'watch-list-prepare-delete' ? { ok: true, token: 'fixture-ticket', videoUrl: f.defaultItems[0].videoUrl, id: 'doc-0' } : fallback(message);
      trash(f, { metaKey: true }); await f.flush();
      assert.notEqual(f.ids.get('deletion').open, true); assert.equal(f.ids.get('error-toast').hidden, false);
      assert.equal(f.findClass('row-status')[0].dataset.error, 'true'); assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 1);
    }
  });
}

test('Cmd-click never deletes when prepare fails or its page/credentials become stale', async () => {
  for (const mode of ['failed', 'navigation', 'credentials']) {
    const f = fixture(); await f.flush(); let release;
    f.responder = (message, normal) => message.type === 'watch-list-prepare-delete' ? new Promise(resolve => { release = resolve; }) : normal(message);
    f.activate(f.findClass('card-trash')[0], { metaKey: true });
    if (mode === 'navigation') f.input('changed');
    if (mode === 'credentials') f.change({ readerToken: { newValue: 'fixture-only' } });
    release(mode === 'failed' ? { ok: false, code: 'unauthorized' } : { ok: true, token: 'fixture-ticket', videoUrl: f.defaultItems[0].videoUrl, id: 'doc-0' });
    await f.flush(); assert.equal(f.messages.filter(m => m.type === 'watch-list-delete').length, 0); assert.notEqual(f.ids.get('deletion').open, true);
  }
});

test('inline Reader tags are inert safe text, beside the channel, with no empty symbol or extra fetch', async () => {
  const f = fixture(); f.defaultItems[0].tags = [' Deep work ', 'Deep work', '<img src=x onerror=alert(1)>', '', null];
  await f.flush();
  const group = f.findClass('inline-tags')[0], buttons = f.findClass('tag-filter-button');
  assert.equal(group.parentElement, f.findClass('channel-filter-button')[0].parentElement);
  assert.equal(group.attrs['aria-label'], 'Reader tags'); assert.equal(buttons.length, 2);
  assert.equal(buttons[0].textContent, 'Deep work'); assert.equal(buttons[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(buttons[1].children.length, 0); assert.equal(buttons[0].type, 'button');
  assert.equal(f.findClass('tag-symbol').length, 1); assert.equal(f.findClass('tag-symbol')[0].children[0].attrs['aria-hidden'], 'true');
  assert.equal(f.findClass('inline-tags')[1].hidden, true);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].type, 'watch-list-page');
  f.defaultItems[0].tags = []; f.change({readerWatchChanged:{newValue:1}}); await f.run(100);
  assert.equal(f.findClass('tag-filter-button').length, 0); assert.equal(f.findClass('tag-symbol').length, 0);
  f.defaultItems[0].tags = ['Old tag']; f.defaultItems[0].status = 'missing'; f.change({readerWatchChanged:{newValue:2}}); await f.run(100);
  assert.equal(f.findClass('tag-filter-button').length, 0);
});

test('exact multiword tag clicks isolate navigation, preserve other criteria, reset pagination and clear independently', async () => {
  const f = fixture(); f.defaultItems[0].tags = ['Deep work']; await f.flush();
  f.findClass('channel-filter-button')[0].click(); await f.flush(); f.input('attention'); await f.run(180);
  let navigation = 0; f.findClass('video')[0].addEventListener('click', () => navigation++);
  const button = f.findClass('tag-filter-button')[0], receipt = f.activate(button); await f.flush();
  assert.equal(receipt.prevented, true); assert.equal(receipt.stopped, true); assert.equal(navigation, 0);
  assert.equal(f.messages.at(-1).tag, 'Deep work'); assert.equal(f.messages.at(-1).channel, 'Maker'); assert.equal(f.messages.at(-1).query, 'attention'); assert.equal(f.messages.at(-1).cursor, null);
  assert.equal(f.document.activeElement, f.ids.get('tag-filter')); assert.equal(button.attrs['aria-pressed'], 'true');
  const count = f.messages.length; f.activate(button); await f.flush(); assert.equal(f.messages.length, count);
  f.ids.get('filters').children.find(n => n.dataset.filter === 'archive').click(); await f.flush(); assert.equal(f.messages.at(-1).tag, 'Deep work');
  f.ids.get('tag-filter').click(); await f.flush(); assert.equal(f.messages.at(-1).tag, ''); assert.equal(f.messages.at(-1).channel, 'Maker'); assert.equal(f.messages.at(-1).query, 'attention');
  f.activate(button); await f.flush(); f.ids.get('clear-search').click(); await f.flush();
  assert.equal(f.messages.at(-1).tag, ''); assert.equal(f.messages.at(-1).channel, ''); assert.equal(f.messages.at(-1).query, ''); assert.equal(f.messages.at(-1).filter, 'archive');
  f.activate(button); await f.flush(); f.ids.get('reset-view').click(); await f.flush(); assert.equal(f.messages.at(-1).tag, ''); assert.equal(f.messages.at(-1).filter, 'all');
  assert.ok(f.messages.every(m => m.type === 'watch-list-page'));
});

test('tag filtering retains settled empty/error views and rejects stale results while controls recover', async () => {
  const f = fixture(); f.defaultItems[0].tags = ['Deep work']; await f.flush();
  let release; f.responder = (message, normal) => message.tag ? new Promise(resolve => { release = resolve; }) : normal(message);
  const button = f.findClass('tag-filter-button')[0]; f.activate(button); await f.flush();
  assert.equal(button.disabled, true); assert.equal(f.ids.get('videos').attrs['aria-busy'], 'true');
  f.ids.get('tag-filter').click(); await f.flush(); release({ok:true,items:[],hasNext:false}); await f.flush();
  assert.equal(f.findClass('video').length, 2); assert.equal(button.disabled, false);
  f.responder = () => ({ok:false,code:'watch_storage_error'}); f.activate(button); await f.flush();
  assert.equal(f.findClass('video').length, 2); assert.equal(f.ids.get('error-toast').hidden, false); assert.equal(f.ids.get('tag-filter').hidden, false);
  f.responder = (message, normal) => message.tag ? {ok:true,items:[],hasNext:false} : normal(message);
  f.ids.get('refresh').click(); await f.flush(); assert.equal(f.ids.get('empty').hidden, false); assert.match(f.ids.get('empty-title').textContent, /No matching/);
  f.ids.get('reset-view').click(); await f.flush(); assert.equal(f.ids.get('empty').hidden, true); assert.equal(f.findClass('video').length, 2);
});

test('many and long tags stay bounded and failed Reader refresh preserves cached tag buttons', async () => {
  const f = fixture(); f.defaultItems[0].tags = ['x'.repeat(300), ...Array.from({length:110}, (_,i) => `Tag ${i}`)]; await f.flush();
  const buttons = f.findClass('tag-filter-button'); assert.equal(buttons.length, 100); assert.equal(buttons[0].textContent.length, 200);
  let release; f.responder = (message, normal) => message.type === 'watch-list-refresh' ? new Promise(resolve => { release = resolve; }) : normal(message);
  f.findClass('card-refresh')[0].click(); await f.flush(); assert.equal(buttons[0].disabled, true);
  release({ok:false,code:'network_error'}); await f.flush(); assert.equal(f.findClass('tag-filter-button')[0], buttons[0]); assert.equal(buttons[0].disabled, false);
  assert.match(f.ids.get('error-toast').textContent, /Cached videos/);
});

test('Recent saves renders pending and reloads the local summary on readiness without a Reader refresh action', async () => {
  const f = fixture(); for (const item of f.defaultItems) { item.summary = null; item.summaryJob = { status: 'pending' }; }
  await f.flush(); assert.match(f.findClass('summary-text')[0].textContent, /preparing.*automatically/);
  f.defaultItems[0].summary = 'Arrived automatically'; f.defaultItems[0].summaryJob = { status: 'ready' };
  f.change({ readerSummaryJobs: { newValue: {} } }); await f.run(100);
  assert.equal(f.findClass('summary-text')[0].textContent, 'Arrived automatically');
  assert.equal(f.messages.filter(message => message.type === 'watch-list-refresh').length, 0);
});
