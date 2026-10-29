"use strict";
const test = require('node:test');
const { before } = test;
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
let createApi, importedItem;
before(async () => {
  ({ createApi } = await import('../watchlater/lib/api.mjs'));
  ({ importedItem } = await import('../watchlater/lib/validation.mjs'));
});
const owner = 'owner';
const videoUrl = 'https://www.youtube.com/watch?v=video1';
const env = { APP_ORIGIN: 'https://watchlater.example.com', READER_TOKEN: 'never-return-reader' };
const at = 2000000;
const row = { videoUrl, readerId: 'reader1', status: 'saved', title: 'Cloud', location: 'later', revision: 2 };
const readerDoc = overrides => ({ id: 'reader1', source_url: videoUrl, title: 'Reader title', author: 'Channel', location: 'later', notes: 'Reader note', summary: 'Summary', tags: [], updated_at: '2026-10-29T12:00:00Z', ...overrides });
const json = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function fixture({ rpc, fetch: customFetch, environment = env, currentUser = owner } = {}) {
  const calls = [], network = [];
  const api = createApi({ env: environment, now: () => at, randomBytes: size => new Uint8Array(size).fill(7), db: { async rpc(name, params) {
    calls.push({ name, params }); assert.equal(params.p_user_id, owner);
    if (rpc) { const result = await rpc(name, params.p_args); if (result !== undefined) return result; }
    if (name === 'rs_device') return { valid: true };
    if (name === 'rs_settings') return { theme: 'dark', timerDefault: 20 };
    if (name === 'rs_item') return { ...row };
    if (name === 'rs_rate') return { ok: true };
    if (name === 'rs_verify') return { ...row };
    if (name === 'rs_page') return { items: [], hasNext: false, nextCursor: null };
    if (name === 'rs_import') return params.p_args.items.map(item => item.videoUrl);
    return {};
  } }, fetch: async (url, init) => {
    network.push({ url, init });
    if (customFetch) { const result = await customFetch(url, init); if (result !== undefined) return result; }
    if (url.includes('readwise.io/api/v3/list/')) return json({ results: [readerDoc()] });
    if (init.method === 'PATCH') return json({ id: 'reader1' });
    throw Error(`Unexpected network ${url}`);
  } });
  return { calls, network, api, async call(body = {}, extra = {}) {
    const authorization = extra.headers?.authorization;
    const context = { ownerId: currentUser, device: Boolean(authorization), deviceToken: authorization?.replace(/^Bearer /, '') };
    const result = extra.method === 'GET' ? await api.status(context) : await api.handle(body, context);
    return { statusCode: result.code === 'forbidden' ? 403 : result.code === 'unauthorized' ? 401 : result.code === 'server_error' ? 503 : 200, body: result };
  } };
}

test('paired devices have a narrow action allowlist and only hashed keys reach storage', async () => {
  const device = 'a'.repeat(43); const f = fixture();
  const ping = await f.call({ type: 'cloud-ping' }, { headers: { authorization: `Bearer ${device}`, origin: undefined, cookie: '' } });
  assert.deepEqual(ping.body, { ok: true, scope: owner });
  assert.equal(f.calls[0].params.p_args.hash, createHash('sha256').update(device).digest('hex'));
  assert.equal(f.network.length, 0);
  for (const body of [{ type: 'cloud-export' }, { type: 'cloud-edit' }, { type: 'cloud-pair' }, { type: 'watch-list-delete' }, { type: 'viewing-timer', action: 'start' }]) {
    const result = await f.call(body, { headers: { authorization: `Bearer ${device}` } }); assert.equal(result.statusCode, 403);
  }
});

test('revoked device keys reject imports despite a valid private browser context', async () => {
  const f = fixture({ rpc: async name => name === 'rs_device' ? { valid: false } : undefined });
  const result = await f.call({ type: 'cloud-import', items: [] }, { headers: { authorization: `Bearer ${'b'.repeat(43)}` } });
  assert.equal(result.statusCode, 401); assert.equal(f.calls.length, 1); assert.equal(f.network.length, 0);
});

