import { createDatabase } from './database.mjs';
import * as V from './validation.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const fail = (code, details = {}) => Object.assign(Error(code), { code, ...details });
const byteLength = value => new TextEncoder().encode(value).byteLength;
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const opaque = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The route supplies this context only after private Sites authentication and
// same-origin browser checks. The authenticated extension bridge also needs its paired key.
export function createApi({ db, env = {}, fetch: request = globalThis.fetch, now = Date.now,
  randomBytes = size => crypto.getRandomValues(new Uint8Array(size)) } = {}) {
  const database = db?.rpc ? db : db ? createDatabase(db, { now }) : null;
  const rpc = (owner, name, args = {}) => {
    if (!database) throw fail('not_configured');
    return database.rpc(`rs_${name}`, { p_user_id: owner, p_args: args });
  };
  const token = () => opaque(randomBytes(32));
  const send = data => byteLength(JSON.stringify(data)) > MAX_BODY ? { ok: false, code: 'response_too_large' } : data;
  const budget = async (user, needs) => {
    const result = await rpc(user, 'rate', { action: 'reserve', needs });
    if (!result?.ok) throw fail('rate_limited', { retryAt: result?.retryAt || now() + 60000, rateLimitSource: result?.source || 'local' });
  };
  const reader = async (user, path, method = 'GET', body) => {
    let response;
    try {
      response = await request(`https://readwise.io/api/v3/${path}`, {
        method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Token ${env.READER_TOKEN.trim()}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw fail(method === 'DELETE' ? 'delete_uncertain' : method === 'PATCH' ? 'save_uncertain' : 'network_error'); }
    if (response.status === 429) {
      const retry = response.headers?.get('Retry-After');
      const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - now();
      const retryAt = now() + Math.max(60000, Number.isFinite(delay) ? Math.min(delay, 86400000) : 60000);
      await rpc(user, 'rate', { action: 'block', until: retryAt });
      throw fail('rate_limited', { retryAt, rateLimitSource: 'reader' });
    }
    if ([401, 403].includes(response.status)) throw fail('reader_unauthorized');
    if (response.status === 404 && method === 'GET') return { results: [] };
    if (!response.ok || method === 'DELETE' && response.status !== 204) throw fail(method === 'DELETE' ? 'delete_uncertain' : method === 'PATCH' ? 'save_uncertain' : 'reader_error');
    if (method !== 'GET') return null;
    let result;
    try { result = await response.json(); } catch { throw fail('reader_error'); }
    if (!Array.isArray(result?.results) || result.results.length > 100) throw fail('reader_error');
    return result;
  };
  const readDocument = async (user, videoUrl, id, allowMissing = false) => {
    const data = await reader(user, `list/?id=${encodeURIComponent(id)}`);
    const raw = data.results.find(item => item.id === id);
    if (!raw || raw.is_deleted) { if (allowMissing) return null; throw fail('not_found'); }
    const doc = V.cleanDocument(raw, videoUrl, id);
    if (!doc) throw fail('identity_changed');
    return doc;
  };
  const retained = async (user, message) => {
    if (V.canonical(message.videoUrl) !== message.videoUrl || !V.validId(message.id)) throw fail('invalid_request');
    const row = await rpc(user, 'item', { videoUrl: message.videoUrl });
    if (!row || row.readerId !== message.id || row.status === 'deleted') throw fail('document_changed');
    return row;
  };
  const snapshot = doc => ({ id: doc.id, videoUrl: doc.videoUrl, title: doc.readerTitle, notes: doc.readerNotes, updatedAt: doc.updatedAt });

  const status = async context => {
    const authenticated = context?.ownerId === 'owner' && context?.device !== true;
    const settings = authenticated && database ? await rpc('owner', 'settings', { action: 'get' }) : {};
    return { ok: true, configured: Boolean(database), authenticated, theme: settings.theme || 'system', timerDefault: settings.timerDefault || 15,
      readerEnabled: Boolean(env.READER_TOKEN?.trim()), raindropEnabled: Boolean(env.RAINDROP_TOKEN?.trim()) };
  };
  const handle = async (message, context) => {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message) || byteLength(JSON.stringify(message)) > MAX_BODY) throw fail('invalid_request');
      if (context?.ownerId !== 'owner') throw fail('unauthorized');
      if (!database) throw fail('not_configured');
      const user = { id: 'owner', device: context.device === true };
      const run = (name, args) => rpc(user.id, name, args);
      if (user.device) {
        const allowed = ['cloud-import', 'cloud-ping'].includes(message.type) || message.type === 'viewing-timer' && ['get','expire','dismiss'].includes(message.action || 'get');
        if (!allowed) throw fail('forbidden');
        if (typeof context.deviceToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(context.deviceToken)) throw fail('unauthorized');
        const device = await run('device', { action: 'get', hash: await hash(context.deviceToken) });
        if (!device?.valid) throw fail('unauthorized');
      }
      if (message.type === 'cloud-ping') return send({ ok: true, scope: user.id });
      if (message.type === 'cloud-pair') {
        const deviceToken = token();
        await run('device', { action: 'create', hash: await hash(deviceToken) });
        return send({ ok: true, token: deviceToken, origin: env.APP_ORIGIN, scope: user.id });
      }
      if (message.type === 'cloud-revoke') { await run('device', { action: 'revoke' }); return send({ ok: true }); }
      if (['cloud-settings', 'cloud-prefs'].includes(message.type)) {
        const theme = message.theme, timerDefault = message.timerDefault;
        if (!['system', 'light', 'dark'].includes(theme) || !Number.isInteger(timerDefault) || timerDefault < 1 || timerDefault > 180) throw fail('invalid_request');
        const settings = await run('settings', { action: 'set', theme, timerDefault });
        return send({ ok: true, ...settings, raindropEnabled: Boolean(env.RAINDROP_TOKEN), readerEnabled: Boolean(env.READER_TOKEN?.trim()) });
      }
      if (message.type === 'cloud-import') {
        if (!Array.isArray(message.items) || message.items.length > 5) throw fail('invalid_request');
        const items = message.items.map(item => V.importedItem(item, now()));
        if (items.some(item => !item)) throw fail('invalid_request');
        const accepted = await run('import', { items });
        return send({ ok: true, scope: user.id, accepted });
      }
      if (message.type === 'cloud-item') {
        if (V.canonical(message.videoUrl) !== message.videoUrl) throw fail('invalid_request');
        const item = await run('item', { videoUrl: message.videoUrl });
        return send(item ? { ok: true, item } : { ok: false, code: 'not_found' });
      }
      if (message.type === 'watch-list-page' || message.type === 'cloud-export') {
        if (!V.validCursor(message.cursor)) throw fail('invalid_request');
        const args = { cursor: message.cursor || null, export: message.type === 'cloud-export' };
        if (!args.export) {
          if (!['watch', 'all', 'later', 'shortlist', 'archive'].includes(message.filter || 'watch') || ['query', 'channel', 'tag'].some(key => message[key] != null && (typeof message[key] !== 'string' || message[key].length > (key === 'tag' ? 200 : 300)))) throw fail('invalid_request');
          Object.assign(args, { filter: message.filter || 'watch', terms: [...new Set(V.normalize(message.query).split(' ').filter(Boolean))], channel: V.normalize(message.channel), tag: V.normalize(message.tag) });
        }
        const page = await run('page', args);
        if (args.export) {
          // Keep full-row exports bounded for browsers and service intermediaries. JSON
          // escaping can expand control characters: shrink rare oversized pages
          // using the same keyset cursor, so no export records are lost.
          while (page.items.length > 1 && byteLength(JSON.stringify({ ok: true, ...page })) > MAX_BODY - 1024) {
            page.items.pop(); page.hasNext = true;
            const last = page.items.at(-1); page.nextCursor = [last.savedAt, last.videoUrl];
          }
        }
        return send({ ok: true, ...page });
      }
      if (message.type === 'cloud-edit') {
        if (V.canonical(message.videoUrl) !== message.videoUrl || !Number.isSafeInteger(message.revision) || message.revision < 0 || ['description', 'notes'].some(key => typeof message[key] !== 'string' || message[key].length > 64000)) throw fail('invalid_request');
        return send(await run('edit', { videoUrl: message.videoUrl, revision: message.revision, description: message.description, notes: message.notes }));
      }
      if (message.type === 'viewing-timer') {
        if (!['get', 'start', 'pause', 'resume', 'reset', 'expire', 'dismiss'].includes(message.action || 'get')) throw fail('invalid_request');
        if (message.action === 'start' && (!Number.isInteger(message.minutes) || message.minutes < 1 || message.minutes > 180)) throw fail('invalid_duration');
        return send(await run('timer', { action: message.action || 'get', id: message.id || null, revision: Number.isSafeInteger(message.revision) ? message.revision : -1, minutes: message.minutes || 15, newId: token(), now: now() }));
      }
      if (message.type === 'watch-card-action') {
        if (message.action !== 'raindrop' || V.canonical(message.videoUrl) !== message.videoUrl) throw fail('invalid_request');
        if (!env.RAINDROP_TOKEN) throw fail('missing_token');
        const row = await run('item', { videoUrl: message.videoUrl });
        if (!row || row.status === 'deleted') throw fail('document_changed');
        let result;
        try { result = await request('https://api.raindrop.io/rest/v1/raindrop', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${env.RAINDROP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ link: row.videoUrl, title: row.title, collection: { $id: -1 } }) }); } catch { throw fail('save_uncertain'); }
        if (!result.ok) throw fail('save_uncertain');
        const data = await result.json(); if (data?.result !== true) throw fail('save_uncertain');
        return send({ ok: true, saved: true });
      }
      if (['watch-list-refresh', 'watch-list-move', 'watch-list-prepare-delete'].includes(message.type)) {
        if (!env.READER_TOKEN?.trim()) throw fail('missing_token');
        const row = await retained(user.id, message);
        const moving = message.type === 'watch-list-move';
        if (moving && (!['later', 'shortlist', 'archive'].includes(message.location) || typeof message.baseLocation !== 'string')) throw fail('invalid_request');
        await budget(user.id, moving ? { list: 2, update: 1 } : { list: 1 });
        let doc = await readDocument(user.id, row.videoUrl, row.readerId, true);
        if (!doc) { await run('mark', { videoUrl: row.videoUrl, id: row.readerId, status: 'missing', now: now() }); throw fail('not_found'); }
        if (message.type === 'watch-list-prepare-delete') {
          const ticket = token();
          await run('ticket', { action: 'create', hash: await hash(ticket), snapshot: snapshot(doc) });
          return send({ ok: true, token: ticket, id: doc.id, title: doc.title, videoUrl: doc.videoUrl });
        }
        if (moving) {
          if (doc.location !== message.baseLocation) { await run('verify', { doc, now: now() }); throw fail('document_changed'); }
          await retained(user.id, message);
          await reader(user.id, `update/${encodeURIComponent(doc.id)}/`, 'PATCH', { location: message.location });
          try { doc = await readDocument(user.id, row.videoUrl, row.readerId); }
          catch (cause) { throw fail('save_uncertain', { retryAt: cause.retryAt, rateLimitSource: cause.rateLimitSource }); }
        }
        const item = await run('verify', { doc, now: now() });
        if (!item || item.readerId !== doc.id || item.status !== 'saved') throw fail('document_changed');
        if (moving && doc.location !== message.location) throw fail('location_not_applied');
        return send({ ok: true, item, ...(moving ? { location: doc.location } : {}) });
      }
      if (message.type === 'watch-list-delete') {
        if (!env.READER_TOKEN?.trim()) throw fail('missing_token');
        if (message.confirmed !== true || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) throw fail('invalid_request');
        // Taking the ticket is atomic and consumes it even if a later check fails.
        const captured = await run('ticket', { action: 'take', hash: await hash(message.token) });
        if (!captured) throw fail('confirmation_expired');
        await retained(user.id, { videoUrl: captured.videoUrl, id: captured.id });
        await budget(user.id, { list: 2, delete: 1 });
        const doc = await readDocument(user.id, captured.videoUrl, captured.id, true);
        if (!doc) { await run('mark', { videoUrl: captured.videoUrl, id: captured.id, status: 'missing', now: now() }); throw fail('delete_target_missing'); }
        if (!['id', 'videoUrl', 'title', 'notes', 'updatedAt'].every(key => snapshot(doc)[key] === captured[key])) throw fail('document_changed');
        await retained(user.id, { videoUrl: captured.videoUrl, id: captured.id });
        await reader(user.id, `delete/${encodeURIComponent(captured.id)}/`, 'DELETE');
        try { if (await readDocument(user.id, captured.videoUrl, captured.id, true)) throw fail('delete_uncertain'); }
        catch (cause) { throw fail('delete_uncertain', { retryAt: cause.retryAt, rateLimitSource: cause.rateLimitSource }); }
        await run('mark', { videoUrl: captured.videoUrl, id: captured.id, status: 'deleted', now: now() });
        return send({ ok: true });
      }
      throw fail('invalid_request');
    } catch (error) {
      const details = {};
      for (const key of ['retryAt', 'rateLimitSource']) if (error[key] !== undefined) details[key] = error[key];
      return { ok: false, code: error?.code || 'server_error', ...details };
    }
  };
  return { handle, status };
}
