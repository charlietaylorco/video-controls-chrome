const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../reader-core.js');
const PAGE = 'https://www.youtube.com/feed/subscriptions';
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
const tick = () => new Promise(setImmediate);
function fixture({ saved = true, width = 1100, height = 700, nativeEvents = false } = {}) {
  const timers = new Map(), events = new Map(), storage = [], messages = [], validators = [];
  let active = null, clock = 100000, id = 0, uuid = 0, responder, mutation, deleted = 0;
  class Node {
    constructor(tag = '') { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false; this.textContent = ''; this.hover = false; }
    append(...nodes) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener(key, fn) { this.listeners.set(key, [...(this.listeners.get(key) || []), fn]); }
    fire(key, values = {}) { const event = { key: '', composedPath: () => [this], preventDefault() { this.prevented = true; }, stopPropagation() {}, ...values }; (this.listeners.get(key) || []).forEach(fn => fn(event)); return event; }
    click() { if (!this.disabled && !this.hidden) this.fire('click'); }
    get hidden() { return this._hidden; }
    set hidden(value) { this._hidden = value; if (nativeEvents && value && active && this.contains(active)) focusNode(null); }
    get disabled() { return this._disabled; }
    set disabled(value) { this._disabled = value; if (nativeEvents && value && active === this) focusNode(null); }
    contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
    getRootNode() { for (let n = this; n; n = n.parentElement) if (n.tagName === 'shadow' || !n.parentElement) return n; }
    focus() { if (nativeEvents) focusNode(this); else { active = this; this.fire('focusin'); } }
    blur() { if (nativeEvents) focusNode(null); else { active = null; this.fire('focusout'); } }
    attachShadow() { this.shadowRoot = new Node('shadow'); this.shadowRoot.host = this; return this.shadowRoot; }
    get activeElement() { return this.tagName === 'shadow' ? (this.contains(active) ? active : null) : active; }
    get isConnected() { const root = this.getRootNode(); return root === document.documentElement || Boolean(root.host?.isConnected); }
    matches(selector) { return selector === ':hover' && this.hover; }
    getBoundingClientRect() {
      return this.id === 'mvs-reader-card-preview' ? { width: Math.min(340, width - 16), height: Math.min(292, height - 16) }
        : { left: 40, top: 40, right: 65, bottom: 65, width: 25, height: 25 };
    }
  }
  const document = { documentElement: new Node('html'), createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    addEventListener(type, fn) { events.set(type, [...(events.get(type) || []), fn]); } };
  const pathFor = node => {
    const path = []; for (let n = node; n; n = n.parentElement || n.host) path.push(n); return path;
  };
  const dispatch = (node, type, values = {}) => {
    const path = pathFor(node);
    const event = { type, target: node, composedPath: () => path, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    if (type === 'pointerdown') for (const fn of events.get(type) || []) fn(event);
    for (const n of path) {
      if (event.stopped) break;
      for (const fn of n.listeners.get(type) || []) fn(event);
    }
    if (type !== 'pointerdown' && !event.stopped) for (const fn of events.get(type) || []) fn(event);
    return event;
  };
  function focusNode(node) {
    if (active === node) return;
    const previous = active; active = node;
    if (previous) dispatch(previous, 'focusout', { relatedTarget: node });
    if (node) dispatch(node, 'focusin', { relatedTarget: previous });
  }
  const source = new Node('card'), overlay = new Node('overlay'), button = new Node('button');
  document.documentElement.append(source, overlay); overlay.attachShadow().append(button);
  let target = { source, videoUrl: B, title: 'Card title', saved };
  const location = { href: PAGE };
  const media = { matches: false, addEventListener(type, fn) { this.change = fn; } };
  const context = { URL, Date, console, location, innerWidth: width, innerHeight: height, document,
    crypto: { randomUUID: () => `fixture-${++uuid}` }, matchMedia: () => media,
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, delay }); return key; }, clearTimeout: key => timers.delete(key),
    addEventListener(type, fn) { events.set(`window:${type}`, [...(events.get(`window:${type}`) || []), fn]); },
    chrome: { runtime: { id: 'extension', lastError: null, onMessage: { addListener(fn) { validators.push(fn); } },
      sendMessage(message, callback) {
        messages.push(message);
        const normal = () => message.type === 'reader-card-delete' ? { ok: true, id: message.id, targetUrl: message.targetUrl,
          deleted: true, deleteStatus: 204, verifiedAbsent: true }
          : { ok: true, document: { id: `doc-${new URL(message.targetUrl).searchParams.get('v')}`, videoUrl: message.targetUrl,
            title: 'A saved video', summary: `Summary ${message.targetUrl}`, notes: 'Saved note', updatedAt: 'v1' } };
        Promise.resolve(responder ? responder(message, normal) : normal()).then(callback);
      } }, storage: { local: { get(defaults, cb) { cb(defaults); } }, onChanged: { addListener(fn) { storage.push(fn); } } } },
  };
  context.window = context; vm.createContext(context);
  for (const name of ['reader-core.js', 'reader-card-preview.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  const api = context.MVSReaderCardPreview.create({ button, getTarget: () => target, onDeleted: () => { deleted++; }, now: () => clock });
  const all = node => [node, ...node.children.flatMap(all), ...(node.shadowRoot ? all(node.shadowRoot) : [])];
  const nodes = () => all(document.documentElement);
  const byClass = name => nodes().find(n => (n.attrs.class || n.className || '').split(' ').includes(name));
  const findButton = name => nodes().find(n => n.tagName === 'button' && (n.attrs['aria-label'] === name || n.textContent === name));
  const run = delay => { for (const [key, timer] of [...timers]) if (timer.delay === delay) { timers.delete(key); timer.fn(); } };
  const event = (type, values = {}) => (events.get(type) || []).forEach(fn => fn({ key: '', composedPath: () => [], preventDefault() {}, stopPropagation() {}, ...values }));
  return { api, button, source, messages, byClass, findButton, media, get host() { return nodes().find(n => n.id === 'mvs-reader-card-preview'); },
    get active() { return active; }, get deleted() { return deleted; }, run, event,
    set responder(value) { responder = value; }, advance(ms) { clock += ms; },
    setTarget(value) { target = { ...target, ...value }; api.update(); },
    navigate(page) { location.href = page; event('yt-navigate-finish'); }, mutate: () => mutation(),
    change(values) { storage.forEach(fn => fn(values, 'local')); },
    validate(extra = {}, sender = { id: 'extension' }) {
      const message = { type: 'reader-card-validate', ...messages.at(-1), ...extra }; message.type = 'reader-card-validate';
      let reply; validators.forEach(fn => fn(message, sender, result => { reply = result; })); return reply;
    },
    async hover() { button.hover = true; button.fire('pointerenter'); run(300); await tick(); },
    userClick(node, modifiers = {}) {
      dispatch(node, 'pointermove'); dispatch(node, 'pointerdown'); dispatch(node, 'mousedown');
      focusNode(node); dispatch(node, 'pointerup'); dispatch(node, 'mouseup'); dispatch(node, 'click', modifiers);
    },
    keyboardActivate(node) { focusNode(node); dispatch(node, 'keydown', { key: 'Enter' }); dispatch(node, 'click'); },
  };
}

// Exercise the actual isolated UI -> worker guards -> service -> fetch route.
// Both extension contexts and all Reader responses remain synthetic.
function connectWorker(f, responder) {
  const data = { readerToken: 'fixture-only', readerDocuments: { [B]: { id: 'doc-beta', at: 1 } }, readerSavedUrls: { [B]: 1 } };
  const requests = [], challenges = [];
  let listener;
  const worker = vm.createContext({ URL, Date, AbortSignal, console, chrome: {
    runtime: { id: 'extension', lastError: null, getURL: s => s, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { get(defaults, cb) { cb({ ...defaults, ...data }); }, set(values, cb) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
      Object.assign(data, structuredClone(values)); f.change(changes); cb?.();
    } } }, action: { onClicked: { addListener() {} } }, tabs: {
      get(id, cb) { cb({ id, url: PAGE }); },
      sendMessage(id, message, options, cb) { challenges.push({ message, options }); cb(f.validate(message)); },
    },
  }, fetch: async (url, options) => {
    requests.push({ url, ...options });
    const result = await responder(url, options, requests);
    return { status: result.status || 200, ok: !result.status || (result.status >= 200 && result.status < 300),
      headers: { get: () => null }, json: async () => result };
  } });
  worker.importScripts = (...files) => files.filter(name => name.startsWith('reader-')).forEach(name =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), worker));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), worker);
  f.responder = message => new Promise(resolve => listener(message,
    { id: 'extension', frameId: 0, documentId: 'fixture-document', url: PAGE, tab: { id: 1, url: PAGE } }, resolve));
  return { data, requests, challenges };
}