test('imports validate the complete batch before writing and acknowledge owner scope', async () => {
  const f = fixture(); const item = { videoUrl, readerId: 'reader1', savedAt: at - 5000, updatedAt: at - 1000, title: 'Saved' };
  let result = await f.call({ type: 'cloud-import', items: [item, { ...item, videoUrl: 'https://evil.example/watch?v=x' }] });
  assert.equal(result.body.code, 'invalid_request'); assert(!f.calls.some(call => call.name === 'rs_import'));
  result = await f.call({ type: 'cloud-import', items: [item] });
  assert.deepEqual(result.body, { ok: true, scope: owner, accepted: [videoUrl] });
  const sent = f.calls.find(call => call.name === 'rs_import').params.p_args.items[0];
  assert.equal(sent.updatedAt, item.updatedAt); assert.equal(sent.description, '');
  assert.equal((await f.call({ type: 'cloud-import', items: Array(26).fill(item) })).body.code, 'invalid_request');
});

test('import sanitization excludes tokens, unknown metadata, future timestamps and malformed source IDs', () => {
  const cleaned = importedItem({ videoUrl, readerId: 'reader1', savedAt: at, readerToken: 'secret', html: '<script>', description: 'x'.repeat(65000), tags: ['Good', 3] }, at);
  assert.equal(cleaned.description.length, 64000); assert.deepEqual(cleaned.tags, ['Good']); assert(!Object.hasOwn(cleaned, 'readerToken')); assert(!Object.hasOwn(cleaned, 'html'));
  assert.equal(importedItem({ videoUrl, savedAt: at + 300001 }, at), null);
  assert.equal(importedItem({ videoUrl, savedAt: at, readerId: '../other' }, at), null);
});

test('query text reaches a parameterized bounded RPC and invalid cursors are rejected', async () => {
  const f = fixture(); const injection = "'); DROP TABLE rs_items;--";
  const result = await f.call({ type: 'watch-list-page', query: injection, channel: 'ＡLICE', tag: ' Long  Tag ', filter: 'all', cursor: [1000, videoUrl] });
  assert.equal(result.body.ok, true); const args = f.calls.at(-1).params.p_args;
  assert.equal(args.channel, 'alice'); assert.equal(args.tag, 'long tag'); assert.deepEqual(args.cursor, [1000, videoUrl]); assert.equal(args.export, false); assert(args.terms.includes('drop'));
  assert.equal((await f.call({ type: 'watch-list-page', cursor: [1000, 'https://evil.example'] })).body.code, 'invalid_request');
});

test('retained identity mismatch prevents Reader requests; fetched source mismatch prevents cloud updates', async () => {
  const f = fixture(); let result = await f.call({ type: 'watch-list-refresh', videoUrl, id: 'otherReader' });
  assert.equal(result.body.code, 'document_changed'); assert(!f.network.some(call => call.url.includes('readwise')));
  const g = fixture({ fetch: async url => url.includes('readwise') ? json({ results: [readerDoc({ source_url: 'https://www.youtube.com/watch?v=otherVideo' })] }) : undefined });
  result = await g.call({ type: 'watch-list-refresh', videoUrl, id: 'reader1' });
  assert.equal(result.body.code, 'identity_changed'); assert(!g.calls.some(call => call.name === 'rs_verify'));
});

test('moves send only location and verify actual fallback rather than claiming the requested destination', async () => {
  const f = fixture(); const result = await f.call({ type: 'watch-list-move', videoUrl, id: 'reader1', location: 'shortlist', baseLocation: 'later' });
  assert.equal(result.body.code, 'location_not_applied');
  const patch = f.network.find(call => call.init.method === 'PATCH'); assert.deepEqual(JSON.parse(patch.init.body), { location: 'shortlist' });
  assert(f.calls.some(call => call.name === 'rs_verify')); assert.deepEqual(f.calls.find(call => call.name === 'rs_rate').params.p_args.needs, { list: 2, update: 1 });
});

