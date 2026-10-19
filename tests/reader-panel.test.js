// Execute the real panel controller against a small DOM/editor fixture. No browser,
// extension installation, network, OS clipboard or live Reader credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = 'https://www.youtube.com/watch?v=alpha';
const B = 'https://www.youtube.com/watch?v=beta';
const D = 'https://www.youtube.com/watch?v=gamma';
const tick = () => new Promise(setImmediate);

test('card deletion cache changes preserve that video’s dirty note and leave other video drafts intact', async () => {
  const f = fixture(); await f.open(); f.edit('Keep A'); f.navigate(B); await tick(); f.edit('Keep deleted B');
  f.docs.delete('doc-b');
  f.change({ readerDocuments: { oldValue: { [A]: { id: 'doc-a' }, [B]: { id: 'doc-b' } }, newValue: { [A]: { id: 'doc-a' } } } });
  assert.equal(f.value, 'Keep deleted B'); assert.equal(f.button('Save note').disabled, true);
  f.navigate(A); await tick(); assert.equal(f.value, 'Keep A');
  f.navigate(B); await tick(); assert.equal(f.value, 'Keep deleted B'); assert.equal(f.button('Save note').disabled, true);
});

function fixture({ url = A, width = 1100, height = 900 } = {}) {
  const events = new Map(), timers = new Map(), storageListeners = [], messages = [];
  let timerId = 0, active, editor, input, escape, responder, clock = 100000;
  class ClockDate extends Date { static now() { return clock; } }
  class Node {
    constructor(tag = '') { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false; this.textContent = ''; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener(key, fn) { this.listeners.set(key, [...(this.listeners.get(key) || []), fn]); }
    fire(key, extra = {}) { const event = { key: '', preventDefault() { this.prevented = true; }, stopPropagation() {}, composedPath: () => [this], ...extra }; for (const fn of this.listeners.get(key) || []) fn(event); return event; }
    click() { if (!this.disabled && !this.hidden) this.fire('click'); }
    focus() { active = this; }
    blur() { if (active === this) active = null; }
    attachShadow() { this.shadowRoot = new Node('shadow'); return this.shadowRoot; }
    get activeElement() { return active; }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
    getBoundingClientRect() { return { x: 0, y: 40, left: 0, top: 40, width: 390, height: 230 }; }
    hasPointerCapture() { return false; }
    matches() { return false; }
  }
  const document = { documentElement: new Node('html'), fullscreenElement: null,
    createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    addEventListener(type, fn) { events.set(type, [...(events.get(type) || []), fn]); } };
  const location = { href: url, pathname: new URL(url).pathname };
  const docs = new Map([['doc-a', { id: 'doc-a', videoUrl: A, title: 'Attention and learning', summary: 'Summary A', notes: 'Original A', location: 'later', tags: ['Learning'], updatedAt: 'v1' }],
    ['doc-b', { id: 'doc-b', videoUrl: B, title: 'Video B', summary: 'Summary B', notes: 'Original B', location: 'archive', tags: [], updatedAt: 'v1' }],
    ['doc-c', { id: 'doc-c', videoUrl: D, title: 'Video C', summary: 'Summary C', notes: 'Original C', location: 'shortlist', tags: [], updatedAt: 'v1' }]]);
  const context = { URL, console, Date: ClockDate, Element: Node, location, document, innerWidth: width, innerHeight: height,
    MutationObserver: class { observe() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(type, fn) { events.set(`window:${type}`, [...(events.get(`window:${type}`) || []), fn]); },
    MVSReaderEditor: { create(options) {
      input = options.onInput; escape = options.onEscape;
      editor = { frame: new Node('iframe'), value: '', mount() {}, setTheme() {} }; return editor;
    } },
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      messages.push(message);
      const normal = () => {
        const doc = [...docs.values()].find(doc => doc.videoUrl === message.pageUrl);
        if (message.type === 'reader-panel-get') return { ok: true, document: doc ? { ...doc } : null };
        if (message.type === 'reader-panel-save-note') { doc.notes = message.notes; return { ok: true, id: message.id, notes: message.notes }; }
        if (message.type === 'reader-panel-move') { doc.location = message.location; doc.updatedAt = 'v2'; return { ok: true, document: { ...doc } }; }
        if (message.type === 'reader-panel-delete') { docs.delete(message.id); return { ok: true, id: message.id }; }
        if (['open-options', 'open-watch-list'].includes(message.type)) return { ok: true };
        throw new Error(`Unexpected action: ${message.type}`);
      };
      Promise.resolve(responder ? responder(message, normal) : normal()).then(callback);
    } }, storage: { local: { get(defaults, callback) { callback({ ...defaults, showReaderPanel: true }); } },
      onChanged: { addListener(fn) { storageListeners.push(fn); } } } },
  };
  context.window = context; context.top = context;
  vm.createContext(context);
  for (const name of ['reader-core.js', 'reader-peek.js', 'reader-panel.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  const all = node => [node, ...node.children.flatMap(all), ...(node.shadowRoot ? all(node.shadowRoot) : [])];
  const nodes = () => all(document.documentElement);
  const byClass = name => nodes().find(n => (n.attrs.class || '').split(' ').includes(name));
  const button = name => nodes().find(n => n.tagName === 'button' && (n.attrs['aria-label'] === name || n.textContent === name));
  const fire = (type, extra = {}) => (events.get(type) || []).forEach(fn => fn({ composedPath: () => [], preventDefault() {}, stopPropagation() {}, ...extra }));
  return { messages, docs, button, byClass, byId: id => nodes().find(n => n.attrs.id === id), get active() { return active; }, get value() { return editor.value; },
    set responder(fn) { responder = fn; },
    async open() { if (byClass('body').hidden) byClass('toggle').click(); await tick(); },
    trash() { byClass('location').click(); button('Delete from Reader').click(); },
    move(value) { byClass('location').click(); button(value).click(); },
    async hover() { byClass('toggle').fire('pointerenter'); this.runTimers(300); await tick(); },
    advance(ms) { clock += ms; },
    hide() { document.hidden = true; fire('visibilitychange'); },
    runTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    event: fire,
    edit(value) { editor.value = value; input(value); }, escape() { escape(); },
    change(values) { storageListeners.forEach(fn => fn(values, 'local')); },
    navigate(url, sync = true) {
      location.href = url; location.pathname = new URL(url).pathname;
      if (sync) { fire('yt-navigate-finish'); for (const [id, timer] of timers) if (timer.delay === 150) { timers.delete(id); timer.fn(); } }
    },
  };
}

test('delete is a separate confirmation naming exact document; Cancel and Escape preserve drafts without sending', async () => {
  const f = fixture(); await f.open(); f.edit('Keep local A');
  f.trash();
  assert.equal(f.byClass('delete-confirm').hidden, false);
  assert.equal(f.byClass('delete-title').textContent, 'Attention and learning');
  assert.match(f.byClass('delete-identity').textContent, /alpha.*doc-a/);
  assert.match(f.byClass('delete-confirm').children.find(n => n.attrs.id === 'reader-delete-effects').textContent, /highlights and their notes.*cannot undo/);
  assert.match(f.byClass('delete-confirm').children.find(n => n.attrs.id === 'reader-delete-draft').textContent, /unsaved local note will stay/);
  assert.equal(f.active, f.button('Cancel')); assert.equal(f.button('Save note').disabled, true);
  f.button('Cancel').click(); assert.equal(f.value, 'Keep local A'); assert.equal(f.active, f.byClass('location'));
  f.trash(); f.escape();
  assert.equal(f.byClass('delete-confirm').hidden, true); assert.equal(f.byClass('body').hidden, false);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 0);
});

