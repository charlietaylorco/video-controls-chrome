const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const C = require('../reader-core.js');
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
const tick = () => new Promise(setImmediate);
function fixture(retained) {
  let clock = 100000, sequence = 0, responder;
  const data = retained || { readerToken: 'fixture-token', readerDocuments: { [A]: { id: 'doc-a' }, [B]: { id: 'doc-b' } } };
  const calls = [], timers = new Map(), alarms = new Map(), updates = [];
  const storage = { get(defaults, cb) { cb(structuredClone({ ...defaults, ...data })); }, set(values, cb) { Object.assign(data, structuredClone(values)); updates.push(structuredClone(values)); cb(); } };
  const context = vm.createContext({ MVSReaderCore: C });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../reader-summary-service.js'), 'utf8'), context);
  const reader = { remember() {}, savedState() {}, async handle(message, context) {
    calls.push(message);
    if (!await context.isCurrent()) return { ok: false, code: 'invalid_sender' };
    const result = await (responder ? responder(message) : { ok: true, document: { id: message.pageUrl === B ? 'doc-b' : 'doc-a', videoUrl: message.pageUrl, summary: 'Ready', notes: 'Private note' } });
    return await context.isCurrent() ? result : { ok: false, code: 'invalid_sender' };
  } };
  const options = { storage, reader, now: () => clock, timers: {
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimeout(id) { timers.delete(id); }
  }, alarms: { create(name, value) { alarms.set(name, value.when); }, clear(name) { alarms.delete(name); } } };
  let service = context.MVSReaderSummaryService.create(options);
  return { calls, data, updates, timers, alarms, get service() { return service; }, get clock() { return clock; },
    set responder(fn) { responder = fn; }, async advance(ms) { clock += ms; await service.resume(); await tick(); },
    read(type = 'reader-panel-get', isCurrent = () => true, url = A) { return service.handle({ type, pageUrl: url, targetUrl: type === 'reader-card-get' ? url : undefined }, { isCurrent }); },
    async restart() { timers.clear(); service = context.MVSReaderSummaryService.create(options); await service.resume(); },
    save(url = A, id = 'doc-a', options) { return service.recordSave(url, id, options); },
  };
}
test('15 seconds after success, repeated hover/panel/Watch requests share the schedule and ready cache', async () => {
  const f = fixture(); await f.save();
  assert.equal(f.alarms.get('reader-summary'), f.clock + 15000);
  for (let i = 0; i < 20; i++) for (const type of ['reader-panel-get', 'reader-card-get', 'reader-watch-get']) {
    assert.equal((await f.read(type)).summaryState, 'pending');
  }
  assert.equal(f.calls.length, 0); await f.advance(14999); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, 1);
  for (const type of ['reader-panel-get', 'reader-card-get', 'reader-watch-get']) assert.equal((await f.read(type)).document.summary, 'Ready');
  assert.equal(f.calls.length, 1); assert.equal(f.alarms.size, 0);
  assert.ok(!JSON.stringify(f.updates).includes('Private note'));
});
test('empty summary backs off at 15/30/60/120/240 seconds and stops after five attempts', async () => {
  const f = fixture(); f.responder = () => ({ ok: true, document: { id: 'doc-a', videoUrl: A, summary: '' } }); await f.save();
  for (const [index, delay] of [15000,15000,30000,60000,120000].entries()) {
    await f.advance(delay - 1); assert.equal(f.calls.length, index);
    await f.advance(1); assert.equal(f.calls.length, index + 1);
    await f.save(); // repeated notification cannot reset pending attempts
  }
  assert.equal(f.data.readerSummaryJobs[A].status, 'unavailable');
  await f.advance(900000); assert.equal(f.calls.length, 5); assert.equal(f.alarms.size, 0);
});
test('suspension/reopen preserves deadlines, consumed attempts and the five minute horizon', async () => {
  const f = fixture(); await f.save(); await f.advance(10000); await f.restart(); assert.equal(f.calls.length, 0);
  await f.advance(5000); assert.equal(f.calls.length, 1);
  const overdue = fixture(); await overdue.save(); await overdue.advance(300001); await overdue.restart();
  assert.equal(overdue.calls.length, 0); assert.equal(overdue.data.readerSummaryJobs[A].status, 'unavailable');
});
test('offline/API errors remain errors, retry within bounds, respect Retry-After, and auth errors stop', async () => {
  for (const code of ['network_error','reader_error','unauthorized','missing_token']) {
    const f = fixture(); await f.save(); f.responder = () => ({ ok: false, code }); await f.advance(15000);
    const reply = await f.read(); assert.equal(reply.ok, false); assert.equal(reply.code, code);
    assert.equal(f.data.readerSummaryJobs[A].status, ['unauthorized','missing_token'].includes(code) ? 'error' : 'pending');
  }
  const f = fixture(); await f.save(); f.responder = () => ({ ok: false, code: 'rate_limited', retryAt: f.clock + 60000, rateLimitSource: 'reader' });
  await f.advance(15000); await f.advance(59999); assert.equal(f.calls.length, 1); await f.advance(1); assert.equal(f.calls.length, 2);
});
test('existing summaries and already-existing saves bypass new-save delay', async () => {
  const f = fixture(); await f.save(A, 'doc-a', { alreadyExists: true }); assert.equal(f.data.readerSummaryJobs, undefined);
  assert.equal((await f.read()).document.summary, 'Ready');
  await f.save(A, 'doc-a', { existingSummary: true }); assert.equal(f.data.readerSummaryJobs, undefined);
});
test('navigation, replacement/deletion and token change reject stale work without publishing ready', async () => {
  const f = fixture(); await f.save(); let release;
  f.responder = () => new Promise(resolve => { release = resolve; });
  const work = f.advance(15000); await tick();
  assert.equal((await f.read('reader-card-get', () => false)).code, 'invalid_sender');
  f.data.readerDocuments[A] = { id: 'replacement' };
  release({ ok: true, document: { id: 'doc-a', videoUrl: A, summary: 'Stale' } }); await work;
  assert.notEqual(f.data.readerSummaryJobs[A].status, 'ready');
  await f.advance(15000); assert.equal(f.calls.length, 1);
  const auth = fixture(); await auth.save(); auth.data.readerToken = 'changed'; await auth.service.invalidateAuth(); await auth.advance(15000);
  assert.equal(auth.calls.length, 0); assert.equal(auth.data.readerSummaryJobs[A].code, 'auth_changed');
});
test('many simultaneous saves are spaced, never fetched concurrently, and never extend the horizon', async () => {
  const f = fixture(); await f.save(); await f.save(B, 'doc-b'); await f.advance(15000);
  assert.equal(f.calls.length, 1); await f.advance(3499); assert.equal(f.calls.length, 1); await f.advance(1); assert.equal(f.calls.length, 2);
});
test('ready cache after worker restart deduplicates simultaneous surface reads and rejects navigated consumers', async () => {
  const f = fixture(); await f.save(); await f.advance(15000); await f.restart(); let release, current = true;
  f.responder = message => new Promise(resolve => { release = () => resolve({ ok: true, document: { id: 'doc-a', videoUrl: A, summary: 'Ready again' } }); });
  const first = f.read(), second = f.read('reader-card-get', () => current); await tick(); current = false; release();
  assert.equal((await first).document.summary, 'Ready again'); assert.equal((await second).code, 'invalid_sender'); assert.equal(f.calls.length, 2);
});

