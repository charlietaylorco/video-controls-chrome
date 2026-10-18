const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
class Events {
  listeners = new Map();
  addEventListener(type, fn) { const rows = this.listeners.get(type) || []; rows.push(fn); this.listeners.set(type, rows); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(row => row !== fn)); }
  emit(type) { for (const fn of this.listeners.get(type) || []) fn(); }
}
function fixture() {
  const document = new Events(), window = new Events(), created = [], status = [];
  document.hidden = false;
  const element = tag => Object.assign(new Events(), { tag, hidden: false, isConnected: true, children: [], width: 480, height: 270,
    append(child) { child.parent = this; this.children.push(child); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; this.isConnected = false; },
    getBoundingClientRect() { return { width: this.width, height: this.height }; },
    focus() { document.activeElement = this; },
  });
  document.createElement = tag => { const row = element(tag); created.push(row); return row; };
  const context = vm.createContext({ document, window, URL });
  for (const file of ['reader-core.js', 'watch-player.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const player = context.MVSWatchPlayer.create({ document, window, announce: (...args) => status.push(args) });
  const target = (videoUrl = A) => ({ videoUrl, title: 'A saved video', host: element('div'), trigger: element('button'), close: Object.assign(element('button'), { hidden: true }) });
  return { document, window, player, target, created, status, mounted: () => created.filter(row => row.parent) };
}

test('no player is created until explicit open; one native iframe has no autoplay or remote parent API', () => {
  const f = fixture(), a = f.target(); assert.equal(f.created.length, 0);
  assert.equal(f.player.open(a), true); const frame = f.mounted()[0], url = new URL(frame.src);
  assert.equal(f.mounted().length, 1); assert.equal(frame.tag, 'iframe'); assert.equal(url.origin, 'https://www.youtube.com'); assert.equal(url.pathname, '/embed/alpha');
  assert.equal(url.searchParams.get('autoplay'), '0'); assert.equal(url.searchParams.has('origin'), false); assert.equal(url.searchParams.has('enablejsapi'), false);
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin'); assert.equal(frame.title, 'YouTube player: A saved video');
  assert.equal(a.trigger.hidden, true); assert.equal(a.close.hidden, false); assert.equal(f.document.activeElement, frame);
});

test('switching videos unmounts the previous frame; close returns focus to its own thumbnail', () => {
  const f = fixture(), a = f.target(), b = f.target(B); f.player.open(a); const old = f.mounted()[0];
  f.player.open(b); assert.equal(f.mounted().length, 1); assert.equal(old.parent, null); assert.equal(a.trigger.hidden, false); assert.equal(a.close.hidden, true);
  assert.equal(f.player.currentUrl(), B); f.player.clear({ focus: true }); assert.equal(f.document.activeElement, b.trigger);
  assert.equal(f.mounted().length, 0); assert.equal(b.trigger.hidden, false); assert.equal(b.close.hidden, true);
});

test('local redraw keeps a matching player; paging/filter removal, hidden page and pagehide unload it without automatic restoration', () => {
  const f = fixture(), a = f.target(); f.player.open(a); const frame = f.mounted()[0];
  f.player.keep([A, B]); assert.equal(f.mounted()[0], frame); f.player.keep([B]); assert.equal(f.mounted().length, 0);
  f.player.open(a); f.document.hidden = true; f.document.emit('visibilitychange'); assert.equal(f.mounted().length, 0);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(f.mounted().length, 0);
  f.player.open(a); f.window.emit('pagehide'); assert.equal(f.mounted().length, 0);
});

test('undersized or hidden targets do not start network; shrinking an active frame restores thumbnail and fallback feedback', () => {
  const f = fixture(), a = f.target(); a.host.height = 199;
  assert.equal(f.player.open(a), false); assert.equal(f.created.length, 0); assert.match(f.status.at(-1)[0], /Open on YouTube/);
  a.host.height = 270; f.document.hidden = true; assert.equal(f.player.open(a), false); assert.equal(f.created.length, 0);
  f.document.hidden = false; f.player.open(a); a.host.width = 199; f.window.emit('resize'); assert.equal(f.mounted().length, 0);
});

test('invalid URLs and detached targets are rejected, while stale frame errors cannot affect a later player', () => {
  const f = fixture(), invalid = f.target('https://evil.test/watch?v=alpha'); assert.equal(f.player.open(invalid), false); assert.equal(f.created.length, 0);
  invalid.videoUrl = A; invalid.host.isConnected = false; assert.equal(f.player.open(invalid), false);
  const a = f.target(), b = f.target(B); f.player.open(a); const old = f.mounted()[0]; f.player.open(b); old.emit('error'); assert.equal(f.player.currentUrl(), B);
  f.mounted()[0].emit('error'); assert.equal(f.player.currentUrl(), null); assert.equal(f.document.activeElement, b.trigger); assert.match(f.status.at(-1)[0], /could not be loaded/);
  f.player.destroy(); assert.equal(f.window.listeners.get('resize').length, 0); assert.equal(f.document.listeners.get('visibilitychange').length, 0);
});
