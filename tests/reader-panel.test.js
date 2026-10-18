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

function fixture({ url = A } = {}) {
  const events = new Map(), timers = new Map(), storageListeners = [], messages = [];
  let timerId = 0, active, editor, input, escape, responder;
  class Node {
    constructor(tag = '') { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false; this.textContent = ''; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener(key, fn) { this.listeners.set(key, [...(this.listeners.get(key) || []), fn]); }
    fire(key, extra = {}) { const event = { key: '', preventDefault() {}, stopPropagation() {}, composedPath: () => [this], ...extra }; for (const fn of this.listeners.get(key) || []) fn(event); }
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
  const docs = new Map([['doc-a', { id: 'doc-a', videoUrl: A, title: 'Attention and learning', summary: 'Summary A', notes: 'Original A', tags: ['Learning'], updatedAt: 'v1' }],
    ['doc-b', { id: 'doc-b', videoUrl: B, title: 'Video B', summary: 'Summary B', notes: 'Original B', tags: [], updatedAt: 'v1' }],
    ['doc-c', { id: 'doc-c', videoUrl: D, title: 'Video C', summary: 'Summary C', notes: 'Original C', tags: [], updatedAt: 'v1' }]]);
  const context = { URL, console, Date, Element: Node, location, document, innerWidth: 1100, innerHeight: 900,
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
        if (message.type === 'reader-panel-delete') { docs.delete(message.id); return { ok: true, id: message.id }; }
        throw new Error(`Unexpected action: ${message.type}`);
      };
      Promise.resolve(responder ? responder(message, normal) : normal()).then(callback);
    } }, storage: { local: { get(defaults, callback) { callback({ ...defaults, showReaderPanel: true }); } },
      onChanged: { addListener(fn) { storageListeners.push(fn); } } } },
  };
  context.window = context; context.top = context;
  vm.createContext(context);
  for (const name of ['reader-core.js', 'reader-panel.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  const all = node => [node, ...node.children.flatMap(all), ...(node.shadowRoot ? all(node.shadowRoot) : [])];
  const nodes = () => all(document.documentElement);
  const byClass = name => nodes().find(n => (n.attrs.class || '').split(' ').includes(name));
  const button = name => nodes().find(n => n.tagName === 'button' && (n.attrs['aria-label'] === name || n.textContent === name));
  const fire = (type, extra = {}) => (events.get(type) || []).forEach(fn => fn({ preventDefault() {}, stopPropagation() {}, ...extra }));
  return { messages, docs, button, byClass, get active() { return active; }, get value() { return editor.value; },
    set responder(fn) { responder = fn; },
    async open() { if (byClass('body').hidden) byClass('toggle').click(); await tick(); },
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
  f.button('Delete from Reader').click();
  assert.equal(f.byClass('delete-confirm').hidden, false);
  assert.equal(f.byClass('delete-title').textContent, 'Attention and learning');
  assert.match(f.byClass('delete-identity').textContent, /alpha.*doc-a/);
  assert.match(f.byClass('delete-confirm').children.find(n => n.attrs.id === 'reader-delete-effects').textContent, /highlights and their notes.*cannot undo/);
  assert.match(f.byClass('delete-confirm').children.find(n => n.attrs.id === 'reader-delete-draft').textContent, /unsaved local note will stay/);
  assert.equal(f.active, f.button('Cancel')); assert.equal(f.button('Save note').disabled, true);
  f.button('Cancel').click(); assert.equal(f.value, 'Keep local A'); assert.equal(f.active, f.button('Delete from Reader'));
  f.button('Delete from Reader').click(); f.escape();
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
  f.button('Delete from Reader').click(); f.navigate(B, false); f.button('Delete document').click(); await tick();
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
  f.button('Delete from Reader').click(); f.button('Delete document').click(); await tick();
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
  f.button('Delete from Reader').click(); f.button('Delete document').click(); await tick();
  assert.equal(f.value, 'Preserve draft'); assert.equal(f.button('Save note').disabled, true);
  assert.match(f.byClass('status').textContent, /unsaved note is kept/);
  f.docs.set('replacement', { id: 'replacement', videoUrl: A, title: 'Again', notes: 'Replacement note', tags: [] });
  f.button('Refresh').click(); await tick();
  assert.equal(f.value, 'Preserve draft'); assert.equal(f.byClass('conflict').hidden, false);
  assert.equal(f.button('Save note').disabled, true);
});

test('SPA navigation cancels confirmation and guards the URL even before navigation synchronization', async () => {
  const f = fixture(); await f.open(); f.button('Delete from Reader').click();
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
  f.button('Delete from Reader').click(); f.button('Delete document').click();
  f.edit('Newer A draft'); f.navigate(B); await f.open();
  release(); await tick(); assert.equal(f.value, 'Original B'); assert.equal(f.button('Delete from Reader').disabled, false);
  f.navigate(A); await f.open(); assert.equal(f.value, 'Newer A draft'); assert.equal(f.button('Save note').disabled, true);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 1);
});