test('real hover controller and background transport require exact DELETE 204 plus absence before displaying success', async () => {
  const f = fixture(); let present = true;
  const worker = connectWorker(f, (url, init) => {
    if (init.method === 'DELETE') { present = false; return { status: 204 }; }
    return { results: present ? [{ id: 'doc-beta', source_url: B, title: 'Fixture video', summary: 'Fixture summary', notes: 'Saved note', updated_at: 'v1' }] : [] };
  });
  await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
  assert.deepEqual(worker.requests.map(r => [r.url, r.method]), [
    ['https://readwise.io/api/v3/list/?id=doc-beta', undefined],
    ['https://readwise.io/api/v3/list/?id=doc-beta', undefined],
    ['https://readwise.io/api/v3/delete/doc-beta/', 'DELETE'],
    ['https://readwise.io/api/v3/list/?id=doc-beta', undefined],
  ]);
  assert.equal(worker.requests[2].body, undefined); assert.ok(worker.requests.every(r => r.cache === 'no-store'));
  assert.ok(worker.challenges.every(c => c.options.documentId === 'fixture-document' && c.message.targetUrl === B));
  assert.equal(f.deleted, 1); assert.match(f.byClass('summary').textContent, /^Deleted from Reader/);
  assert.equal(worker.data.readerSavedUrls[B], undefined); assert.equal(worker.data.readerDeletedVideos[B].id, 'doc-beta');
});