test('a closed panel binds the new URL on opening before YouTube navigation events arrive', async () => {
  const f = fixture(); await f.open(); f.button('Close Reader').click();
  f.navigate(B, false); await f.open();
  assert.equal(f.messages.at(-1).pageUrl, B); assert.equal(f.byClass('summary').textContent, 'Summary B');
});

test('an open panel follows committed video navigation and refreshes without closing or reloading', async () => {
  const f = fixture(); await f.open(); f.navigate(B); await tick();
  assert.equal(f.byClass('body').hidden, false); assert.equal(f.byClass('summary').textContent, 'Summary B');
  assert.equal(f.messages.at(-1).pageUrl, B);
});

test('closed navigation performs no reads until opening and supports Home-to-video without a reload', async () => {
  const f = fixture({ url: 'https://www.youtube.com/' });
  assert.equal(f.byClass('toggle'), undefined); f.navigate(B); await tick();
  assert.equal(f.byClass('body').hidden, true); assert.equal(f.messages.length, 0);
  await f.open(); assert.equal(f.byClass('summary').textContent, 'Summary B');
  f.button('Close Reader').click(); f.navigate(D); await tick();
  assert.equal(f.messages.length, 1); await f.open(); assert.equal(f.byClass('summary').textContent, 'Summary C');
});

