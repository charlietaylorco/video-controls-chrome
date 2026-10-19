/* Trusted extension-page bridge. No token or note text is returned to Watch list. */
(() => {
  const create = ({ store, reader, now = Date.now, uuid = () => crypto.randomUUID() }) => {
    const C = globalThis.MVSReaderCore, W = globalThis.MVSReaderWatchCore;
    const tickets = new Map(), refreshing = new Map();
    const error = code => Object.assign(new Error(code), { code });
    const target = async message => {
      const url = C.canonical(message.videoUrl);
      if (!url || url !== message.videoUrl) throw error('invalid_request');
      const row = await store.get(url);
      if (!row || row.status === 'deleted') throw error('not_found');
      if (!C.validId(row.readerId)) throw error('unlinked');
      if (message.id && row.readerId !== message.id) throw error('document_changed');
      return row;
    };
    const refresh = async (message, context) => {
      const row = await target(message), key = row.videoUrl + ':' + row.readerId;
      if (refreshing.has(key)) return refreshing.get(key);
      const work = (async () => {
        const result = await reader.handle({ type: 'reader-watch-get', pageUrl: row.videoUrl, id: row.readerId }, context);
        if (!result.ok) return { ok: false, code: result.code, retryAt: result.retryAt, rateLimitSource: result.rateLimitSource };
        const current = await store.get(row.videoUrl);
        if (current?.readerId !== row.readerId) throw error('document_changed');
        if (!await store.verify(row.videoUrl, result.document)) throw error('document_changed');
        return { ok: true };
      })();
      refreshing.set(key, work); try { return await work; } finally { refreshing.delete(key); }
    };
    const handle = async (message, context = {}) => {
      try {
        if (message.type === 'watch-list-page') return { ok: true, ...await store.page({ filter: message.filter, cursor: message.cursor }) };
        if (message.type === 'watch-list-refresh') return await refresh(message, context);
        if (message.type === 'watch-list-move') {
          const row = await target(message);
          const result = await reader.handle({ type: 'reader-watch-move', pageUrl: row.videoUrl, id: row.readerId,
            location: message.location, baseLocation: message.baseLocation }, context);
          if (result.document && !await store.verify(row.videoUrl, result.document)) throw error('document_changed');
          return { ok: result.ok, code: result.code, retryAt: result.retryAt, rateLimitSource: result.rateLimitSource };
        }
        if (message.type === 'watch-list-prepare-delete') {
          const row = await target(message);
          const result = await reader.handle({ type: 'reader-watch-prepare-delete', pageUrl: row.videoUrl, id: row.readerId }, context);
          if (!result.ok) return { ok: false, code: result.code, retryAt: result.retryAt, rateLimitSource: result.rateLimitSource };
          const doc = result.document;
          if ((await store.get(row.videoUrl))?.readerId !== doc.id) throw error('document_changed');
          for (const [key, ticket] of tickets) if (ticket.expires < now()) tickets.delete(key);
          while (tickets.size >= 20) tickets.delete(tickets.keys().next().value);
          const token = uuid(); tickets.set(token, { doc, scope: context.scope, expires: now() + 120000 });
          return { ok: true, token, id: doc.id, title: doc.title, videoUrl: row.videoUrl };
        }
        if (message.type === 'watch-list-delete') {
          const ticket = tickets.get(message.token); tickets.delete(message.token);
          if (!ticket || ticket.expires < now() || ticket.scope !== context.scope || message.confirmed !== true) throw error('invalid_confirmation');
          const doc = ticket.doc, row = await target({ videoUrl: doc.videoUrl, id: doc.id });
          const result = await reader.handle({ type: 'reader-watch-delete', pageUrl: row.videoUrl, id: doc.id, confirmed: true,
            title: doc.title, baseNotes: doc.notes, updatedAt: doc.updatedAt }, context);
          if (result.code === 'delete_target_missing') await store.mark(row.videoUrl, doc.id, 'missing');
          if (result.ok) {
            if (result.deleted !== true || result.verifiedAbsent !== true || result.deleteStatus !== 204 || result.id !== doc.id || result.targetUrl !== row.videoUrl)
              throw error('delete_unverified');
            await store.mark(row.videoUrl, doc.id, 'deleted');
          }
          return { ok: result.ok, code: result.code, retryAt: result.retryAt, rateLimitSource: result.rateLimitSource };
        }
        throw error('invalid_request');
      } catch (e) { return { ok: false, code: e.code || 'watch_storage_error' }; }
    };
    return { handle };
  };
  globalThis.MVSReaderWatchService = { create };
})();