test('changed location preflight prevents all Reader writes', async () => {
  const f = fixture(); const result = await f.call({ type: 'watch-list-move', videoUrl, id: 'reader1', location: 'archive', baseLocation: 'shortlist' });
  assert.equal(result.body.code, 'document_changed'); assert(!f.network.some(call => call.init.method === 'PATCH'));
});

test('concurrent cloud identity changes cannot turn a no-op verification into success', async () => {
  const f = fixture({ rpc: async name => name === 'rs_verify' ? null : undefined });
  const result = await f.call({ type: 'watch-list-refresh', videoUrl, id: 'reader1' });
  assert.equal(result.body.code, 'document_changed');
});

const captured = { updatedAt: '2026-10-29T12:00:00Z', notes: 'Reader note', videoUrl, title: 'Reader title', id: 'reader1' };
test('deletion consumes a DB ticket once, accepts reordered snapshot keys and requires204 plus absent readback', async () => {
  let consumed = false, reads = 0;
  const f = fixture({ rpc: async (name, args) => { if (name === 'rs_ticket' && args.action === 'take') { if (consumed) return null; consumed = true; return { ...captured }; } }, fetch: async (url, init) => {
    if (!url.includes('readwise')) return;
    if (init.method === 'DELETE') return json(null, 204);
    return json({ results: ++reads === 1 ? [readerDoc()] : [] });
  } });
  const body = { type: 'watch-list-delete', token: 'a'.repeat(43), confirmed: true };
  assert.equal((await f.call(body)).body.ok, true); assert.equal(reads, 2);
  assert(f.calls.some(call => call.name === 'rs_mark' && call.params.p_args.status === 'deleted'));
  assert.equal((await f.call(body)).body.code, 'confirmation_expired');
  assert.equal(f.network.filter(call => call.init.method === 'DELETE').length, 1);
});

test('changed Reader note invalidates deletion without any mutation or automatic retry', async () => {
  const f = fixture({ rpc: async name => name === 'rs_ticket' ? captured : undefined, fetch: async url => url.includes('readwise') ? json({ results: [readerDoc({ notes: 'Changed on another device' })] }) : undefined });
  const result = await f.call({ type: 'watch-list-delete', token: 'a'.repeat(43), confirmed: true });
  assert.equal(result.body.code, 'document_changed'); assert(!f.network.some(call => call.init.method === 'DELETE')); assert(!f.calls.some(call => call.name === 'rs_mark'));
});

test('a non204 delete response is uncertain and never marks cloud history deleted', async () => {
  const f = fixture({ rpc: async name => name === 'rs_ticket' ? captured : undefined, fetch: async (url, init) => init.method === 'DELETE' ? json({ ok: true }, 200) : undefined });
  const result = await f.call({ type: 'watch-list-delete', token: 'a'.repeat(43), confirmed: true });
  assert.equal(result.body.code, 'delete_uncertain'); assert(!f.calls.some(call => call.name === 'rs_mark'));
  assert.equal(f.network.filter(call => call.init.method === 'DELETE').length, 1);
});

test('Reader429 persists shared cooldown and does not retry', async () => {
  const f = fixture({ fetch: async url => url.includes('readwise') ? json({}, 429, { 'Retry-After': '120' }) : undefined });
  const result = await f.call({ type: 'watch-list-refresh', videoUrl, id: 'reader1' });
  assert.deepEqual(result.body, { ok: false, code: 'rate_limited', retryAt: at + 120000, rateLimitSource: 'reader' });
  assert(f.calls.some(call => call.name === 'rs_rate' && call.params.p_args.action === 'block' && call.params.p_args.until === at + 120000));
  assert.equal(f.network.filter(call => call.url.includes('readwise')).length, 1);
});

test('persisted operation budget rejects before any Reader request', async () => {
  const f = fixture({ rpc: async name => name === 'rs_rate' ? { ok: false, source: 'local', retryAt: at + 5000 } : undefined });
  const result = await f.call({ type: 'watch-list-refresh', videoUrl, id: 'reader1' });
  assert.equal(result.body.code, 'rate_limited'); assert(!f.network.some(call => call.url.includes('readwise')));
});