test('rapid A-B-C and late replies, including an old A reply after returning to A, cannot replace the current visit', async () => {
  const f = fixture(); const replies = [];
  f.responder = (message, normal) => new Promise(resolve => replies.push(() => resolve(normal())));
  f.byClass('toggle').click(); f.navigate(B); f.navigate(D);
  assert.deepEqual(f.messages.map(m => m.pageUrl), [A, B, D]);
  replies[2](); await tick(); assert.equal(f.byClass('summary').textContent, 'Summary C');
  replies[1](); await tick(); assert.equal(f.byClass('summary').textContent, 'Summary C');
  f.navigate(A); assert.equal(f.messages.length, 4);
  f.docs.get('doc-a').summary = 'Fresh return to A'; replies[3](); await tick();
  f.docs.get('doc-a').summary = 'Stale original visit'; replies[0](); await tick();
  assert.equal(f.byClass('summary').textContent, 'Fresh return to A');
  assert.notEqual(f.messages[0].visit, f.messages[3].visit);
});

test('timestamp, hash, duplicate finish and page-data events preserve the same video and draft without refetching', async () => {
  const f = fixture(); await f.open(); f.edit('Draft A');
  f.navigate(A + '&t=42#chapter'); f.event('yt-page-data-updated'); f.event('yt-navigate-finish'); await tick();
  assert.equal(f.messages.length, 1); assert.equal(f.value, 'Draft A'); assert.equal(f.byClass('body').hidden, false);
  f.navigate(B); await tick(); f.edit('Draft B'); f.navigate(A); await tick();
  assert.equal(f.value, 'Draft A'); f.navigate(B); await tick(); assert.equal(f.value, 'Draft B');
});

test('an in-flight reply observes a changed URL even when the SPA event has not fired', async () => {
  const f = fixture(); let release;
  f.responder = (message, normal) => message.pageUrl === A ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  f.byClass('toggle').click(); f.navigate(B, false); release(); await tick();
  assert.equal(f.byClass('summary').textContent, 'Summary B'); assert.equal(f.messages.at(-1).pageUrl, B);
});

test('a transient stale-tab rejection retries only the read once and never caches failure as loaded', async () => {
  const f = fixture(); let count = 0;
  f.responder = (message, normal) => ++count === 1 ? { ok: false, code: 'invalid_sender' } : normal();
  await f.open(); assert.equal(f.byClass('status').dataset.kind, 'info');
  f.runTimers(250); await tick(); assert.equal(count, 2); assert.equal(f.byClass('summary').textContent, 'Summary A');
  f.button('Close Reader').click(); await f.open(); assert.equal(count, 2);
  const stuck = fixture(); stuck.responder = () => ({ ok: false, code: 'invalid_sender' });
  await stuck.open(); stuck.runTimers(250); await tick(); stuck.runTimers(250); await tick();
  assert.equal(stuck.messages.length, 2); assert.equal(stuck.byClass('status').dataset.kind, 'error');
  stuck.responder = (message, normal) => normal(); stuck.button('Close Reader').click(); await stuck.open();
  assert.equal(stuck.byClass('summary').textContent, 'Summary A'); assert.equal(stuck.messages.length, 3);
});

test('a pending read retry is cancelled by navigation or closing and never retries offline/rate errors', async () => {
  for (const close of [true, false]) {
    const f = fixture(); f.responder = () => ({ ok: false, code: 'invalid_sender' }); await f.open();
    if (close) f.button('Close Reader').click(); else { f.responder = (message, normal) => normal(); f.navigate(B); }
    f.runTimers(250); await tick(); assert.equal(f.messages.filter(m => m.pageUrl === A).length, 1);
  }
  for (const code of ['network_error', 'rate_limited', 'unauthorized']) {
    const f = fixture(); f.responder = () => ({ ok: false, code }); await f.open(); f.runTimers(250); await tick();
    assert.equal(f.messages.length, 1); assert.equal(f.byClass('status').dataset.kind, 'error');
  }
});

