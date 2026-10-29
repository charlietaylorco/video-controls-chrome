"use strict";
const test = require('node:test');
const { before } = test;
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let createDatabase, createApi, importedItem;
before(async () => {
  ({ createDatabase } = await import('../watchlater/lib/database.mjs'));
  ({ createApi } = await import('../watchlater/lib/api.mjs'));
  ({ importedItem } = await import('../watchlater/lib/validation.mjs'));
});
const owner = { ownerId: 'owner', device: false };
const base = 2000000;
const url = n => `https://www.youtube.com/watch?v=video${n}`;
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = path.join(__dirname, '../watchlater/drizzle');
  const migrations = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  assert(migrations.length, 'generate the real Drizzle migration before running D1 tests');
  for (const file of migrations) sqlite.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
  let at = base, hook;
  const binding = { prepare(sql) {
    let values = [];
    const statement = { bind(...next) { values = next; return this; },
      _all() { return sqlite.prepare(sql).all(...values); },
      async first() { hook?.(sql, values); return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: this._all() }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; }
    };
    return statement;
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = statements.map(statement => ({ results: statement._all() })); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const db = createDatabase(binding, { now: () => at });
  const rpc = (name, args = {}, user = 'owner') => db.rpc(`rs_${name}`, { p_user_id: user, p_args: args });
  const source = (n, extra = {}) => importedItem({ videoUrl: url(n), readerId: `reader${n}`, savedAt: 1000 + n, firstSavedAt: 1000 + n, updatedAt: 2000, status: 'saved', title: `Title ${n}`, author: 'Ａlice', tags: ['A long tag'], location: 'later', checkedAt: 1000, summary: 'Durable summary', summaryCheckedAt: 1000, description: 'Source description', notes: 'Personal note', ...extra }, at);
  t.after(() => sqlite.close());
  return { sqlite, binding, db, rpc, source, setTime(value) { at = value; }, setHook(value) { hook = value; } };
}

test('real migrations enforce owner partition; duplicate imports remain idempotent', async t => {
  const f = fixture(t); const source = f.source(1);
  await f.rpc('import', { items: [source] }); await f.rpc('import', { items: [source] });
  const item = await f.rpc('item', { videoUrl: url(1) }); assert.equal(item.revision, 1);
  assert.equal(item.description, 'Source description');
  await assert.rejects(f.rpc('item', { videoUrl: url(1) }, 'other'), { code: 'unauthorized' });
  assert.throws(() => f.sqlite.prepare('INSERT INTO rs_settings(owner_id,data) VALUES(?,?)').run('other', '{}'), /CHECK/);
});

test('keyset pages are bounded and exact normalized filters search all durable fields safely', async t => {
  const f = fixture(t);
  await f.rpc('import', { items: Array.from({ length: 14 }, (_, n) => f.source(n + 1)) });
  const first = await f.rpc('page', { filter: 'watch' }); assert.equal(first.items.length, 12); assert.equal(first.hasNext, true);
  assert.equal(first.items[0].videoUrl, url(14)); assert.equal(first.items[0].contentPartial, true); assert(!Object.hasOwn(first.items[0], 'notes'));
  const second = await f.rpc('page', { filter: 'watch', cursor: first.nextCursor }); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  const filtered = await f.rpc('page', { filter: 'all', channel: 'alice', tag: 'a long tag', terms: ['durable', 'personal'] }); assert.equal(filtered.items.length, 12);
  assert.equal((await f.rpc('page', { filter: 'all', terms: ["');DROP TABLE rs_items;--"] })).items.length, 0);
  assert.equal((await f.rpc('page', { filter: 'all', tag: 'long' })).items.length, 0);
  assert.equal((await f.rpc('page', { export: true })).items.length, 4);
});

test('full summaries remain durable while card payloads are explicit excerpts', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1, { summary: '漢'.repeat(64000) })] });
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.summary.length, 64000);
  const card = (await f.rpc('page', { filter: 'all' })).items[0]; assert.equal(card.summary.length, 32768); assert.equal(card.summaryTruncated, true);
});

