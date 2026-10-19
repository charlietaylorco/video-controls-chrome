const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture({ missing = false } = {}) {
  const messages = [], nodes = [], timers = new Map(), events = new Map(); let sequence = 0, queries = 0, observer;
  const element = tag => {
    const node = { tag, children: [], style: {}, attributes: {}, parentElement: null,
      get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
      contains(child) { return child === this || this.children.some(node => node.contains(child)); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, fn) { (this.events ||= {})[type] = fn; },
    }; nodes.push(node); return node;
  };
  const document = { createElement: element, createElementNS: (_, tag) => element(tag), addEventListener() {}, removeEventListener() {}, getElementById(id) { return nodes.find(node => node.id === id && node.isConnected) || null; }, querySelector() { queries++; return target?.isConnected ? target : null; } };
  document.documentElement = element('html'); const body = element('body'); document.documentElement.append(body);
  let target = missing ? null : element('actions'); if (target) body.append(target);
  const window = { MutationObserver: class { constructor(callback) { observer = this; this.callback = callback; this.targets = []; } observe(target, options) { this.targets.push({ target, options }); } disconnect() { this.targets = []; } },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); } };
  const context = vm.createContext({ document, window, chrome: { runtime: { sendMessage(message, cb) { messages.push(message); cb(); } } }, location: { hostname: 'www.youtube.com' } });
  const source = fs.readFileSync(path.join(__dirname, '..', 'reader-header.js'), 'utf8'); vm.runInContext(source, context);
  const flush = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { context, source, nodes, messages, body, get target() { return target; }, get queries() { return queries; }, get observer() { return observer; }, get timers() { return timers; }, flush,
    remount() { target?.remove(); target = element('new-actions'); body.append(target); observer.callback(); flush(); }, navigate() { events.get('yt-navigate-finish')(); flush(); } };
}
test('header icon has accessible naming and activates the existing safe open/focus route', () => {
  const f = fixture(), button = f.nodes.find(node => node.tag === 'button');
  assert.equal(button.attributes['aria-label'], 'Recent saves'); assert.equal(button.title, 'Recent saves'); assert.equal(button.type, 'button');
  button.events.click({ preventDefault() {}, stopPropagation() {} }); assert.equal(f.messages.length, 1); assert.equal(f.messages[0].type, 'open-watch-list');
});
test('header remounts and repeated navigation reuse one owned host without removing native controls', () => {
  const f = fixture(), original = f.target.children[0], native = { remove() {}, parentElement: null, isConnected: true, contains() { return false; } };
  f.target.append(native); f.navigate(); f.navigate(); assert.equal(f.target.children.filter(child => child.id === 'mvs-recent-saves-header').length, 1); assert.ok(f.target.children.includes(native));
  f.remount(); assert.equal(f.target.children[0], original); assert.equal(f.nodes.filter(node => node.tag === 'button').length, 1);
  vm.runInContext(f.source, f.context); assert.equal(f.target.children.filter(child => child.id === 'mvs-recent-saves-header').length, 1);
});
test('missing header uses mutation-driven bootstrap; healthy unrelated mutations cause no queries or polling', () => {
  const f = fixture({ missing: true }); assert.equal(f.messages.length, 0); f.remount();
  const queries = f.queries; f.observer.callback(); assert.equal(f.queries, queries); assert.equal(f.timers.size, 0);
  assert.ok(f.observer.targets.filter(row => row.options.subtree).every(row => row.target === f.target));
});