test('old note-save clicks and deletion confirmations never retarget the new video before its SPA event', async () => {
  const f = fixture(); await f.open(); f.edit('Draft A'); f.navigate(B, false);
  f.button('Save note').click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-save-note').length, 0); assert.equal(f.value, 'Original B');
  f.navigate(A); await tick(); assert.equal(f.value, 'Draft A');
  f.trash(); f.navigate(B, false); f.button('Delete document').click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 0); assert.equal(f.byClass('delete-confirm').hidden, true);
  assert.equal(f.value, 'Original B');
});

test('accepted pending saves stay bound to A while newer A edits and B drafts survive navigation', async () => {
  const f = fixture(); await f.open(); f.edit('Sent A'); let release;
  f.responder = (message, normal) => message.type === 'reader-panel-save-note' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  f.button('Save note').click(); f.edit('Newer A'); f.navigate(B); await tick(); f.edit('Draft B');
  release(); await tick(); assert.equal(f.value, 'Draft B'); f.navigate(A); await tick();
  assert.equal(f.value, 'Newer A'); assert.match(f.byClass('footer').children[1].textContent, /Unsaved draft/);
  const sent = f.messages.find(m => m.type === 'reader-panel-save-note'); assert.equal(sent.pageUrl, A); assert.equal(sent.id, 'doc-a');
});

test('browser back/forward and page-data events rebind immediately without polling', async () => {
  const f = fixture(); await f.open();
  f.navigate(B, false); f.event('window:popstate'); await tick(); assert.equal(f.byClass('summary').textContent, 'Summary B');
  f.navigate(A, false); f.event('yt-page-data-updated'); await tick(); assert.equal(f.byClass('summary').textContent, 'Summary A');
  assert.equal(f.messages.length, 3);
});

test('confirmed deletion shows unsaved state, removes stale content and never automatically saves again', async () => {
  const f = fixture(); await f.open();
  f.trash(); f.button('Delete document').click(); await tick();
  assert.equal(f.button('Delete from Reader').disabled, true); assert.equal(f.button('Save note').disabled, true);
  assert.equal(f.byClass('summary').parentElement.parentElement.hidden, true);
  assert.match(f.byClass('status').textContent, /Deleted from Reader/); assert.equal(f.value, '');
  const deletion = f.messages.find(m => m.type === 'reader-panel-delete');
  assert.equal(deletion.pageUrl, A); assert.equal(deletion.id, 'doc-a'); assert.equal(deletion.confirmed, true);
  assert.equal(deletion.baseNotes, 'Original A'); assert.equal(deletion.updatedAt, 'v1');
  assert.ok(f.messages.every(m => ['reader-panel-get', 'reader-panel-delete'].includes(m.type)));
});

test('dirty notes survive deletion and later replacement requires conflict review', async () => {
  const f = fixture(); await f.open(); f.edit('Preserve draft');
  f.trash(); f.button('Delete document').click(); await tick();
  assert.equal(f.value, 'Preserve draft'); assert.equal(f.button('Save note').disabled, true);
  assert.match(f.byClass('status').textContent, /unsaved note is kept/);
  f.docs.set('replacement', { id: 'replacement', videoUrl: A, title: 'Again', notes: 'Replacement note', tags: [] });
  f.button('Refresh').click(); await tick();
  assert.equal(f.value, 'Preserve draft'); assert.equal(f.byClass('conflict').hidden, false);
  assert.equal(f.button('Save note').disabled, true);
});

test('SPA navigation cancels confirmation and guards the URL even before navigation synchronization', async () => {
  const f = fixture(); await f.open(); f.trash();
  f.navigate(B, false); f.button('Delete document').click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 0);
  f.navigate(B); await f.open();
  assert.equal(f.byClass('delete-confirm').hidden, true); assert.equal(f.value, 'Original B');
  f.navigate(A); await f.open(); assert.equal(f.byClass('delete-confirm').hidden, true);
});

test('late delete response updates only captured video and keeps edits typed during request', async () => {
  const f = fixture(); await f.open(); f.edit('A draft');
  let release;
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  f.trash(); f.button('Delete document').click();
  f.edit('Newer A draft'); f.navigate(B); await f.open();
  release(); await tick(); assert.equal(f.value, 'Original B'); assert.equal(f.button('Delete from Reader').disabled, false);
  f.navigate(A); await f.open(); assert.equal(f.value, 'Newer A draft'); assert.equal(f.button('Save note').disabled, true);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 1);
});