test('personal edits use optimistic revision and never write Reader notes', async () => {
  const f = fixture({ rpc: async name => name === 'rs_edit' ? { ok: false, code: 'document_changed', item: row } : undefined });
  const result = await f.call({ type: 'cloud-edit', videoUrl, revision: 1, description: 'Mine', notes: 'Personal' });
  assert.equal(result.body.code, 'document_changed'); assert.equal(f.calls.at(-1).params.p_args.revision, 1);
  assert(!f.network.some(call => call.url.includes('readwise')));
});

test('raw storage errors never leak secrets or SQL diagnostics', async () => {
  const f = fixture({ rpc: async () => { throw Error('SQL diagnostic never-return-service'); } });
  const result = await f.call({ type: 'cloud-export' });
  assert.equal(result.statusCode, 503); assert.deepEqual(result.body, { ok: false, code: 'server_error' });
});


test('full-record reads are browser-only and do not expose service credentials', async () => {
  const full = { ...row, description: 'Saved description', notes: 'Personal note' };
  const f = fixture({ rpc: async name => name === 'rs_item' ? full : undefined });
  const result = await f.call({ type: 'cloud-item', videoUrl });
  assert.deepEqual(result.body, { ok: true, item: full });
  assert.equal((await f.call({ type: 'cloud-item', videoUrl }, { headers: { authorization: `Bearer ${'a'.repeat(43)}` } })).statusCode, 403);
});

test('12 card responses with maximum escaped summaries/tags fit the hosting response budget', async () => {
  const display = { ...row, contentPartial: true, title: '\u0001'.repeat(500), author: '\u0001'.repeat(300), location: '\u0001'.repeat(100), summary: '\u0001'.repeat(32768), summaryTruncated: true, tags: Array(100).fill('\u0001'.repeat(200)) };
  const items = Array.from({ length: 12 }, (_, n) => ({ ...display, videoUrl: `https://www.youtube.com/watch?v=card${n}`, savedAt: at - n }));
  const f = fixture({ rpc: async name => name === 'rs_page' ? { items, hasNext: false, nextCursor: null } : undefined });
  const result = await f.call({ type: 'watch-list-page' });
  assert.equal(result.body.items.length, 12); assert(Buffer.byteLength(JSON.stringify(result.body)) < 4 * 1024 * 1024);
  assert(!Object.hasOwn(result.body.items[0], 'description')); assert(!Object.hasOwn(result.body.items[0], 'notes'));
});

test('escaped full exports shrink safely without skipping rows and normal UTF8 exports fit four rows', async () => {
  const big = { ...row, description: '\u0001'.repeat(64000), notes: '\u0001'.repeat(64000), summary: '\u0001'.repeat(64000), tags: Array(100).fill('\u0001'.repeat(200)) };
  const items = Array.from({ length: 4 }, (_, n) => ({ ...big, videoUrl: `https://www.youtube.com/watch?v=export${n}`, savedAt: at - n }));
  const f = fixture({ rpc: async (name, args) => name === 'rs_page' ? { items: args.cursor ? [items[3]] : [...items], hasNext: false, nextCursor: null } : undefined });
  const first = await f.call({ type: 'cloud-export' });
  assert.equal(first.body.items.length, 3); assert.equal(first.body.hasNext, true);
  assert.deepEqual(first.body.nextCursor, [items[2].savedAt, items[2].videoUrl]);
  assert(Buffer.byteLength(JSON.stringify(first.body)) < 4 * 1024 * 1024);
  const second = await f.call({ type: 'cloud-export', cursor: first.body.nextCursor });
  assert.equal(second.body.items.length, 1); assert.equal(second.body.nextCursor, null);
  const utf8 = { ...big, description: '漢'.repeat(64000), notes: '漢'.repeat(64000), summary: '漢'.repeat(64000), tags: Array(100).fill('漢'.repeat(200)) };
  const g = fixture({ rpc: async name => name === 'rs_page' ? { items: Array(4).fill(utf8), hasNext: false, nextCursor: null } : undefined });
  assert.equal((await g.call({ type: 'cloud-export' })).body.items.length, 4);
});