test('real hover route never displays success for a missing preflight target or a document still returned after DELETE', async () => {
  for (const failure of ['missing', 'still-present']) {
    const f = fixture();
    const worker = connectWorker(f, (url, init, requests) => init.method === 'DELETE' ? { status: 204 }
      : { results: failure === 'missing' && requests.length > 1 ? []
        : [{ id: 'doc-beta', source_url: B, title: 'Fixture video', summary: 'Fixture summary', notes: 'Saved note', updated_at: 'v1' }] });
    await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
    assert.equal(f.deleted, 0); assert.equal(worker.data.readerSavedUrls[B], 1); assert.equal(worker.data.readerDeletedVideos?.[B], undefined);
    assert.equal(worker.requests.filter(r => r.method === 'DELETE').length, failure === 'missing' ? 0 : 1);
    assert.match(f.byClass('summary').textContent, failure === 'missing' ? /No DELETE was sent/ : /still returns this document/);
  }
});

test('native pointer confirmation retains its card lease through hidden-control focusout and a slow preflight', async () => {
  const f = fixture({ nativeEvents: true }); let reads = 0, release, present = true;
  const raw = () => ({ id: 'doc-beta', source_url: B, title: 'Fixture video', summary: 'Fixture summary', notes: 'Saved note', updated_at: 'v1' });
  const worker = connectWorker(f, (url, init) => {
    if (init.method === 'DELETE') { present = false; return { status: 204 }; }
    if (++reads === 2) return new Promise(resolve => { release = () => resolve({ results: [raw()] }); });
    return { results: present ? [raw()] : [] };
  });
  await f.hover(); f.button.fire('pointerleave');
  f.host.fire('pointerenter'); f.userClick(f.findButton('Delete from Reader'));
  assert.equal(f.byClass('confirmation').hidden, false); assert.equal(f.active, f.findButton('Cancel'));
  f.userClick(f.findButton('Delete document')); await tick();
  f.host.fire('pointerleave'); f.run(180); const dismissed = f.host.hidden;
  release(); await tick();
  assert.equal(dismissed, false, 'focusout from hiding the clicked confirmation must not dismiss an accepted pending action');
  assert.equal(worker.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(f.deleted, 1); assert.match(f.byClass('summary').textContent, /^Deleted from Reader/);
});

test('keyboard confirmation and accidental focus departure cannot implicitly cancel a pending delete or issue it twice', async () => {
  const f = fixture({ nativeEvents: true }); let release;
  f.responder = (message, normal) => message.type === 'reader-card-delete' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  await f.hover(); f.keyboardActivate(f.findButton('Delete from Reader')); f.keyboardActivate(f.findButton('Delete document'));
  f.active.blur(); f.host.fire('pointerleave'); f.run(180);
  f.findButton('Delete document').fire('click');
  assert.equal(f.host.hidden, false); assert.equal(f.messages.filter(m => m.type === 'reader-card-delete').length, 1);
  release(); await tick(); assert.equal(f.deleted, 1);
});

test('explicit dismissal or a recycled card during slow preflight still revokes the lease before DELETE', async () => {
  for (const dismissal of ['close', 'escape', 'outside', 'recycle']) {
    const f = fixture({ nativeEvents: true }); let reads = 0, release;
    const raw = { id: 'doc-beta', source_url: B, title: 'Fixture video', summary: 'Summary', notes: 'Saved note', updated_at: 'v1' };
    const worker = connectWorker(f, () => ++reads === 2 ? new Promise(resolve => { release = () => resolve({ results: [raw] }); }) : { results: [raw] });
    await f.hover(); f.userClick(f.findButton('Delete from Reader')); f.userClick(f.findButton('Delete document')); await tick();
    if (dismissal === 'close') f.userClick(f.findButton('Close summary'));
    if (dismissal === 'escape') f.event('keydown', { key: 'Escape', composedPath: () => [f.host] });
    if (dismissal === 'outside') f.event('pointerdown');
    if (dismissal === 'recycle') f.setTarget({ videoUrl: A });
    release(); await tick();
    assert.equal(f.host.hidden, true, dismissal); assert.equal(f.deleted, 0);
    assert.equal(worker.requests.filter(r => r.method === 'DELETE').length, 0, dismissal);
    assert.equal(worker.data.readerSavedUrls[B], 1);
  }
});

test('native pointer Refresh keeps its session through a disabled-control blur and shows the updated result or error', async () => {
  for (const fail of [false, true]) {
    const f = fixture({ nativeEvents: true }); let reads = 0, release;
    const raw = summary => ({ id: 'doc-beta', source_url: B, title: 'Fixture video', summary, notes: 'Saved note', updated_at: 'v1' });
    const worker = connectWorker(f, () => ++reads === 2 ? new Promise(resolve => {
      release = () => resolve(fail ? { status: 401 } : { results: [raw('Updated Reader summary')] });
    }) : { results: [raw('Original Reader summary')] });
    await f.hover(); f.host.fire('pointerenter'); f.userClick(f.findButton('Refresh summary')); await tick();
    f.host.fire('pointerleave'); f.run(180); const dismissed = f.host.hidden;
    release(); await tick();
    assert.equal(dismissed, false, 'disabling focused Refresh must not dismiss the pending explicit read');
    assert.equal(f.host.hidden, false); assert.equal(f.findButton('Refresh summary').disabled, false);
    assert.match(f.byClass('summary').textContent, fail ? /Reader rejected the token/ : /Updated Reader summary/);
    assert.equal(worker.requests.length, 2); assert.ok(worker.requests.every(r => !r.method)); assert.equal(f.deleted, 0);
  }
});

test('keyboard Refresh retains errors through focus departure while hover-only reads still dismiss normally', async () => {
  const f = fixture({ nativeEvents: true }); let release, reads = 0;
  f.responder = (message, normal) => ++reads === 2 ? new Promise(resolve => { release = () => resolve({ ok: false, code: 'network_error' }); }) : normal();
  await f.hover(); f.keyboardActivate(f.findButton('Refresh summary')); f.active.blur(); f.host.fire('pointerleave'); f.run(180);
  assert.equal(f.host.hidden, false); release(); await tick(); assert.match(f.byClass('summary').textContent, /could not be reached/);
  assert.equal(f.messages.length, 2); assert.equal(f.findButton('Refresh summary').disabled, false);
  const passive = fixture({ nativeEvents: true }); let finish;
  passive.responder = (message, normal) => new Promise(resolve => { finish = () => resolve(normal()); });
  passive.button.fire('pointerenter'); passive.run(300); passive.button.fire('pointerleave'); passive.run(180);
  assert.equal(passive.host.hidden, true); finish(); await tick(); assert.equal(passive.host.hidden, true);
});

test('explicit dismissal, recycling and navigation still suppress late Refresh replies', async () => {
  for (const dismissal of ['close', 'escape', 'outside', 'recycle', 'navigate']) {
    const f = fixture({ nativeEvents: true }); let release, reads = 0;
    f.responder = (message, normal) => ++reads === 2 ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
    await f.hover(); f.userClick(f.findButton('Refresh summary'));
    if (dismissal === 'close') f.userClick(f.findButton('Close summary'));
    if (dismissal === 'escape') f.event('keydown', { key: 'Escape', composedPath: () => [f.host] });
    if (dismissal === 'outside') f.event('pointerdown');
    if (dismissal === 'recycle') f.setTarget({ videoUrl: A });
    if (dismissal === 'navigate') f.navigate('https://www.youtube.com/');
    release(); await tick(); assert.equal(f.host.hidden, true, dismissal); assert.equal(f.deleted, 0);
    assert.equal(f.messages.filter(m => m.type === 'reader-card-get').length, 2);
  }
});

test('hover intent is saved-only, cancellable, deduplicated and never saves an unsaved card', async () => {
  const f = fixture({ saved: false }); await f.hover(); assert.equal(f.messages.length, 0); assert.equal(f.host, undefined);
  f.setTarget({ saved: true }); f.button.fire('pointerenter'); f.button.hover = false; f.button.fire('pointerleave'); f.run(300); f.run(180); await tick();
  assert.equal(f.messages.length, 0);
  f.button.fire('pointerenter'); f.button.fire('focusin'); f.run(300); await tick();
  assert.equal(f.messages.length, 1); f.button.fire('pointerenter'); await tick(); assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, 'reader-card-get'); assert.equal(f.messages[0].targetUrl, B); assert.equal(f.messages[0].pageUrl, PAGE);
});