test('a navigated first consumer cannot poison a still-current consumer sharing the read', async () => {
  const f = fixture(); await f.save(); await f.advance(15000); await f.restart(); let release, current = true;
  f.responder = () => new Promise(resolve => { release = () => resolve({ ok: true, document: { id: 'doc-a', videoUrl: A, summary: 'Shared ready' } }); });
  const first = f.read('reader-panel-get', () => current), second = f.read('reader-card-get'); await tick(); current = false; release();
  assert.equal((await first).code, 'invalid_sender'); assert.equal((await second).document.summary, 'Shared ready'); assert.equal(f.calls.length, 2);
});

test('explicit refresh keeps the initial delay but bypasses ready cache; mutations invalidate note-bearing cached replies', async () => {
  const f = fixture(); await f.save();
  assert.equal((await f.service.handle({ type: 'reader-panel-get', pageUrl: A, fresh: true })).summaryState, 'pending');
  assert.equal(f.calls.length, 0); await tick(); await f.advance(15000);
  await f.service.handle({ type: 'reader-panel-get', pageUrl: A, fresh: true }, { isCurrent: () => true }); assert.equal(f.calls.length, 2);
  await f.service.handle({ type: 'reader-panel-save-note', pageUrl: A }, { isCurrent: () => true });
  await f.read(); assert.equal(f.calls.length, 4);
});

test('a killed in-flight attempt is consumed durably and a long cooldown stops within the original horizon', async () => {
  const data = { readerToken: 'fixture-token', readerDocuments: { [A]: { id: 'doc-a' } }, readerSummaryJobs: {
    [A]: { id: 'doc-a', savedAt: 100000, nextAt: 130000, attempts: 1, status: 'pending' }
  } };
  const f = fixture(data); await f.restart(); await f.advance(15000); assert.equal(f.calls.length, 0);
  await f.advance(15000); assert.equal(f.calls.length, 1); assert.equal(f.data.readerSummaryJobs[A].attempts, 2);
  const limited = fixture(); await limited.save(); limited.responder = () => ({ ok: false, code: 'rate_limited', retryAt: limited.clock + 600000 });
  await limited.advance(15000); assert.equal(limited.data.readerSummaryJobs[A].status, 'unavailable');
  await limited.advance(900000); assert.equal(limited.calls.length, 1);
});