test('failed or stale deletion never reports success; changed document requires a fresh confirmation', async () => {
  for (const code of ['unauthorized', 'rate_limited', 'network_error', 'delete_uncertain', 'delete_cache_error', 'document_changed']) {
    const f = fixture(); await f.open(); f.edit('Keep on failure');
    f.responder = (message, normal) => message.type === 'reader-panel-delete' ? { ok: false, code } : normal();
    f.button('Delete from Reader').click(); f.button('Delete document').click(); await tick();
    assert.equal(f.value, 'Keep on failure'); assert.equal(f.byClass('status').dataset.kind, 'error');
    assert.doesNotMatch(f.byClass('status').textContent, /^Deleted from Reader/);
    assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 1);
  }
  const f = fixture(); await f.open(); f.edit('Local draft');
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? { ok: false, code: 'delete_conflict',
    document: { ...f.docs.get('doc-a'), notes: 'Changed remotely' } } : normal();
  f.button('Delete from Reader').click(); f.button('Delete document').click(); await tick();
  assert.equal(f.value, 'Local draft'); assert.match(f.byClass('status').textContent, /changed since the confirmation/);
  assert.equal(f.byClass('delete-confirm').hidden, true);
  f.button('Delete from Reader').click(); assert.equal(f.byClass('delete-confirm').hidden, false);
});

test('credentials changed during deletion invalidate late replies without discarding local draft', async () => {
  const f = fixture(); await f.open(); f.edit('Private draft');
  let release;
  f.responder = (message, normal) => message.type === 'reader-panel-delete' ? new Promise(resolve => { release = () => resolve({ ok: true, id: message.id }); }) : normal();
  f.button('Delete from Reader').click(); f.button('Delete document').click();
  f.change({ readerToken: { newValue: 'different account' } }); release(); await tick();
  assert.equal(f.value, 'Private draft'); assert.doesNotMatch(f.byClass('status').textContent, /^Deleted from Reader/);
  assert.equal(f.button('Delete from Reader').disabled, true);
});

test('deletion in another tab invalidates the visible identity and confirmation while preserving its draft', async () => {
  const f = fixture(); await f.open(); f.edit('Keep in this tab');
  f.button('Delete from Reader').click();
  f.change({ readerDocuments: { oldValue: { [A]: { id: 'doc-a' } }, newValue: {} } });
  assert.equal(f.value, 'Keep in this tab'); assert.equal(f.byClass('delete-confirm').hidden, true);
  assert.equal(f.button('Save note').disabled, true); assert.equal(f.button('Delete from Reader').disabled, true);
  assert.equal(f.messages.filter(m => m.type === 'reader-panel-delete').length, 0);
});

test('confirmation renders hostile document titles as text and already-absent replies are distinct from deletion', async () => {
  const f = fixture(); f.docs.get('doc-a').title = '<img src=x onerror=alert(1)><script>bad()</script>';
  await f.open(); f.button('Delete from Reader').click();
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