test('scrolling cancels pending hover fetches and waits for intent after scrolling settles', async () => {
  const f = fixture(); f.button.fire('pointerenter'); f.event('window:scroll'); f.run(300); await tick();
  assert.equal(f.messages.length, 0); await f.hover(); assert.equal(f.messages.length, 0);
  f.advance(201); await f.hover(); assert.equal(f.messages.length, 1);
  f.event('window:scroll', { composedPath: () => [f.host] }); assert.equal(f.host.hidden, false);
});

test('successful summaries cache by video with TTL; explicit Refresh bypasses cache', async () => {
  const f = fixture(); await f.hover(); f.api.close(); await f.hover(); assert.equal(f.messages.length, 1);
  f.findButton('Refresh summary').click(); await tick(); assert.equal(f.messages.length, 2);
  f.api.close(); f.advance(60001); await f.hover(); assert.equal(f.messages.length, 3);
  assert.match(f.byClass('summary').textContent, /beta/);
});

test('card validation binds the live node, lease, video, page and extension sender', async () => {
  const f = fixture(); await f.hover(); assert.equal(f.validate().ok, true);
  for (const extra of [{ lease: 'other' }, { targetUrl: A }, { pageUrl: 'https://www.youtube.com/' }]) assert.equal(f.validate(extra).ok, false);
  assert.equal(f.validate({}, { id: 'other-extension' }).ok, false);
  f.setTarget({ videoUrl: A }); assert.equal(f.validate().ok, false); assert.equal(f.host.hidden, true);
});