test('compact page versions match card snapshots and detect inserts, edits and filtered removals', async t => {
 const f = fixture(t), view = { filter: 'watch' };
 const empty = await f.rpc('page_version', view);
 await f.rpc('import', { items: [f.source(1)] });
 const first = await f.rpc('page', view); assert.notEqual(first.version, empty.version);
 assert.deepEqual(await f.rpc('page_version', view), { version: first.version });
 assert.ok(!first.version.includes('Source description'));
 await f.rpc('import', { items: [f.source(1)] }); assert.equal((await f.rpc('page_version', view)).version, first.version);
 await f.rpc('edit', { videoUrl: url(1), revision: 1, description: 'New text', notes: '' });
 const edited = await f.rpc('page_version', view); assert.notEqual(edited.version, first.version);
 await f.rpc('verify', { doc: { id: 'reader1', videoUrl: url(1), location: 'archive' }, now: base });
 assert.equal((await f.rpc('page_version', view)).version, empty.version);
 assert.notEqual((await f.rpc('page_version', { filter: 'archive' })).version, empty.version);
});

test('concurrent editorial writes use revision CAS and only one same-baseline edit can win', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1)] });
  const writes = await Promise.all(['First', 'Second'].map(description => f.rpc('edit', { videoUrl: url(1), revision: 1, description, notes: 'Cloud note' })));
  assert.equal(writes.filter(result => result.ok).length, 1); assert.equal(writes.find(result => !result.ok).code, 'document_changed');
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.revision, 2); assert.equal(full.description, writes.find(result => result.ok).item.description);
});

test('imports retry pure DB races without overwriting a concurrent personal edit', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1)] });
  let changed = false;
  f.setHook(sql => {
    if (changed || !sql.startsWith('INSERT INTO rs_items')) return;
    changed = true;
    f.sqlite.prepare("UPDATE rs_items SET data=json_set(data,'$.notes','Concurrent website note'),content_edited=1,revision=revision+1 WHERE owner_id='owner'").run();
  });
  await f.rpc('import', { items: [f.source(1, { title: 'Updated source title', updatedAt: 4000, checkedAt: 2000, notes: 'Stale browser note' })] });
  const full = await f.rpc('item', { videoUrl: url(1) });
  assert.equal(full.notes, 'Concurrent website note'); assert.equal(full.title, 'Updated source title'); assert.equal(full.revision, 3);
});

test('website description and note edits survive imported updates, including intentionally empty text', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1)] });
  await f.rpc('edit', { videoUrl: url(1), revision: 1, description: '', notes: 'Cloud note' });
  await f.rpc('import', { items: [f.source(1, { updatedAt: 5000, checkedAt: 5000, description: 'Stale source text', notes: 'Stale note' })] });
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.description, ''); assert.equal(full.notes, 'Cloud note');
});

test('old imported identity cannot resurrect a cloud tombstone; explicit later new identity can', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1)] });
  await f.rpc('mark', { videoUrl: url(1), id: 'reader1', status: 'deleted', now: 4000 });
  await f.rpc('import', { items: [f.source(1, { savedAt: 1001, updatedAt: 9000, checkedAt: 9000 })] });
  assert.equal((await f.rpc('item', { videoUrl: url(1) })).status, 'deleted');
  await f.rpc('import', { items: [f.source(1, { readerId: 'replacement', savedAt: 5000, updatedAt: 5000, checkedAt: 0, summary: null, summaryCheckedAt: 0, tags: [] })] });
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.status, 'saved'); assert.equal(full.readerId, 'replacement'); assert.equal(full.summary, null); assert.deepEqual(full.tags, []);
  assert.equal(await f.rpc('verify', { doc: { id: 'reader1', videoUrl: url(1) }, now: 10000 }), null);
});

test('active new-save identity beats a later verification of the old ID; same-ID imports never regress savedAt/duration', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1, { durationSeconds: 120 })] });
  await f.rpc('verify', { doc: { id: 'reader1', videoUrl: url(1), title: 'Old source', tags: null, summary: 'Verified', summaryTruncated: false, location: 'archive' }, now: 9000 });
  await f.rpc('import', { items: [f.source(1, { readerId: 'replacement', savedAt: 5000, updatedAt: 5000, checkedAt: 0, summary: null, summaryCheckedAt: 0 })] });
  assert.equal((await f.rpc('item', { videoUrl: url(1) })).readerId, 'replacement');
  await f.rpc('import', { items: [f.source(1, { readerId: 'replacement', savedAt: 1001, updatedAt: 10000, checkedAt: 10000, durationSeconds: null })] });
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.savedAt, 5000); assert.equal(full.durationSeconds, 120);
});