test('failed or stale deletion never reports success; changed document requires a fresh confirmation', async () => {
  for (const code of ['unauthorized', 'rate_limited', 'network_error', 'delete_uncertain', 'delete_cache_error', 'document_changed']) {
    const f = fixture(); await f.open(); f.edit('Keep on failure');
    f.responder = (message, normal) => message.type === 'reader-panel-delete' ? { ok: false, code } : normal();
    f.trash(); f.button('Delete document').click(); await tick();
    assert.equal(f.value, 'Keep on failure'); assert.equal(f.byClass('status').dataset.kind, 'error');
    assert.doesNotMatch(f.byClass('status').textContent, /^Deleted from Reader/);
    assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 1);
  }
  const f = fixture(); await f.open(); f.edit('Local draft');
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? { ok: false, code: 'delete_conflict',
    document: { ...f.docs.get('doc-a'), notes: 'Changed remotely' } } : normal();
  f.trash(); f.button('Delete document').click(); await tick();
  assert.equal(f.value, 'Local draft'); assert.match(f.byClass('status').textContent, /changed since the confirmation/);
  assert.equal(f.byClass('delete-confirm').hidden, true);
  f.trash(); assert.equal(f.byClass('delete-confirm').hidden, false);
});

test('credentials changed during deletion invalidate late replies without discarding local draft', async () => {
  const f = fixture(); await f.open(); f.edit('Private draft');
  let release;
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? new Promise(resolve => { release = () => resolve({ ok: true, id: message.id }); }) : normal();
  f.trash(); f.button('Delete document').click();
  f.change({ readerToken: { newValue: 'different account' } }); release(); await tick();
  assert.equal(f.value, 'Private draft'); assert.doesNotMatch(f.byClass('status').textContent, /^Deleted from Reader/);
  assert.equal(f.button('Delete from Reader').disabled, true);
});

test('deletion in another tab invalidates the visible identity and confirmation while preserving its draft', async () => {
  const f = fixture(); await f.open(); f.edit('Keep in this tab');
  f.trash();
  f.change({ readerDocuments: { oldValue: { [A]: { id: 'doc-a' } }, newValue: {} } });
  assert.equal(f.value, 'Keep in this tab'); assert.equal(f.byClass('delete-confirm').hidden, true);
  assert.equal(f.button('Save note').disabled, true); assert.equal(f.button('Delete from Reader').disabled, true);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 0);
});

test('confirmation renders hostile document titles as text and already-absent replies are distinct from deletion', async () => {
  const f = fixture(); f.docs.get('doc-a').title = '<img src=x onerror=alert(1)><script>bad()</script>';
  await f.open(); f.trash();
  assert.equal(f.byClass('delete-title').textContent, f.docs.get('doc-a').title);
  assert.equal(f.byClass('delete-title').children.length, 0);
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? { ok: true, id: message.id, alreadyDeleted: true } : normal();
  f.button('Delete document').click(); await tick();
  assert.match(f.byClass('status').textContent, /already absent/); assert.doesNotMatch(f.byClass('status').textContent, /^Deleted from Reader/);
});

test('a lookup can deliver a replacement after it invalidates the stale cache entry', async () => {
  const f = fixture(); await f.open(); f.edit('Draft for original');
  let release;
  f.responder = message => new Promise(resolve => { release = () => resolve({ ok: true,
    document: { id: 'replacement', videoUrl: A, title: 'New document', notes: 'Replacement note', tags: [] } }); });
  f.button('Refresh').click();
  f.change({ readerDocuments: { oldValue: { [A]: { id: 'doc-a' } }, newValue: {} } });
  release(); await tick();
  assert.equal(f.value, 'Draft for original'); assert.equal(f.byClass('conflict').hidden, false);
  assert.equal(f.byClass('remote').textContent, 'Replacement note');
  assert.equal(f.button('Delete from Reader').disabled, false);
});