test('recycled/removed cards, rapid A-B hovers and SPA changes suppress late replies', async () => {
  const f = fixture(); const replies = [];
  f.responder = (message, normal) => new Promise(resolve => replies.push(() => resolve(normal())));
  f.button.fire('pointerenter'); f.run(300);
  f.setTarget({ videoUrl: A }); await f.hover();
  replies[1](); await tick(); assert.match(f.byClass('summary').textContent, /alpha/);
  replies[0](); await tick(); assert.match(f.byClass('summary').textContent, /alpha/);
  f.navigate('https://www.youtube.com/results?search_query=x'); assert.equal(f.host.hidden, true);
  f.setTarget({ videoUrl: B }); await f.hover(); f.source.parentElement = null; f.mutate();
  replies[2](); await tick(); assert.equal(f.host.hidden, true);
});

test('pointer can cross into the preview while reading; leaving closes after grace', async () => {
  const f = fixture(); await f.hover(); f.button.hover = false; f.button.fire('pointerleave'); f.host.fire('pointerenter'); f.run(180);
  assert.equal(f.host.hidden, false);
  f.host.fire('pointerleave'); f.run(180); assert.equal(f.host.hidden, true);
});

test('keyboard focus opens, ArrowDown cancels pending intent correctly, Escape returns focus without reopening', async () => {
  const f = fixture(); f.button.focus(); f.button.fire('keydown', { key: 'ArrowDown' }); await tick();
  assert.equal(f.host.hidden, false); assert.equal(f.active, f.findButton('Close summary'));
  f.event('keydown', { key: 'Escape', composedPath: () => [f.host] }); f.api.update(); f.run(300); await tick();
  assert.equal(f.host.hidden, true); assert.equal(f.active, f.button); assert.equal(f.messages.length, 1);
});

test('remote summary/title HTML remains inert, Reader links are generated from safe ids', async () => {
  const f = fixture(); const html = '<img src=x onerror=alert(1)><script>bad()</script>';
  f.responder = message => ({ ok: true, document: { id: 'doc-beta', videoUrl: B, title: html, summary: html, notes: '', updatedAt: '' } });
  await f.hover(); assert.equal(f.byClass('summary').textContent, html); assert.equal(f.byClass('summary').children.length, 0);
  assert.equal(f.byClass('title').textContent, html);
});

test('delete requires exact named confirmation, defaults to Cancel, and Cancel/Escape send no mutation', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click();
  assert.equal(f.byClass('confirmation').hidden, false); assert.equal(f.active, f.findButton('Cancel'));
  assert.match(f.byClass('identity').textContent, /beta.*doc-beta/);
  f.findButton('Cancel').click(); assert.equal(f.byClass('confirmation').hidden, true);
  f.findButton('Delete from Reader').click(); f.event('keydown', { key: 'Escape', composedPath: () => [f.host] });
  assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.messages.length, 1); assert.equal(f.deleted, 0);
});

