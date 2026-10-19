const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Events {
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
}
function fixture() {
  const document = new Events(), window = Object.assign(new Events(), { innerWidth: 320, innerHeight: 240 });
  const element = tag => Object.assign(new Events(), { tag, children: [], attributes: {}, style: {}, isConnected: true, scrollHeight: 154,
    append(child) { this.children.push(child); child.parent = this; },
    setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key]; },
    contains(target) { return this === target || this.children.some(child => child.contains(target)); },
    focus() { document.activeElement = this; document.emit('focusin', { target: this }); },
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    getBoundingClientRect() { return { left: 60, top: 100, bottom: 132 }; },
  });
  document.body = element('body'); document.createElement = element;
  const context = vm.createContext({ document, window, URL });
  for (const file of ['reader-core.js', 'watch-location-menu.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  let valid = true; const chosen = [], trigger = element('button'); document.body.append(trigger);
  const menu = context.MVSWatchLocationMenu.create({ document, window, isCurrent: () => valid, choose: (snapshot, value) => chosen.push({ snapshot, value }) });
  const target = { videoUrl: 'https://www.youtube.com/watch?v=alpha', id: 'doc-a', title: 'Saved video', location: 'later', trigger };
  const root = document.body.children.at(-1), buttons = root.children.filter(child => child.tag === 'button');
  const key = value => { const event = { key: value, preventDefault() { this.prevented = true; }, stopPropagation() {} }; root.emit('keydown', event); return event; };
  return { document, window, menu, root, buttons, trigger, target, chosen, key, element, invalidate: () => { valid = false; } };
}

test('custom menu exposes checked location, one roving focus target and distinct destructive action', () => {
  const f = fixture(); f.menu.open(f.target);
  assert.equal(f.root.hidden, false); assert.equal(f.trigger.getAttribute('aria-expanded'), 'true'); assert.equal(f.document.activeElement, f.buttons[0]);
  assert.equal(f.buttons[0].getAttribute('aria-checked'), 'true'); assert.equal(f.buttons[3].getAttribute('role'), 'menuitem');
  assert.equal(f.buttons.filter(button => button.tabIndex === 0).length, 1); assert.equal(f.chosen.length, 0);
});
test('arrow wrap, Home/End, typeahead and Escape preserve predictable menu focus', () => {
  const f = fixture(); f.menu.open(f.target); f.key('ArrowUp'); assert.equal(f.document.activeElement, f.buttons[3]);
  f.key('Home'); assert.equal(f.document.activeElement, f.buttons[0]); f.key('End'); assert.equal(f.document.activeElement, f.buttons[3]);
  f.key('s'); assert.equal(f.document.activeElement, f.buttons[1]); f.key('Escape');
  assert.equal(f.root.hidden, true); assert.equal(f.document.activeElement, f.trigger); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
});
test('selection uses the captured identity and stale document snapshots cannot invoke a move or Trash', () => {
  const f = fixture(); f.menu.open(f.target); f.buttons[2].emit('click');
  assert.equal(f.chosen.length, 1); assert.equal(f.chosen[0].value, 'archive'); assert.equal(f.chosen[0].snapshot.id, 'doc-a'); assert.equal(f.root.hidden, true);
  f.menu.open(f.target); f.invalidate(); f.buttons[3].emit('click'); assert.equal(f.chosen.length, 1); assert.equal(f.root.hidden, true);
});
test('outside pointer/focus dismissal never steals focus while interactions inside stay open', () => {
  const f = fixture(); f.menu.open(f.target); f.document.emit('pointerdown', { target: f.buttons[1] }); assert.equal(f.root.hidden, false);
  const outside = f.element('button'); outside.focus(); assert.equal(f.root.hidden, true); assert.equal(f.document.activeElement, outside);
  f.menu.open(f.target); f.document.emit('pointerdown', { target: outside }); assert.equal(f.root.hidden, true);
});
test('Tab closes without cancelling native navigation and the menu stays within a short viewport', () => {
  const f = fixture(); f.menu.open(f.target); assert.ok(parseFloat(f.root.style.top) >= 8); assert.ok(parseFloat(f.root.style.top) + 154 <= 232);
  f.window.innerWidth = 240; f.window.emit('resize'); assert.ok(parseFloat(f.root.style.left) + 184 <= 232);
  const event = f.key('Tab'); assert.equal(event.prevented, undefined); assert.equal(f.root.hidden, true); assert.equal(f.document.activeElement, f.trigger);
});
test('disabled/disconnected triggers cannot open; identity invalidation and teardown remove stale menus', () => {
  const f = fixture(); f.trigger.disabled = true; f.menu.open(f.target); assert.equal(f.root.hidden, true);
  f.trigger.disabled = false; f.trigger.isConnected = false; f.menu.open(f.target); assert.equal(f.root.hidden, true);
  f.trigger.isConnected = true; f.menu.open(f.target); f.invalidate(); f.menu.refresh(); assert.equal(f.root.hidden, true);
  f.menu.destroy(); assert.equal(f.root.isConnected, false); assert.equal(f.document.listeners.get('pointerdown').length, 0);
});
