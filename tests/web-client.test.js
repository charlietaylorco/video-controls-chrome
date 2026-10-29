const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createTransport, createTimer } = require('../web/client.js');
const { embedUrl } = require('../web/embeds.js');
const C = require('../watch-timer-core.js');
const json = (value, status = 200) => ({ status, json: async () => value });
const tick = () => new Promise(setImmediate);

test('hosted requests wait for authentication and never use extension or browser storage', async () => {
  let release;
  const calls = [];
  const client = createTransport({ request: (url, init) => { calls.push({ url, init }); return new Promise(resolve => { release = resolve; }); } });
  const waiting = client.send({ type: 'watch-list-page' });
  assert.equal(calls.length, 1);
  release(json({ ok: true, configured: true, authenticated: false }));
  assert.deepEqual(await waiting, { ok: false, code: 'auth_required' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(!/localStorage|sessionStorage|indexedDB|chrome\./.test(fs.readFileSync(path.join(__dirname, '../web/client.js'), 'utf8')));
});

test('writes keep the API payload, use same-origin cookies and never retry an uncertain mutation', async () => {
  const calls = [];
  const client = createTransport({ request: async (url, init) => { calls.push({ url, init }); if (init.method === 'GET') return json({ ok: true, configured: true, authenticated: true }); throw new Error('lost response'); } });
  const message = { type: 'watch-list-delete', token: 'one-time', confirmed: true };
  assert.deepEqual(await client.send(message), { ok: false, code: 'network_error' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/recent-saves');
  assert.deepEqual(JSON.parse(calls[1].init.body), message);
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.deepEqual(calls[1].init.headers, { 'Content-Type': 'application/json' });
});

test('expired sessions block later data calls until the user signs in again', async () => {
  let calls = 0;
  const client = createTransport({ request: async (_, init) => { calls++; return init.method === 'GET' ? json({ ok: true, configured: true, authenticated: true }) : json({ ok: false, code: 'unauthorized' }, 401); } });
  await client.send({ type: 'watch-list-refresh', videoUrl: 'https://www.youtube.com/watch?v=test' });
  assert.equal(client.status.authenticated, false);
  assert.deepEqual(await client.send({ type: 'watch-list-page' }), { ok: false, code: 'auth_required' });
  assert.equal(calls, 2);
});

test('successful sign-in reloads without persisting credentials and settings notify listeners', async () => {
  let reloaded = 0; const messages = [], notices = [];
  const client = createTransport({ reload: () => reloaded++, request: async (_, init) => {
    if (init.method === 'GET') return json({ ok: true, configured: true, authenticated: false });
    const message = JSON.parse(init.body); messages.push(message);
    return json(message.type === 'cloud-settings' ? { ok: true, theme: 'dark', timerDefault: 25 } : { ok: true });
  } });
  client.subscribe(status => notices.push(status));
  await client.send({ type: 'auth-login', email: 'owner@example.test', password: 'one-request-only' });
  assert.equal(reloaded, 1);
  assert.equal(client.status.password, undefined);
  await client.send({ type: 'cloud-settings', theme: 'dark', timerDefault: 25 });
  assert.equal(notices.at(-1).theme, 'dark');
  assert.equal(notices.at(-1).timerDefault, 25);
  assert.equal(messages.length, 2);
});

test('inline player accepts only canonical YouTube targets and never substitutes another host', () => {
  assert.equal(embedUrl('https://www.youtube.com/watch?v=abc_X-19', 'https://recent.example'), 'https://www.youtube-nocookie.com/embed/abc_X-19?autoplay=1&playsinline=1&rel=0');
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=abc', 'https://www.youtube.com@evil.test/watch?v=abc', 'https://www.youtube.com/watch?v=<script>', 'http://www.youtube.com/watch?v=abc', 'https://www.youtube.com:444/watch?v=abc', 'https://www.youtube.com/shorts/abc']) assert.equal(embedUrl(url, 'https://recent.example'), null);
  assert.equal(embedUrl('https://www.youtube.com/watch?v=abc', 'file:///tmp/page.html'), null);
});

function fixture() {
  const events = {}, calls = [], document = { hidden: false, addEventListener(type, fn) { events[type] = fn; } };
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.value = ''; this.hidden = false; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() { document.activeElement = this; }
    fire(type) { return this.listeners[type]?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  document.createElement = tag => new Node(tag);
  let responder = () => ({ ok: true });
  const transport = { send: async message => { calls.push(message); return responder(message); }, messageFor: () => null };
  const context = vm.createContext({ document, window: { addEventListener(type, fn) { events[type] = fn; } }, location: { origin: 'https://recent.example' }, URL, MVSWatchTransport: transport });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/embeds.js'), 'utf8'), context);
  const item = index => ({ videoUrl: `https://www.youtube.com/watch?v=test_${index}`, title: '<b>Untrusted title</b>', description: '<img src=x onerror=alert(1)>', notes: 'My note', revision: 1 });
  const attach = (index, overrides = {}) => {
    const mediaBox = new Node('div'), copy = new Node('div'), value = { ...item(index), ...overrides };
    const extras = context.MVSWatchExtras.attach({ mediaBox, copy, item: value, announce() {}, reload() {} }); extras.update(value, true);
    return { mediaBox, copy, extras, item: value, play: mediaBox.children[0], close: mediaBox.children[1], form: copy.children[0].children[1], details: copy.children[0] };
  };
  return { attach, document, events, calls, set responder(value) { responder = value; } };
}

test('one inline player is active, sets the recommended referrer policy, and tears down on hide/removal', () => {
  const f = fixture(), first = f.attach(1), second = f.attach(2);
  first.play.fire('click'); let frame = first.mediaBox.children.find(node => node.tagName === 'iframe');
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin'); assert.equal(frame.allowFullscreen, true);
  assert.equal(frame.title, 'YouTube player: <b>Untrusted title</b>');
  second.play.fire('click'); assert.equal(first.mediaBox.children.some(node => node.tagName === 'iframe'), false);
  assert.equal(second.mediaBox.children.some(node => node.tagName === 'iframe'), true);
  f.document.hidden = true; f.events.visibilitychange(); assert.equal(second.mediaBox.children.some(node => node.tagName === 'iframe'), false);
  f.document.hidden = false; first.play.fire('click'); first.extras.destroy(); assert.equal(first.mediaBox.children.length, 0);
});

test('description and note editors retain conflicting drafts and submit captured revision as plain text', async () => {
  const f = fixture(), row = f.attach(1), [label, description, noteLabel, note, status, buttons] = row.form.children;
  assert.equal(description.value, '<img src=x onerror=alert(1)>');
  assert.equal(note.value, 'My note');
  description.value = 'Local edit'; description.fire('input');
  row.extras.update({ ...row.item, description: 'Remote edit', revision: 2 }, true);
  assert.equal(description.value, 'Local edit'); assert.match(status.textContent, /changed elsewhere/);
  f.responder = () => ({ ok: false, code: 'document_changed', item: { ...row.item, description: 'Remote edit', revision: 2 } });
  await row.form.fire('submit');
  assert.equal(f.calls[0].revision, 1); assert.equal(f.calls[0].description, 'Local edit');
  assert.equal(description.value, 'Local edit');
  buttons.children[1].fire('click'); assert.equal(description.value, 'Remote edit');
});

test('new typing during a successful cloud save stays dirty and uses the new revision next time', async () => {
  const f = fixture(), row = f.attach(1), description = row.form.children[1], status = row.form.children[4];
  description.value = 'First edit'; description.fire('input'); let release;
  f.responder = () => new Promise(resolve => { release = resolve; });
  const saving = row.form.fire('submit');
  description.value = 'Newer edit'; description.fire('input');
  release({ ok: true, item: { ...row.item, description: 'First edit', revision: 2 } }); await saving;
  assert.equal(description.value, 'Newer edit'); assert.match(status.textContent, /newer edits/);
  f.responder = message => ({ ok: true, item: { ...row.item, description: message.description, revision: 3 } });
  await row.form.fire('submit'); assert.equal(f.calls.at(-1).revision, 2);
});


test('unsaved drafts survive filters within the tab and leaving the page warns before losing them', () => {
  const f = fixture(), first = f.attach(1), description = first.form.children[1];
  description.value = 'Unsaved description'; description.fire('input'); first.extras.destroy();
  const restored = f.attach(1); assert.equal(restored.form.children[1].value, 'Unsaved description');
  let warned = false; f.events.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, true);
  restored.form.children[5].children[1].fire('click');
  warned = false; f.events.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, false);
});


test('partial list text cannot be edited or saved before a full cloud-item read succeeds', async () => {
  const f = fixture(), row = f.attach(1, { contentPartial: true, description: 'INCOMPLETE PREVIEW', notes: undefined });
  const description = row.form.children[1], note = row.form.children[3], buttons = row.form.children[5];
  assert.equal(description.value, ''); assert.equal(note.value, ''); assert.equal(description.disabled, true); assert.equal(buttons.children[0].disabled, true);
  description.value = 'programmatic edit'; await row.form.fire('submit'); assert.equal(f.calls.length, 0);
  const full = { ...row.item, contentPartial: false, description: 'FULL SAVED DESCRIPTION', notes: 'Full note', revision: 1 };
  let release; f.responder = () => new Promise(resolve => { release = resolve; });
  row.details.open = true; row.details.fire('toggle'); row.details.fire('toggle');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].type, 'cloud-item');
  release({ ok: true, item: full }); await tick();
  assert.equal(description.value, 'FULL SAVED DESCRIPTION'); assert.equal(note.value, 'Full note'); assert.equal(description.disabled, false);
});

test('failed lazy text reads stay read-only and expose an explicit retry', async () => {
  const f = fixture(), row = f.attach(1, { contentPartial: true, description: undefined, notes: undefined });
  const description = row.form.children[1], buttons = row.form.children[5];
  f.responder = () => ({ ok: false, code: 'network_error' });
  row.details.open = true; row.details.fire('toggle'); await tick();
  assert.equal(description.disabled, true); assert.equal(buttons.children[2].hidden, false);
  f.responder = () => ({ ok: true, item: { ...row.item, contentPartial: false, description: 'Restored full text', notes: '', revision: 1 } });
  buttons.children[2].fire('click'); await tick();
  assert.equal(description.value, 'Restored full text'); assert.equal(description.disabled, false); assert.equal(buttons.children[2].hidden, true);
});

test('partial updates cannot replace a full revision or a dirty draft with preview content', async () => {
  const f = fixture(), row = f.attach(1), description = row.form.children[1], buttons = row.form.children[5];
  description.value = 'Local draft'; description.fire('input');
  row.extras.update({ ...row.item, contentPartial: true, description: 'PREVIEW', notes: '', revision: 1 }, true);
  assert.equal(description.value, 'Local draft'); assert.equal(description.disabled, false);
  row.extras.update({ ...row.item, contentPartial: true, description: 'NEW PREVIEW', notes: '', revision: 2 }, true);
  assert.equal(description.value, 'Local draft'); assert.equal(description.disabled, true);
  await row.form.fire('submit'); assert.equal(f.calls.length, 0);
  f.responder = () => ({ ok: true, item: { ...row.item, description: 'Old full data', revision: 1 } });
  row.details.open = true; row.details.fire('toggle'); await tick();
  assert.equal(description.disabled, true, 'an older lazy response cannot enable saving');
  f.responder = () => ({ ok: true, item: { ...row.item, description: 'New full data', notes: 'New full note', revision: 2 } });
  buttons.children[2].fire('click'); await tick();
  assert.equal(description.value, 'Local draft'); assert.equal(description.disabled, false);
  f.responder = () => ({ ok: false, code: 'document_changed' }); await row.form.fire('submit');
  assert.equal(f.calls.at(-1).revision, 1, 'draft keeps its captured full baseline');
  // Refresh full data after the conflict, then explicitly discard the draft.
  f.responder = () => ({ ok: true, item: { ...row.item, description: 'New full data', notes: 'New full note', revision: 2 } });
  buttons.children[2].fire('click'); await tick(); buttons.children[1].fire('click');
  assert.equal(description.value, 'New full data'); assert.equal(row.form.children[3].value, 'New full note');
});

test('cloud timer projects deadlines locally and does not send per-second requests', async () => {
  let now = 1000; const timers = new Map(), calls = [], states = [];
  const old = globalThis.MVSWatchTimerCore; globalThis.MVSWatchTimerCore = C;
  try {
    const client = createTimer({ now: () => now, timers: { clearTimeout(id) { timers.delete(id); }, setTimeout(fn) { const key = Symbol(); timers.set(key, fn); return key; } }, onChange: (...args) => states.push(args), transport: { ready: Promise.resolve({ authenticated: true }), send: async message => { calls.push(message); return { ok: true, state: { phase: 'running', id: 'timer1', revision: 1, durationMinutes: 1, deadline: 61000 }, defaultMinutes: 15 }; } } });
    await client.ready; assert.equal(calls.length, 1);
    now = 2000; client.refresh(); now = 3000; client.refresh(); assert.equal(calls.length, 1); assert.equal(states.at(-1)[2], 58000);
    client.dispose(); assert.equal(timers.size, 0);
  } finally { globalThis.MVSWatchTimerCore = old; }
});