test('location control follows Note and precedes tags; overflow contains readable Open in Reader and Options', async () => {
  const f = fixture(); await f.open();
  const header = f.byClass('header'), location = f.byClass('location'), tags = f.byClass('tag-toggle');
  assert.ok(header.children.indexOf(location) > header.children.indexOf(f.byClass('tabs')));
  assert.ok(header.children.indexOf(location) < header.children.indexOf(tags));
  assert.equal(f.byClass('location-label').textContent, 'Later');
  assert.equal(f.button('Delete from Reader').parentElement, f.byId('reader-location-menu'));
  assert.equal(f.byId('reader-location-menu').hidden, true);
  f.button('More Reader actions').click();
  assert.equal(f.byId('reader-more-menu').hidden, false); assert.equal(f.active.textContent, 'Open in Reader');
  assert.equal(f.active.href, 'https://read.readwise.io/read/doc-a');
  assert.equal(f.button('Extension options').textContent, 'Options');
  f.button('Extension options').click(); await tick();
  assert.equal(f.messages.at(-1).type, 'open-options'); assert.equal(f.byId('reader-more-menu').hidden, true);
  f.button('More Reader actions').click(); f.button('Recent saves').click(); await tick();
  assert.equal(f.messages.at(-1).type, 'open-watch-list'); assert.equal(f.byId('reader-more-menu').hidden, true);
});

test('location and overflow menus support arrow/Home/End, Escape, Tab and outside dismissal', async () => {
  const f = fixture(); await f.open();
  f.byClass('location').fire('keydown', { key: 'ArrowDown' });
  const menu = f.byId('reader-location-menu'); assert.equal(f.active, f.button('Later'));
  menu.fire('keydown', { key: 'ArrowDown' }); assert.equal(f.active, f.button('Shortlist'));
  menu.fire('keydown', { key: 'End' }); assert.equal(f.active, f.button('Delete from Reader'));
  menu.fire('keydown', { key: 'Home' }); assert.equal(f.active, f.button('Later'));
  f.event('keydown', { key: 'Escape' }); assert.equal(menu.hidden, true); assert.equal(f.active, f.byClass('location'));
  assert.equal(f.byClass('body').hidden, false);
  f.byClass('location').click(); menu.fire('keydown', { key: 'Tab' });
  assert.equal(menu.hidden, true); assert.equal(f.active, f.button('Refresh'));
  f.button('More Reader actions').fire('keydown', { key: 'ArrowUp' });
  assert.equal(f.active, f.button('Recent saves'));
  f.event('pointerdown'); assert.equal(f.byId('reader-more-menu').hidden, true);
  assert.equal(f.byClass('body').hidden, true);
});

test('moving while editing changes only location and keeps the selected Note tab and newer draft', async () => {
  const f = fixture(); await f.open(); f.button('Note').click(); f.edit('Before move');
  let release;
  f.responder = (message, normal) => message.type === 'reader-panel-move' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  f.move('Shortlist'); f.edit('Typed during move');
  assert.equal(f.byClass('location').disabled, true); release(); await tick();
  assert.equal(f.value, 'Typed during move'); assert.equal(f.button('Note').attrs['aria-selected'], 'true');
  assert.equal(f.byClass('location-label').textContent, 'Shortlist'); assert.equal(f.docs.get('doc-a').notes, 'Original A');
  const message = f.messages.find(m => m.type === 'reader-panel-move');
  assert.equal(message.id, 'doc-a'); assert.equal(message.pageUrl, A); assert.equal(message.baseLocation, 'later'); assert.equal(message.location, 'shortlist');
  assert.equal(message.notes, undefined); assert.equal(f.button('Save note').disabled, false);
  assert.match(f.byClass('footer').children[1].textContent, /Now in Shortlist/);
  f.runTimers(3000); assert.equal(f.byClass('footer').children[1].textContent, 'Unsaved draft');
});

test('a move readback with a remote note conflict preserves local edits and exposes the conflict', async () => {
  const f = fixture(); await f.open(); f.edit('Local draft');
  f.responder = (message, normal) => message.type === 'reader-panel-move'
    ? { ok: true, document: { ...f.docs.get('doc-a'), location: 'archive', notes: 'Remote changed note' } } : normal();
  f.move('Archive'); await tick();
  assert.equal(f.value, 'Local draft'); assert.equal(f.byClass('location-label').textContent, 'Archive');
  assert.equal(f.byClass('conflict').hidden, false); assert.equal(f.byClass('remote').textContent, 'Remote changed note');
  assert.equal(f.button('Save note').disabled, true);
});

