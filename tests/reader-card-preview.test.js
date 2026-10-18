const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../reader-core.js');
const PAGE = 'https://www.youtube.com/feed/subscriptions';
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
const tick = () => new Promise(setImmediate);
function fixture({ saved = true, width = 1100, height = 700 } = {}) {
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
    contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
    getRootNode() { for (let n = this; n; n = n.parentElement) if (n.tagName === 'shadow' || !n.parentElement) return n; }
    focus() { active = this; this.fire('focusin'); }
    blur() { active = null; this.fire('focusout'); }
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
        const normal = () => message.type === 'reader-card-delete' ? { ok: true, id: message.id }
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
  };
}

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