test('Reader verification preserves website-owned fields and tags when absent', async t => {
  const f = fixture(t); await f.rpc('import', { items: [f.source(1)] });
  await f.rpc('verify', { doc: { id: 'reader1', videoUrl: url(1), title: 'Reader title', author: '', tags: null, location: 'shortlist', summary: 'New Reader summary', readerNotes: 'Unrelated Reader document note' }, now: 5000 });
  const full = await f.rpc('item', { videoUrl: url(1) }); assert.equal(full.notes, 'Personal note'); assert.equal(full.description, 'Source description'); assert.deepEqual(full.tags, ['A long tag']); assert.equal(full.location, 'shortlist');
});

test('confirmation tickets expire and atomic DELETE RETURNING permits only one consumer', async t => {
  const f = fixture(t); await f.rpc('ticket', { action: 'create', hash: 'a'.repeat(64), snapshot: { id: 'reader1', notes: 'Exact note' } });
  const results = await Promise.all(Array.from({ length: 8 }, () => f.rpc('ticket', { action: 'take', hash: 'a'.repeat(64) })));
  assert.equal(results.filter(Boolean).length, 1);
  await f.rpc('ticket', { action: 'create', hash: 'b'.repeat(64), snapshot: { id: 'reader1' } });
  f.setTime(base + 120001); assert.equal(await f.rpc('ticket', { action: 'take', hash: 'b'.repeat(64) }), null);
});

test('device tokens expire/revoke and SHA hashes alone are stored', async t => {
  const f = fixture(t); const tokenHash = 'f'.repeat(64);
  await f.rpc('device', { action: 'create', hash: tokenHash }); assert.equal((await f.rpc('device', { action: 'get', hash: tokenHash })).valid, true);
  await f.rpc('device', { action: 'revoke' }); assert.equal((await f.rpc('device', { action: 'get', hash: tokenHash })).valid, false);
  await f.rpc('device', { action: 'create', hash: tokenHash }); f.setTime(base + 90 * 86400000 + 1); assert.equal((await f.rpc('device', { action: 'get', hash: tokenHash })).valid, false);
});

test('concurrent persisted Reader budgets cannot overbook and cooldown applies across request kinds', async t => {
  const f = fixture(t);
  const reservations = await Promise.all(Array.from({ length: 8 }, () => f.rpc('rate', { action: 'reserve', needs: { list: 3 } })));
  assert.equal(reservations.filter(value => value.ok).length, 6); assert.equal(reservations.filter(value => !value.ok).length, 2);
  await f.rpc('rate', { action: 'block', until: base + 120000 });
  assert.equal((await f.rpc('rate', { action: 'reserve', needs: { update: 1 } })).source, 'reader');
  f.setTime(base + 120001); assert.equal((await f.rpc('rate', { action: 'reserve', needs: { list: 1 } })).ok, true);
});

test('timer/settings share a CAS record without losing preferences or accepting stale mutations', async t => {
  const f = fixture(t);
  await f.rpc('settings', { action: 'set', theme: 'dark', timerDefault: 25 });
  const started = await f.rpc('timer', { action: 'start', revision: 0, newId: 'timer-one', now: base, minutes: 15 });
  assert.equal(started.state.deadline, base + 900000); assert.equal(started.defaultMinutes, 25);
  const stale = await f.rpc('timer', { action: 'pause', id: 'timer-one', revision: 0, now: base + 1000 }); assert.equal(stale.code, 'timer_changed');
  await Promise.all([f.rpc('settings', { action: 'set', theme: 'light', timerDefault: 30 }), f.rpc('timer', { action: 'pause', id: 'timer-one', revision: 1, now: base + 1000 })]);
  assert.equal((await f.rpc('settings', { action: 'get' })).theme, 'light'); assert.equal((await f.rpc('timer', { action: 'get', now: base + 1000 })).state.phase, 'paused');
});

test('Sites API requires validated private owner context and uses URL-safe 256-bit pairing keys', async t => {
  const f = fixture(t); const api = createApi({ db: f.binding, env: { APP_ORIGIN: 'https://watchlater.example' }, now: () => base, randomBytes: size => new Uint8Array(size).fill(255) });
  assert.equal((await api.handle({ type: 'cloud-export' }, null)).code, 'unauthorized');
  assert.equal((await api.status(null)).authenticated, false);
  const paired = await api.handle({ type: 'cloud-pair' }, owner); assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
  const ping = await api.handle({ type: 'cloud-ping' }, { ...owner, device: true, deviceToken: paired.token }); assert.equal(ping.scope, 'owner');
  const stored = f.sqlite.prepare('SELECT token_hash FROM rs_devices').get(); assert.match(stored.token_hash, /^[a-f0-9]{64}$/); assert(!JSON.stringify(stored).includes(paired.token));
});