test('fallback and conflicting locations are shown honestly; uncertain moves require Refresh and never retry', async () => {
  for (const [code, location] of [['location_conflict', 'archive'], ['location_not_applied', 'new']]) {
    const f = fixture(); await f.open(); f.edit('Preserved');
    f.responder = (message, normal) => message.type === 'reader-panel-move'
      ? { ok: false, code, document: { ...f.docs.get('doc-a'), location } } : normal();
    f.move('Shortlist'); await tick(); assert.equal(f.value, 'Preserved');
    assert.equal(f.byClass('location-label').textContent, location === 'new' ? 'Inbox / New' : 'Archive');
    assert.match(f.byClass('status').textContent, code === 'location_conflict' ? /location changed/ : /Reader kept Inbox/);
  }
  const f = fixture(); await f.open(); f.edit('Keep on timeout');
  f.responder = (message, normal) => message.type === 'reader-panel-move' ? { ok: false, code: 'location_uncertain' } : normal();
  f.move('Shortlist'); await tick(); f.runTimers(250); f.runTimers(3000);
  assert.equal(f.byClass('location-label').textContent, 'Unconfirmed'); assert.equal(f.byClass('location').disabled, true);
  assert.equal(f.value, 'Keep on timeout'); assert.equal(f.messages.filter(m => m.type === 'reader-panel-move').length, 1);
  f.button('Refresh').click(); await tick(); assert.equal(f.byClass('location-label').textContent, 'Later'); assert.equal(f.byClass('location').disabled, false);
});

test('unverified or wrong-target move replies never become a success', async () => {
  for (const patch of [{ id: 'wrong-id' }, { videoUrl: B }, { location: 'later' }]) {
    const f = fixture(); await f.open();
    f.responder = (message, normal) => message.type === 'reader-panel-move'
      ? { ok: true, document: { ...f.docs.get('doc-a'), location: 'shortlist', ...patch } } : normal();
    f.move('Shortlist'); await tick(); assert.equal(f.byClass('location-label').textContent, 'Unconfirmed');
    assert.match(f.byClass('status').textContent, /could not be confirmed/);
  }
});

test('SPA and credential changes guard captured location choices and late responses without losing drafts', async () => {
  const f = fixture(); await f.open(); f.edit('Draft A'); f.byClass('location').click();
  f.navigate(B, false); f.button('Archive').click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-move').length, 0);
  f.navigate(A); await tick(); let release;
  f.responder = (message, normal) => message.type === 'reader-panel-move' ? new Promise(resolve => { release = () => resolve(normal()); }) : normal();
  f.move('Shortlist'); f.navigate(B); await tick(); f.edit('Draft B'); release(); await tick();
  assert.equal(f.value, 'Draft B'); assert.equal(f.byClass('location-label').textContent, 'Archive');
  f.navigate(A); await tick(); assert.equal(f.value, 'Draft A'); assert.equal(f.byClass('location-label').textContent, 'Shortlist');
  f.move('Archive'); f.change({ readerToken: { newValue: 'different-fixture' } }); release(); await tick();
  assert.equal(f.value, 'Draft A'); assert.doesNotMatch(f.byClass('status').textContent, /Now in Archive/);
  assert.equal(f.byClass('location').disabled, true);
});

test('Trash in location menu still requires named confirmation, preserves drafts and performs no location PATCH', async () => {
  const f = fixture(); await f.open(); f.edit('Retain this note');
  f.trash(); assert.equal(f.active, f.button('Cancel')); assert.equal(f.messages.length, 1);
  assert.equal(f.byId('reader-location-menu').hidden, true);
  assert.equal(f.button('More Reader actions').disabled, true);
  f.button('Cancel').click(); assert.equal(f.value, 'Retain this note'); assert.equal(f.active, f.byClass('location'));
  f.trash(); f.button('Delete document').click(); await tick();
  assert.equal(f.value, 'Retain this note'); assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 1);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-move').length, 0);
});

test('launcher hover waits for intent, stays read-only and caches; clicking pins the normal panel', async () => {
  const f = fixture(); const toggle = f.byClass('toggle');
  toggle.fire('pointerenter'); toggle.fire('pointerleave'); f.runTimers(300); f.runTimers(180); await tick();
  assert.equal(f.messages.length, 0); await f.hover();
  assert.equal(f.byClass('peek').hidden, false); assert.equal(f.byClass('body').hidden, true);
  assert.equal(f.byClass('peek-summary').textContent, 'Summary A'); assert.equal(f.active, undefined);
  toggle.fire('pointerleave'); f.byClass('peek').fire('pointerenter'); f.runTimers(180);
  assert.equal(f.byClass('peek').hidden, false);
  toggle.click(); await tick(); toggle.fire('pointerleave'); f.runTimers(180);
  assert.equal(f.byClass('peek').hidden, true); assert.equal(f.byClass('body').hidden, false);
  assert.equal(f.messages.length, 1); assert.ok(f.messages.every(m => m.type === 'reader-panel-get'));
  f.button('Close Reader').click(); await f.hover(); assert.equal(f.messages.length, 1);
  f.byClass('peek').fire('pointerleave'); f.runTimers(180); assert.equal(f.byClass('peek').hidden, true);
});

