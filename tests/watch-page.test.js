// Real Watch page/search/toast controllers with a deterministic DOM/worker boundary.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = () => new Promise(setImmediate);
function fixture() {
  let clock = 1000, sequence = 0, responder;
  const timers = new Map(), messages = [], listeners = new Map(), storageListeners = [], ids = new Map();
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false; this.value = ''; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
    get textContent() { return this.ownText + this.children.map(n => n.textContent).join(''); }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
    replaceChildren(...nodes) { for (const n of this.children) n.parentElement = null; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(key, fn) { this.listeners.set(key, [...this.listeners.get(key) || [], fn]); }
    fire(type, extra = {}) { const event = { key: '', relatedTarget: null, preventDefault() {}, ...extra }; for (const fn of this.listeners.get(type) || []) fn(event); }
    click() { if (!this.disabled && !this.hidden) this.fire('click'); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    contains(node) { return node === this || this.children.some(n => n.contains(node)); }
    focus() { const previous = document.activeElement; document.activeElement = this; for (let n = previous; n; n = n.parentElement) n.fire('focusout', {relatedTarget:this}); for (let n = this; n; n = n.parentElement) n.fire('focusin', {relatedTarget:previous}); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) { return this.children.flatMap(all).find(n => selector === '[aria-pressed="true"]' ? n.attrs['aria-pressed'] === 'true' : n.tagName === selector) || null; }
  }
  const all = node => [node, ...node.children.flatMap(all)];
  const document = { body: new Node('body'), documentElement: new Node('html'), activeElement: null, hidden: false,
    getElementById: id => ids.get(id), createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag),
    addEventListener(type, fn) { listeners.set(type, [...listeners.get(type) || [], fn]); } };
  document.activeElement = document.body;
  for (const id of ['videos','search','clear-search','channel-filter','search-status','filters','refresh','previous','next','page-label','empty','empty-title','empty-description','reset-view','deletion','delete-title','delete-identity','delete-status','cancel-delete','confirm-delete','announcements','toast','error-toast']) {
    const node = new Node(id === 'search' ? 'input' : ['clear-search','channel-filter','refresh','previous','next','reset-view','cancel-delete','confirm-delete'].includes(id) ? 'button' : 'div');
    ids.set(id, node); document.body.append(node);
  }
  for (const id of ['toast', 'error-toast']) { const box = ids.get(id); box.hidden = true; box.append(new Node('p'), new Node('button')); }
  const defaultItems = Array.from({length: 2}, (_, i) => ({ videoUrl: `https://www.youtube.com/watch?v=item_${i}`, readerId: `doc-${i}`, title: i ? 'Focus and craft' : 'Design practice', author: i ? 'Maker Extra' : 'Maker', summary: 'Cached attention', status: 'saved', location: 'later', checkedAt: 1000, savedAt: 1000 - i }));
  const reply = message => message.type === 'watch-list-page' ? { ok: true, items: defaultItems, hasNext: false, nextCursor: null } : { ok: true };
  class ClockDate extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, URL, Date: ClockDate, console,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock + delay, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    chrome: { runtime: { lastError: null, sendMessage(message, cb) { messages.push(message); Promise.resolve(responder ? responder(message, reply) : reply(message)).then(cb); } }, storage: { local: { get(defaults, cb) { cb(defaults); } }, onChanged: { addListener(fn) { storageListeners.push(fn); } } } },
    MVSWatchLocationMenu: { create: () => ({ id: 'location-menu', close() {}, refresh() {}, toggle() {}, open() {} }) },
  });
  for (const file of ['reader-core.js','reader-watch-core.js','watch-feedback.js','watch-search.js','watch.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), context);
  const flush = async () => { await tick(); await tick(); };
  const run = async delay => {
    clock += delay;
    for (const [id, timer] of [...timers].sort((a,b) => a[1].at - b[1].at)) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { ids, document, messages, defaultItems, context, timers, flush, run,
    set responder(fn) { responder = fn; },
    input(value) { ids.get('search').value = value; ids.get('search').fire('input'); },
    visibility(hidden) { document.hidden = hidden; (listeners.get('visibilitychange') || []).forEach(fn => fn()); },
    change(values) { storageListeners.forEach(fn => fn(values, 'local')); },
    findClass(name) { return all(document.body).filter(n => (n.className || '').split(' ').includes(name)); },
  };
}

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
