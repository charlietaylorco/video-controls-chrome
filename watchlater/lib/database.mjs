import { normalize } from './validation.mjs';

const error = code => Object.assign(Error(code), { code });
const defaults = () => ({ theme: 'system', timerDefault: 15 });
const idle = () => ({ phase: 'idle', id: null, revision: 0, durationMinutes: 15, remainingMs: 0, deadline: null, dismissed: false });
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const item = row => row ? { ...JSON.parse(row.data), revision: row.revision } : null;

// D1 holds the records; browser storage is never an authority. All mutable
// read/modify/write operations use revision-guarded UPDATE/UPSERT RETURNING.
// Only these pure database operations can retry a CAS conflict. Reader writes
// remain single-attempt operations in api.mjs.
export function createDatabase(db, { now = Date.now } = {}) {
  const statement = (sql, values = []) => db.prepare(sql).bind(...values);
  const one = (sql, values) => statement(sql, values).first();
  const all = async (sql, values) => (await statement(sql, values).all()).results;
  const rawItem = (owner, url) => one('SELECT * FROM rs_items WHERE owner_id=? AND video_url=?', [owner, url]);
  const indexes = data => {
    const tags = data.status === 'saved' && Array.isArray(data.tags) ? data.tags : [];
    return [normalize(data.author), JSON.stringify(tags.map(normalize)), normalized([
      data.title, data.author, tags.join(' '), data.status === 'saved' ? data.summary : '', data.description, data.notes
    ].filter(Boolean).join(' '))];
  };
  const writeItem = async (owner, url, previous, next) => {
    const [channel, tags, search] = indexes(next.value);
    const values = [owner, url, next.value.savedAt, JSON.stringify(next.value), (previous?.revision || 0) + 1,
      next.localUpdatedAt ?? previous?.local_updated_at ?? 0, next.cloudUpdatedAt ?? previous?.cloud_updated_at ?? 0,
      next.contentEdited === undefined ? previous?.content_edited || 0 : Number(next.contentEdited), channel, tags, search, previous?.revision || 0];
    return one(`INSERT INTO rs_items(owner_id,video_url,saved_at,data,revision,local_updated_at,cloud_updated_at,content_edited,channel_norm,tags_norm,search_text)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,video_url) DO UPDATE SET
      saved_at=excluded.saved_at,data=excluded.data,revision=excluded.revision,local_updated_at=excluded.local_updated_at,
      cloud_updated_at=excluded.cloud_updated_at,content_edited=excluded.content_edited,channel_norm=excluded.channel_norm,tags_norm=excluded.tags_norm,search_text=excluded.search_text
      WHERE rs_items.revision=? RETURNING *`, values);
  };
  const mutateItem = async (owner, url, change) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await rawItem(owner, url);
      const decision = change(previous, item(previous));
      if (!decision?.next) return decision?.result ?? null;
      const saved = await writeItem(owner, url, previous, decision.next);
      if (saved) return decision.result === undefined ? item(saved) : decision.result;
    }
    throw error('storage_error');
  };
  const mutateState = async (table, owner, initial, change) => {
    if (!['rs_settings', 'rs_budgets'].includes(table)) throw error('invalid_request');
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await one(`SELECT data,revision FROM ${table} WHERE owner_id=?`, [owner]);
      const value = previous ? JSON.parse(previous.data) : initial();
      const decision = change(value);
      if (!decision?.next) return decision?.result;
      const saved = await one(`INSERT INTO ${table}(owner_id,data,revision) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET data=excluded.data,revision=excluded.revision WHERE ${table}.revision=? RETURNING revision`, [owner, JSON.stringify(decision.next), (previous?.revision || 0) + 1, previous?.revision || 0]);
      if (saved) return decision.result;
    }
    throw error('storage_error');
  };
  const page = async (owner, args) => {
    const clauses = ['owner_id=?'], values = [owner], count = args.export ? 4 : 12;
    if (args.cursor) { clauses.push('(saved_at < ? OR (saved_at = ? AND video_url < ?))'); values.push(args.cursor[0], args.cursor[0], args.cursor[1]); }
    if (!args.export) {
      clauses.push("json_extract(data,'$.status') <> 'deleted'");
      if (args.filter === 'watch') clauses.push("json_extract(data,'$.status') <> 'missing' AND coalesce(json_extract(data,'$.location'),'') NOT IN ('archive','feed')");
      else if (args.filter !== 'all') { clauses.push("json_extract(data,'$.status')='saved' AND json_extract(data,'$.location')=?"); values.push(args.filter); }
      if (args.channel) { clauses.push('channel_norm=?'); values.push(args.channel); }
      if (args.tag) { clauses.push('EXISTS(SELECT 1 FROM json_each(tags_norm) WHERE value=?)'); values.push(args.tag); }
      if (args.terms?.length) { clauses.push('NOT EXISTS(SELECT 1 FROM json_each(?) WHERE instr(search_text,value)=0)'); values.push(JSON.stringify(args.terms)); }
    }
    values.push(count + 1);
    const rows = await all(`SELECT data,revision FROM rs_items WHERE ${clauses.join(' AND ')} ORDER BY saved_at DESC,video_url DESC LIMIT ?`, values);
    const hasNext = rows.length > count;
    const items = rows.slice(0, count).map(row => {
      const full = item(row);
      if (args.export) return full;
      const { description, notes, ...display } = full;
      display.contentPartial = true;
      display.summary = typeof full.summary === 'string' ? full.summary.slice(0, 32768) : null;
      display.summaryTruncated = full.summaryTruncated === true || typeof full.summary === 'string' && full.summary.length > 32768;
      return display;
    });
    return { items, hasNext, nextCursor: hasNext ? [items.at(-1).savedAt, items.at(-1).videoUrl] : null };
  };
  const importItems = async (owner, items) => {
    const accepted = [];
    for (const incoming of items) {
      await mutateItem(owner, incoming.videoUrl, (old, previous) => {
        const { updatedAt, ...source } = incoming;
        if (!old) return { next: { value: source, localUpdatedAt: updatedAt, contentEdited: false }, result: true };
        const prior = { ...previous }; delete prior.revision;
        let merged = { ...prior };
        const fresh = incoming.status === 'saved' && incoming.readerId && incoming.readerId !== previous.readerId && incoming.savedAt > (previous.status === 'deleted' ? Math.max(old.cloud_updated_at, old.saved_at, previous.checkedAt || 0) : old.saved_at);
        if (fresh || updatedAt > old.local_updated_at && previous.status !== 'deleted' && incoming.checkedAt >= (previous.checkedAt || 0)) {
          const { description, notes, summary, summaryCheckedAt, summaryTruncated, ...metadata } = source;
          merged = { ...merged, ...metadata, firstSavedAt: Math.min(previous.firstSavedAt, incoming.firstSavedAt), savedAt: Math.max(previous.savedAt, incoming.savedAt) };
          if (incoming.durationIsLive) { merged.durationSeconds = null; merged.durationIsLive = true; }
          else if (incoming.durationSeconds == null) { merged.durationSeconds = previous.durationSeconds ?? null; merged.durationIsLive = previous.durationIsLive === true; }
          if (fresh) Object.assign(merged, { summary, summaryCheckedAt, summaryTruncated });
        }
        if (merged.status === 'saved' && incoming.readerId === merged.readerId && typeof incoming.summary === 'string' && incoming.summaryCheckedAt > (previous.summaryCheckedAt || 0)) {
          Object.assign(merged, { summary: incoming.summary, summaryCheckedAt: incoming.summaryCheckedAt, summaryTruncated: incoming.summaryTruncated });
        }
        if (!old.content_edited && !merged.description && incoming.description) merged.description = incoming.description;
        const localUpdatedAt = Math.max(old.local_updated_at, updatedAt);
        if (JSON.stringify(merged) === JSON.stringify(prior) && localUpdatedAt === old.local_updated_at) return { result: true };
        return { next: { value: merged, localUpdatedAt }, result: true };
      });
      accepted.push(incoming.videoUrl);
    }
    return accepted;
  };
  const settings = async (owner, args) => {
    if (args.action === 'set') return mutateState('rs_settings', owner, defaults, value => ({ next: { ...value, theme: args.theme, timerDefault: args.timerDefault }, result: { theme: args.theme, timerDefault: args.timerDefault } }));
    const record = await one('SELECT data FROM rs_settings WHERE owner_id=?', [owner]);
    const value = record ? JSON.parse(record.data) : defaults();
    return { theme: value.theme, timerDefault: value.timerDefault };
  };
  const timer = (owner, args) => mutateState('rs_settings', owner, defaults, settings => {
    const previous = settings.timer || idle(); let state = { ...previous };
    if (state.phase === 'running' && state.deadline <= args.now) state = { ...state, phase: 'expired', remainingMs: 0 };
    const result = code => ({ ok: !code, ...(code ? { code } : {}), state, defaultMinutes: settings.timerDefault });
    if (args.action === 'start' && !['running', 'paused'].includes(state.phase)) {
      if (args.revision !== previous.revision) return { result: result('timer_changed') };
      state = { ...idle(), id: args.newId, phase: 'running', durationMinutes: args.minutes, deadline: args.now + args.minutes * 60000 };
    } else if (['pause', 'resume', 'reset', 'dismiss'].includes(args.action) && args.id === state.id) {
      if (args.revision !== previous.revision) return { result: result('timer_changed') };
      if (args.action === 'pause' && state.phase === 'running') state = { ...state, phase: 'paused', remainingMs: Math.max(0, state.deadline - args.now), deadline: null };
      else if (args.action === 'resume' && state.phase === 'paused') state = { ...state, phase: 'running', deadline: args.now + state.remainingMs, remainingMs: 0 };
      else if (args.action === 'reset') state = { ...idle(), durationMinutes: state.durationMinutes };
      else if (args.action === 'dismiss' && state.phase === 'expired') state = { ...state, dismissed: true };
    }
    if (JSON.stringify(state) === JSON.stringify(previous)) return { result: result() };
    state.revision = previous.revision + 1;
    return { next: { ...settings, timer: state }, result: result() };
  });
  const rate = (owner, args) => mutateState('rs_budgets', owner, () => ({ blockedUntil: 0 }), budget => {
    if (args.action === 'block') return { next: { ...budget, blockedUntil: Math.max(budget.blockedUntil || 0, args.until) }, result: { ok: true } };
    const at = now();
    if (budget.blockedUntil > at) return { result: { ok: false, source: 'reader', retryAt: budget.blockedUntil } };
    const next = { ...budget };
    let retryAt = 0;
    for (const group of ['list', 'update', 'delete']) {
      const times = (budget[group] || []).filter(value => value > at - 60000).sort((a, b) => a - b);
      const needs = args.needs?.[group] || 0, maximum = group === 'update' ? 45 : 18;
      if (!Number.isInteger(needs) || needs < 0 || needs > maximum) throw error('invalid_request');
      if (times.length + needs > maximum) retryAt = Math.max(retryAt, times[0] + 60000);
      next[group] = [...times, ...Array(needs).fill(at)];
    }
    if (retryAt) return { result: { ok: false, source: 'local', retryAt } };
    return { next, result: { ok: true } };
  });

  return { async rpc(name, { p_user_id: owner, p_args: args = {} }) {
    if (owner !== 'owner') throw error('unauthorized');
    try {
      switch (name) {
        case 'rs_item': return item(await rawItem(owner, args.videoUrl));
        case 'rs_page': return await page(owner, args);
        case 'rs_import': return await importItems(owner, args.items);
        case 'rs_settings': return await settings(owner, args);
        case 'rs_timer': return await timer(owner, args);
        case 'rs_rate': return await rate(owner, args);
        case 'rs_edit': return await mutateItem(owner, args.videoUrl, (old, previous) => {
          if (!old) return { result: { ok: false, code: 'not_found' } };
          if (old.revision !== args.revision) return { result: { ok: false, code: 'document_changed', item: previous } };
          const { revision, ...value } = previous;
          Object.assign(value, { description: args.description, notes: args.notes });
          return { next: { value, contentEdited: true, cloudUpdatedAt: now() }, result: { ok: true, item: { ...value, revision: old.revision + 1 } } };
        });
        case 'rs_verify': return await mutateItem(owner, args.doc.videoUrl, (old, previous) => {
          const doc = args.doc;
          if (!old || previous.readerId !== doc.id || previous.status === 'deleted') return { result: null };
          const { revision, ...value } = previous;
          Object.assign(value, { readerId: doc.id, title: doc.title || previous.title, author: doc.author || previous.author, location: doc.location, tags: Array.isArray(doc.tags) ? doc.tags : previous.tags,
            summary: doc.summary, summaryTruncated: doc.summaryTruncated, summaryCheckedAt: args.now, checkedAt: args.now, status: 'saved' });
          return { next: { value, cloudUpdatedAt: args.now } };
        });
        case 'rs_mark': return await mutateItem(owner, args.videoUrl, (old, previous) => {
          if (!old || previous.readerId !== args.id || previous.status === 'deleted' && args.status === 'missing') return { result: {} };
          const { revision, ...value } = previous;
          Object.assign(value, { status: args.status, checkedAt: args.now });
          return { next: { value, cloudUpdatedAt: args.now }, result: {} };
        });
        case 'rs_device': {
          if (args.action === 'get') return { valid: Boolean(await one('SELECT 1 AS found FROM rs_devices WHERE owner_id=? AND token_hash=? AND expires_at>?', [owner, args.hash, now()])) };
          if (args.action === 'revoke') { await statement('DELETE FROM rs_devices WHERE owner_id=?', [owner]).run(); return { ok: true }; }
          if (args.action === 'create') {
            await db.batch([statement('DELETE FROM rs_devices WHERE owner_id=? AND expires_at<=?', [owner, now()]), statement('INSERT INTO rs_devices(token_hash,owner_id,expires_at) VALUES(?,?,?)', [args.hash, owner, now() + 90 * 86400000])]);
            return { ok: true };
          }
          throw error('invalid_request');
        }
        case 'rs_ticket': {
          if (args.action === 'take') {
            const row = await one('DELETE FROM rs_tickets WHERE owner_id=? AND token_hash=? AND expires_at>? RETURNING snapshot', [owner, args.hash, now()]);
            return row ? JSON.parse(row.snapshot) : null;
          }
          if (args.action === 'create') {
            await db.batch([statement('DELETE FROM rs_tickets WHERE owner_id=? AND expires_at<=?', [owner, now()]), statement('INSERT INTO rs_tickets(token_hash,owner_id,snapshot,expires_at) VALUES(?,?,?,?)', [args.hash, owner, JSON.stringify(args.snapshot), now() + 120000])]);
            return { ok: true };
          }
          throw error('invalid_request');
        }
        default: throw error('invalid_request');
      }
    } catch (cause) {
      if (['unauthorized', 'invalid_request', 'storage_error'].includes(cause?.code)) throw cause;
      throw error('storage_error');
    }
  } };
}