test('temporary summary peek preserves the Note tab, selection of focus and dirty draft; normal click restores Note', async () => {
  const f = fixture(); await f.open(); f.button('Note').click(); f.edit('Private local draft'); f.button('Close Reader').click();
  const focus = f.active; await f.hover();
  assert.equal(f.value, 'Private local draft'); assert.equal(f.button('Note').attrs['aria-selected'], 'true'); assert.equal(f.active, focus);
  assert.equal(f.byClass('peek-summary').textContent, 'Summary A');
  f.event('keydown', { key: 'Escape' }); assert.equal(f.byClass('peek').hidden, true);
  assert.equal(f.byClass('body').hidden, true); assert.equal(f.value, 'Private local draft');
  await f.hover(); f.byClass('toggle').click(); await tick();
  assert.equal(f.value, 'Private local draft'); assert.equal(f.button('Note').attrs['aria-selected'], 'true');
  assert.equal(f.byClass('note-view').hidden, false);
});

test('peek navigation and visibility cancel late replies; hostile summary remains text', async () => {
  const f = fixture(); const replies = [];
  f.responder = (message, normal) => new Promise(resolve => replies.push(() => resolve(normal())));
  f.byClass('toggle').fire('pointerenter'); f.runTimers(300); f.navigate(B);
  f.byClass('toggle').fire('pointerenter'); f.runTimers(300); replies[0](); await tick();
  replies[1](); await tick(); assert.equal(f.byClass('peek-summary').textContent, 'Summary B');
  f.hide(); assert.equal(f.byClass('peek').hidden, true);
  const hostile = fixture(); const html = '<img src=x onerror=alert(1)><script>bad()</script>';
  hostile.docs.get('doc-a').summary = html; await hostile.hover();
  assert.equal(hostile.byClass('peek-summary').textContent, html); assert.equal(hostile.byClass('peek-summary').children.length, 0);
});

test('peek survives its own discovered-id publication but external identity changes invalidate it', async () => {
  const f = fixture(); f.responder = (message, normal) => {
    f.change({ readerDocuments: { oldValue: {}, newValue: { [A]: { id: 'doc-a' } } } }); return normal();
  };
  await f.hover(); assert.equal(f.byClass('peek').hidden, false); assert.equal(f.byClass('peek-summary').textContent, 'Summary A');
  f.change({ readerDocuments: { oldValue: { [A]: { id: 'doc-a' } }, newValue: {} } }); assert.equal(f.byClass('peek').hidden, true);
  f.responder = (message, normal) => normal(); await f.hover(); assert.equal(f.messages.length, 2);
  f.change({ readerToken: { newValue: 'other-fixture' } }); assert.equal(f.byClass('peek').hidden, true);
});

test('peek caches expire without polling and saved notes never reopen from an older cached note', async () => {
  const f = fixture(); await f.hover(); f.byClass('peek').fire('pointerleave'); f.runTimers(180);
  f.advance(60001); assert.equal(f.messages.length, 1); await f.hover(); assert.equal(f.messages.length, 2);
  f.byClass('toggle').click(); await tick(); f.button('Note').click(); f.edit('Saved new note');
  f.button('Save note').click(); await tick(); f.button('Close Reader').click(); await f.hover();
  f.byClass('toggle').click(); await tick(); assert.equal(f.value, 'Saved new note'); assert.equal(f.byClass('conflict').hidden, true);
});

test('reusing and pinning cached peeks cannot renew verified freshness or postpone missing-summary rechecks', async () => {
  for (const ready of [true, false]) {
    const f = fixture(); if (!ready) f.docs.get('doc-a').summary = '';
    await f.open(); f.button('Close Reader').click(); await f.hover();
    f.byClass('peek').fire('pointerleave'); f.runTimers(180);
    f.advance(ready ? 50000 : 10000); await f.hover(); f.byClass('toggle').click(); await tick();
    f.button('Close Reader').click(); f.advance(ready ? 10001 : 5001); await f.hover();
    assert.equal(f.messages.filter(m => m.type === 'reader-panel-get').length, 2);
  }
});