test('confirmed delete uses captured id/video/notes and reconciles only known success; uncertain failures never retry', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
  const message = f.messages.at(-1);
  assert.equal(message.type, 'reader-card-delete'); assert.equal(message.id, 'doc-beta'); assert.equal(message.targetUrl, B);
  assert.equal(message.baseNotes, 'Saved note'); assert.equal(message.confirmed, true); assert.equal(f.deleted, 1);
  assert.equal(f.findButton('Delete from Reader').disabled, true); assert.match(f.byClass('summary').textContent, /Deleted from Reader/);
  const uncertain = fixture(); uncertain.responder = (message, normal) => message.type === 'reader-card-delete' ? { ok: false, code: 'delete_uncertain' } : normal();
  await uncertain.hover(); uncertain.findButton('Delete from Reader').click(); uncertain.findButton('Delete document').click(); await tick(); uncertain.run(300);
  assert.equal(uncertain.deleted, 0); assert.equal(uncertain.messages.length, 2); assert.match(uncertain.byClass('summary').textContent, /could not be confirmed/);
});

test('a generic ok/already-absent reply without a verified DELETE receipt never produces hover deletion success', async () => {
  const f = fixture(); f.responder = (message, normal) => message.type === 'reader-card-delete' ? { ok: true, id: message.id, alreadyDeleted: true } : normal();
  await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
  assert.equal(f.deleted, 0); assert.doesNotMatch(f.byClass('summary').textContent, /^Deleted from Reader/);
  assert.match(f.byClass('summary').className, /error/);
  assert.equal(f.findButton('Delete from Reader').disabled, true);
});

test('hover rejects missing or mismatched deletion receipts and requires Refresh before another confirmation', async () => {
  for (const patch of [{ id: 'wrong-id' }, { targetUrl: A }, { deleteStatus: 200 }, { verifiedAbsent: false }, { deleted: false }]) {
    const f = fixture(); f.responder = (message, normal) => ({ ...normal(), ...(message.type === 'reader-card-delete' ? patch : {}) });
    await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
    assert.equal(f.deleted, 0); assert.match(f.byClass('summary').textContent, /did not verify deletion/);
    assert.equal(f.findButton('Delete from Reader').disabled, true);
    f.findButton('Refresh summary').click(); await tick();
    assert.equal(f.findButton('Delete from Reader').disabled, false); assert.match(f.byClass('summary').textContent, /beta/);
  }
});

test('Refresh after a successful hover deletion removes stale success when Reader returns a saved document', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
  assert.equal(f.deleted, 1);
  f.findButton('Refresh summary').click(); await tick();
  assert.equal(f.byClass('popover').children.at(-1).textContent, 'Saved in Reader');
  assert.match(f.byClass('summary').textContent, /beta/);
});

test('recycled card during confirmation or pending deletion cannot delete the replacement or display late success', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click(); f.setTarget({ videoUrl: A });
  f.findButton('Delete document').fire('click'); await tick(); assert.equal(f.messages.length, 1);
  const pending = fixture(); let release;
  pending.responder = (message, normal) => message.type === 'reader-card-delete' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  await pending.hover(); pending.findButton('Delete from Reader').click(); pending.findButton('Delete document').click();
  pending.setTarget({ videoUrl: A }); await pending.hover(); release(); await tick();
  assert.equal(pending.deleted, 0); assert.match(pending.byClass('summary').textContent, /alpha/);
});

test('errors, absent summaries, changed documents and theme/cache invalidation remain explicit', async () => {
  const f = fixture(); f.responder = () => ({ ok: false, code: 'rate_limited', retryAt: 160000 }); await f.hover();
  assert.match(f.byClass('summary').textContent, /rate limit/); f.api.close(); await f.hover(); assert.equal(f.messages.length, 1);
  f.change({ readerToken: { newValue: 'changed-fixture' } }); assert.equal(f.host.hidden, true);
  f.responder = (message, normal) => message.type === 'reader-card-delete' ? { ok: false, code: 'delete_conflict' } : normal(); await f.hover();
  f.findButton('Delete from Reader').click(); f.findButton('Delete document').click(); await tick();
  assert.match(f.byClass('summary').textContent, /changed since the confirmation/); assert.equal(f.findButton('Delete from Reader').disabled, true);
  f.change({ readerPanelTheme: { newValue: 'dark' } }); assert.equal(f.host.dataset.theme, 'dark');
  f.change({ readerPanelTheme: { newValue: 'system' } }); f.media.matches = true; f.media.change(); assert.equal(f.host.dataset.theme, 'dark');
});

test('transient card-context errors are not cached across fresh hover intent', async () => {
  const f = fixture(); f.responder = () => ({ ok: false, code: 'invalid_sender' }); await f.hover();
  f.api.close(); f.responder = (message, normal) => normal(); await f.hover();
  assert.equal(f.messages.length, 2); assert.match(f.byClass('summary').textContent, /beta/);
});