test('a target absent after confirmation is missing, never reported as an owned successful deletion', async () => {
  const f = fixture({ rpc: async name => name === 'rs_ticket' ? captured : undefined, fetch: async url => url.includes('readwise') ? json({ results: [] }) : undefined });
  const result = await f.call({ type: 'watch-list-delete', token: 'a'.repeat(43), confirmed: true });
  assert.equal(result.body.code, 'delete_target_missing');
  assert(f.calls.some(call => call.name === 'rs_mark' && call.params.p_args.status === 'missing'));
  assert(!f.network.some(call => call.init.method === 'DELETE'));
});


test('Reader connection is optional for durable records and guarded only on Reader operations', async () => {
  const f = fixture({ environment: { ...env, READER_TOKEN: '' } });
  const status = await f.call({}, { method: 'GET', url: '/api/recent-saves?type=cloud-status' });
  assert.equal(status.body.configured, true); assert.equal(status.body.readerEnabled, false);
  assert.equal((await f.call({ type: 'cloud-export' })).body.ok, true);
  const before = f.calls.length;
  assert.equal((await f.call({ type: 'watch-list-refresh', videoUrl, id: 'reader1' })).body.code, 'missing_token');
  assert.equal(f.calls.length, before); assert(!f.network.some(call => call.url.includes('readwise')));
});


test('imports cap at five records to fit a bounded D1 invocation budget', async () => {
  const f = fixture(); const item = { videoUrl, readerId: 'reader1', savedAt: at - 1000 };
  assert.equal((await f.call({ type: 'cloud-import', items: Array(6).fill(item) })).body.code, 'invalid_request');
  assert(!f.calls.some(call => call.name === 'rs_import'));
  assert.equal((await f.call({ type: 'cloud-import', items: Array(5).fill(item) })).body.ok, true);
});


test('post-write Reader readback failures are uncertain and never retried or reported as saved/deleted', async () => {
  for (const type of ['watch-list-move', 'watch-list-delete']) {
    let reads = 0;
    const f = fixture({ rpc: async name => name === 'rs_ticket' ? captured : undefined, fetch: async (url, init) => {
      if (!url.includes('readwise')) return;
      if (init.method === 'DELETE') return json(null, 204);
      if (init.method === 'PATCH') return json({ id: 'reader1' });
      if (++reads === 1) return json({ results: [readerDoc()] });
      throw Error('network disconnected after mutation');
    } });
    const message = type === 'watch-list-move' ? { type, videoUrl, id: 'reader1', location: 'archive', baseLocation: 'later' } : { type, token: 'a'.repeat(43), confirmed: true };
    const result = await f.call(message);
    assert.equal(result.body.code, type === 'watch-list-move' ? 'save_uncertain' : 'delete_uncertain');
    assert.equal(f.network.filter(call => ['PATCH','DELETE'].includes(call.init.method)).length, 1);
    assert(!f.calls.some(call => ['rs_mark','rs_verify'].includes(call.name)));
  }
});


test('integration checks use read-only authentication requests and never expose tokens', async () => {
 const f=fixture({environment:{...env,RAINDROP_TOKEN:'private-raindrop'},fetch:(url,init)=>{assert.equal(init.method,'GET');return url.includes('readwise')?json(null,204):json({result:true});}});
 const result=await f.call({type:'cloud-check-integrations'});
 assert.deepEqual(result.body,{ok:true,reader:{configured:true,connected:true},raindrop:{configured:true,connected:true}});
 assert.ok(!JSON.stringify(result.body).includes('private-raindrop'));
 assert.equal((await f.call({type:'cloud-check-integrations'},{headers:{authorization:'Bearer '+'a'.repeat(43)}})).statusCode,403);
});