test('a not-ready summary is explicit, briefly cached and never polls or regenerates Reader content', async () => {
  const f = fixture(); f.responder = (message, normal) => {
    const reply = normal(); reply.document.summary = ''; return reply;
  };
  await f.hover(); assert.match(f.byClass('summary').textContent, /Summary not available yet/);
  f.api.close(); await f.hover(); assert.equal(f.messages.length, 1);
  f.api.close(); f.advance(15001); assert.equal(f.messages.length, 1);
  await f.hover(); assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every(message => message.type === 'reader-card-get'));
});

test('position computation clamps above/below the icon inside a narrow viewport', async () => {
  const f = fixture({ width: 280, height: 210 }); await f.hover();
  assert.equal(f.host.style.left, '8px'); assert.equal(f.host.style.top, '8px');
});

test('summary cache evicts old entries after fifty videos', async () => {
  const f = fixture();
  for (let i = 0; i < 51; i++) { f.api.close(); f.setTarget({ videoUrl: `https://www.youtube.com/watch?v=card${i}` }); await f.hover(); }
  assert.equal(f.messages.length, 51);
  f.api.close(); f.setTarget({ videoUrl: 'https://www.youtube.com/watch?v=card0' }); await f.hover();
  assert.equal(f.messages.length, 52);
});

test('storage changes invalidate cached deletion confirmations while credential changes close the preview', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click();
  f.change({ readerDocuments: { oldValue: { [B]: { id: 'doc-beta' } }, newValue: {} } });
  assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.findButton('Delete from Reader').disabled, true);
  f.findButton('Refresh summary').click(); await tick(); assert.equal(f.messages.length, 2);
  f.change({ readerToken: { newValue: 'fixture' } }); assert.equal(f.host.hidden, true);
});

test('a discovery lookup’s late own cache-link event and unrelated saves cannot erase the loaded summary', async () => {
  const f = fixture(); await f.hover();
  f.change({ readerDocuments: { oldValue: {}, newValue: { [B]: { id: 'doc-beta' } } } });
  assert.match(f.byClass('summary').textContent, /beta/); assert.equal(f.findButton('Delete from Reader').disabled, false);
  f.change({ readerSavedUrls: { oldValue: { [B]: 1 }, newValue: { [B]: 1, [A]: 2 } } });
  assert.match(f.byClass('summary').textContent, /beta/); assert.equal(f.findButton('Delete from Reader').disabled, false);
});

test('location updates invalidate only the matching saved-card summary and stale delete confirmation', async () => {
  const f = fixture(); await f.hover(); f.findButton('Delete from Reader').click();
  f.change({ readerDocumentUpdates: { newValue: { id: 'doc-alpha', videoUrl: A, location: 'shortlist', updatedAt: 'v2' } } });
  assert.equal(f.byClass('confirmation').hidden, false);
  f.change({ readerDocumentUpdates: { newValue: { id: 'doc-beta', videoUrl: B, location: 'archive', updatedAt: 'v2' } } });
  assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.findButton('Delete from Reader').disabled, true);
  assert.match(f.byClass('summary').textContent, /Reader changed/); assert.equal(f.messages.length, 1);
  f.findButton('Refresh summary').click(); await tick(); assert.equal(f.messages.length, 2);
  assert.equal(f.findButton('Delete from Reader').disabled, false);
});

test('actual card resolver accepts surfaces and aliases, rejects ambiguous/recycled links and never falls back to watch URL', () => {
  const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const helper = content.match(/  const getReaderCardTarget = \(\) => \{[\s\S]*?\n  \};/)[0];
  for (const surface of ['ytd-rich-grid-media', 'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer', 'yt-lockup-view-model']) {
    let links = [{ href: B }, { href: B + '&t=12' }];
    const source = { isConnected: true, querySelectorAll: () => links };
    const context = { globalThis: null, activeMode: 'card', settings: { showReader: true }, panel: { dataset: { visible: 'true' } },
      getVideoCardContainer: () => source, getCurrentContextSource: () => source, getAssociatedTitle: () => surface,
      getAssociatedPageUrl: () => links[0]?.href, readerButton: { dataset: { readerSaved: 'true' } },
      readerSavedUrlCache: new Map([[B, true]]), normalizeYouTubeStateUrl: C.canonical, MVSReaderCore: C };
    context.readerStateKey = C.canonical;
    context.globalThis = context; vm.runInNewContext(helper + '\nglobalThis.resolveCard = getReaderCardTarget;', context);
    assert.equal(context.resolveCard().videoUrl, B); assert.equal(context.resolveCard().saved, true);
    links.push({ href: A }); assert.equal(context.resolveCard(), null);
    links = []; assert.equal(context.resolveCard(), null);
    links = [{ href: 'https://youtu.be/beta?t=2' }]; assert.equal(context.resolveCard().videoUrl, B);
    context.activeMode = 'player'; assert.equal(context.resolveCard(), null);
  }
});

test('actual overlay idle hide preserves keyboard focus and an active Reader preview', () => {
  const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const helper = content.match(/  const hidePanelForIdle = \(\) => \{[\s\S]*?\n  \};/)[0];
  let preview = false;
  const context = { shadowRoot: { activeElement: {} }, readerCardPreview: { isActive: () => preview },
    clearIdleHideTimer() {}, clearFeedback() {}, hideHoverZoneHint() {}, panel: { dataset: { visible: 'true' }, setAttribute() {} } };
  vm.runInNewContext(helper + '\nglobalThis.hide = hidePanelForIdle;', context);
  context.hide(); assert.equal(context.panel.dataset.visible, 'true');
  context.shadowRoot.activeElement = null; preview = true; context.hide(); assert.equal(context.panel.dataset.visible, 'true');
  preview = false; context.hide(); assert.equal(context.panel.dataset.visible, 'false');
});

test('saved-card Cmd-click skips confirmation, holds focus through pending preflight, and verifies one exact mock DELETE', async () => {
  const f = fixture({ nativeEvents: true }); let present = true, reads = 0, release;
  const raw = () => ({ id: 'doc-beta', source_url: B, title: 'Fixture video', summary: 'Fixture summary', notes: 'Saved note', updated_at: 'v1' });
  const worker = connectWorker(f, (url, init) => {
    if (init.method === 'DELETE') { present = false; return { status: 204 }; }
    if (++reads === 2) return new Promise(resolve => { release = () => resolve({ results: [raw()] }); });
    return { results: present ? [raw()] : [] };
  });
  await f.hover(); f.userClick(f.findButton('Delete from Reader'), { metaKey: true }); await tick();
  assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.findButton('Delete from Reader').disabled, true);
  f.findButton('Delete from Reader').fire('click', { metaKey: true }); f.findButton('Delete document').fire('click');
  f.run(180); assert.equal(f.host.hidden, false); assert.equal(f.messages.filter(m => m.type === 'reader-card-delete').length, 1);
  release(); await tick();
  assert.equal(worker.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(worker.requests.find(r => r.method === 'DELETE').url, 'https://readwise.io/api/v3/delete/doc-beta/');
  assert.equal(f.deleted, 1); assert.match(f.byClass('summary').textContent, /^Deleted from Reader/);
});

test('saved-card Cmd-click failures retain visible errors without retrying or marking deletion', async () => {
  for (const code of ['unauthorized', 'delete_uncertain', 'delete_conflict']) {
    const f = fixture(); await f.hover();
    f.responder = (message, normal) => message.type === 'reader-card-delete' ? { ok: false, code } : normal();
    f.findButton('Delete from Reader').fire('click', { metaKey: true }); await tick();
    assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.deleted, 0); assert.equal(f.findButton('Delete from Reader').disabled, true);
    assert.equal(f.messages.filter(m => m.type === 'reader-card-delete').length, 1); assert.ok(f.byClass('summary').textContent);
  }
});

test('saved-card Ctrl/Alt/Shift alone preserve confirmation and cancelling never deletes', async () => {
  for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
    const f = fixture(); await f.hover(); f.findButton('Delete from Reader').fire('click', modifiers);
    assert.equal(f.byClass('confirmation').hidden, false); f.findButton('Cancel').click(); await tick();
    assert.equal(f.byClass('confirmation').hidden, true); assert.equal(f.messages.filter(m => m.type === 'reader-card-delete').length, 0);
  }
});

test('new-save pending hover updates in place on summary readiness without another user hover', async () => {
  const f = fixture(); f.responder = () => ({ ok: true, document: null, summaryState: 'pending' });
  await f.hover(); assert.match(f.byClass('summary').textContent, /preparing.*automatically/);
  assert.equal(f.byClass('summary').className.includes('error'), false);
  f.responder = (message, normal) => normal();
  f.change({ readerSummaryJobs: { oldValue: { [B]: { status: 'pending' } }, newValue: { [B]: { id: 'doc-beta', status: 'ready' } } } }); await tick();
  assert.match(f.byClass('summary').textContent, /Summary https:/); assert.equal(f.host.hidden, false); assert.equal(f.messages.length, 2);
});
test('summary readiness after card navigation cannot reopen or overwrite the current preview', async () => {
  const f = fixture(); await f.hover(); f.navigate('https://www.youtube.com/feed/library');
  f.change({ readerSummaryJobs: { newValue: { [B]: { status: 'ready' } } } }); await tick();
  assert.equal(f.host.hidden, true); assert.equal(f.messages.length, 1);
});
