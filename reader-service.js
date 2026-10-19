/* Runs only in the extension service worker. All authenticated requests stay here. */
(() => {
  const create = ({ storage, fetch: request, now = Date.now, history = null }) => {
    const C = globalThis.MVSReaderCore;
    const KEY = 'readerDocuments';
    let storageQueue = Promise.resolve();
    let operationQueue = Promise.resolve();
    const pending = new Map();
    let operationToken;
    let operationIsCurrent = () => true;
    const read = (defaults) => new Promise((resolve, reject) => storage.get(defaults, data =>
      chrome.runtime.lastError ? reject(new Error('storage_error')) : resolve(data)));
    const write = (data) => new Promise((resolve, reject) => storage.set(data, () =>
      chrome.runtime.lastError ? reject(new Error('storage_error')) : resolve()));
    const mutate = (fn) => {
      const result = storageQueue.then(async () => {
        const data = await read({ [KEY]: {}, readerDeletedVideos: {} });
        const index = data[KEY] && typeof data[KEY] === 'object' ? data[KEY] : {};
        const deleted = data.readerDeletedVideos && typeof data.readerDeletedVideos === 'object' ? data.readerDeletedVideos : {};
        const patch = {};
        await fn(index, deleted, patch);
        const entries = Object.entries(index).filter(([url, v]) => C.canonical(url) === url && C.validId(v?.id))
          .sort((a, b) => b[1].at - a[1].at).slice(0, 2000);
        const markers = Object.entries(deleted).filter(([url, v]) => C.canonical(url) === url && C.validId(v?.id) && Number.isFinite(v.at))
          .sort((a, b) => b[1].at - a[1].at).slice(0, 2000);
        await write({ ...patch, [KEY]: Object.fromEntries(entries), readerDeletedVideos: Object.fromEntries(markers) });
      });
      storageQueue = result.catch(() => {});
      return result;
    };
    // Existing one-click saves publish their timestamp flags and document id in
    // the same storage queue as deletion, so a late delete cannot erase a new save.
    const remember = (url, id, markSaved) => mutate(async (index, deleted) => {
      await markSaved?.();
      if (C.canonical(url) && C.validId(id)) index[C.canonical(url)] = { id, at: now() };
      if (C.canonical(url) && (C.validId(id) || markSaved)) delete deleted[C.canonical(url)];
    });
    const forget = (url, id) => mutate(index => { if (index[url]?.id === id) delete index[url]; });
    const forgetDeleted = (url, id, confirmedDeletion = false) => mutate(async (index, deleted, patch) => {
      const replacement = index[url] && index[url].id !== id;
      for (const [key, value] of Object.entries(index)) if (value?.id === id) delete index[key];
      const data = await read({ readerSavedUrls: {} });
      const flags = { ...data.readerSavedUrls };
      for (const key of Object.keys(flags)) {
        let readerId;
        try {
          const link = new URL(key);
          if (link.protocol === 'https:' && link.hostname === 'read.readwise.io') readerId = link.pathname.match(/\/(?:read)\/([\w-]+)\/?$/)?.[1];
        } catch { /* legacy flags may contain non-URLs */ }
        if ((!replacement && C.canonical(key) === url) || readerId === id) delete flags[key];
      }
      patch.readerSavedUrls = flags;
      // Absence alone is not evidence that this extension performed a deletion.
      if (confirmedDeletion && !replacement) deleted[url] = { id, at: now() };
    }).then(async () => { try { await history?.mark(url, id, confirmedDeletion ? 'deleted' : 'missing'); } catch { /* optional history must not alter existing Reader transport */ } });
    const savedState = async value => {
      const url = C.canonical(value);
      if (!url) return { saved: false, deleted: false };
      await storageQueue;
      const data = await read({ [KEY]: {}, readerSavedUrls: {}, readerDeletedVideos: {} });
      const marker = data.readerDeletedVideos?.[url], mapped = data[KEY]?.[url];
      const newer = C.validId(mapped?.id) && mapped.id !== marker?.id && mapped.at >= (marker?.at || 0);
      const deleted = C.validId(marker?.id) && !newer;
      const saved = !deleted && (C.validId(mapped?.id) || Object.entries(data.readerSavedUrls || {}).some(([key, at]) => at && C.canonical(key) === url));
      return { saved: Boolean(saved), deleted: Boolean(deleted), url };
    };
    const error = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
    // Operations are serialized, so checking the complete strict-delete cost
    // here prevents our own limiter from stranding its post-DELETE verification.
    // A prepared confirmation reserves nothing while the user considers it.
    const capacity = async (needs) => {
      const { readerToken, readerPanelBudget = {} } = await read({ readerToken: '', readerPanelBudget: {} });
      if (readerToken !== operationToken) throw error('auth_changed');
      if (typeof readerToken !== 'string' || !readerToken.trim()) throw error('missing_token');
      if (!(await operationIsCurrent())) throw error('invalid_sender');
      // Persist cooldowns across MV3 worker restarts. Fail fast instead of queuing stale edits.
      if (readerPanelBudget.blockedUntil > now()) throw error('rate_limited', { retryAt: readerPanelBudget.blockedUntil, rateLimitSource: 'reader' });
      let retryAt = 0;
      for (const [group, count] of Object.entries(needs)) {
        const times = (readerPanelBudget[group] || []).filter(t => t > now() - 60000).sort((a, b) => a - b);
        const max = group === 'update' ? 45 : 18; // leave headroom for other clients
        if (times.length + count > max) retryAt = Math.max(retryAt, times[times.length + count - max - 1] + 60000);
      }
      if (retryAt) throw error('rate_limited', { retryAt, rateLimitSource: 'local' });
      return { readerToken, readerPanelBudget };
    };
    const api = async (path, init = {}) => {
      const group = init.method === 'PATCH' ? 'update' : init.method === 'DELETE' ? 'delete' : 'list';
      const { readerToken, readerPanelBudget } = await capacity({ [group]: 1 });
      const times = (readerPanelBudget[group] || []).filter(t => t > now() - 60000);
      readerPanelBudget[group] = [...times, now()];
      await write({ readerPanelBudget });
      let response;
      try {
        response = await request(`https://readwise.io/api/v3/${path}`, {
          ...init, cache: 'no-store', signal: AbortSignal.timeout(15000), redirect: 'error', credentials: 'omit',
          headers: { Authorization: `Token ${readerToken.trim()}`, 'Content-Type': 'application/json' }
        });
      } catch { throw error(init.method === 'PATCH' ? 'save_uncertain' : init.method === 'DELETE' ? 'delete_uncertain' : 'network_error'); }
      if (response.status === 429) {
        const retry = response.headers?.get('Retry-After');
        const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - now();
        const retryAt = now() + Math.max(60000, Number.isFinite(delay) ? delay : 0);
        await write({ readerPanelBudget: { ...readerPanelBudget, blockedUntil: retryAt } });
        throw error('rate_limited', { retryAt, rateLimitSource: 'reader' });
      }
      if ([401, 403].includes(response.status)) throw error('unauthorized');
      if (response.status === 404) throw error('not_found');
      if (!response.ok) throw error(init.method === 'PATCH' ? 'save_uncertain' : init.method === 'DELETE' ? 'delete_uncertain' : 'reader_error');
      if (init.method === 'DELETE') {
        if (response.status !== 204) throw error('delete_uncertain');
        return null;
      }
      if (init.method === 'PATCH') return null; // update returns only id/url; do not replace document fields
      try {
        const data = await response.json();
        if (!Array.isArray(data.results)) throw error('reader_error');
        return data;
      } catch { throw error('reader_error'); }
    };
    const byId = async (url, id) => {
      let data;
      try { data = await api(`list/?id=${encodeURIComponent(id)}`); }
      catch (e) { if (e.code !== 'not_found') throw e; }
      const doc = data?.results.find(item => item.id === id);
      const clean = C.cleanDocument(doc, url);
      if (!clean) {
        if (!doc || doc.is_deleted) await forgetDeleted(url, id);
        else {
          await forget(url, id);
          try { await history?.mark(url, id, 'missing'); } catch { /* optional cache */ }
        }
        throw error('not_found');
      }
      if ((await read({ readerDeletedVideos: {} })).readerDeletedVideos?.[url]) await remember(url, clean.id);
      try { await history?.verify(url, clean); } catch { /* Watch list surfaces required cache errors in its own route */ }
      return clean;
    };
    const get = async (message) => {
      const url = C.canonical(message.pageUrl);
      if (!url) throw error('invalid_url');
      await storageQueue;
      const index = (await read({ [KEY]: {} }))[KEY];
      const id = index?.[url]?.id;
      if (C.validId(id)) {
        try { return { ok: true, document: await byId(url, id) }; }
        catch (e) { if (e.code !== 'not_found') throw e; }
      }
      // One page per panel lookup. Never sweep the library in a navigation loop.
      const cursor = typeof message.cursor === 'string' && message.cursor.length < 1000 ? message.cursor : '';
      const data = await api(`list/?category=video&limit=100${cursor ? `&pageCursor=${encodeURIComponent(cursor)}` : ''}`);
      const matches = data.results.map(doc => C.cleanDocument(doc, url)).filter(Boolean);
      if (matches.length > 1) throw error('ambiguous');
      await mutate((index, deleted) => {
        for (const doc of data.results) {
          const videoUrl = C.canonical(doc.source_url);
          if (C.cleanDocument(doc, videoUrl)) {
            if (!index[videoUrl]) index[videoUrl] = { id: doc.id, at: now() };
            delete deleted[videoUrl];
          }
        }
      });
      if (matches[0]) {
        try { await history?.verify(url, matches[0]); } catch { /* optional cache */ }
        return { ok: true, document: matches[0] };
      }
      return { ok: true, document: null, nextCursor: typeof data.nextPageCursor === 'string' ? data.nextPageCursor : null };
    };
    const saveNote = async (message) => {
      const url = C.canonical(message.pageUrl);
      if (!url || !C.validId(message.id) || typeof message.notes !== 'string' ||
          typeof message.baseNotes !== 'string' || message.notes.length > 500000) throw error('invalid_request');
      // Always fetch by the captured id AND verify source_url immediately before replacing notes.
      const doc = await byId(url, message.id);
      if (doc.notes !== message.baseNotes) return { ok: false, code: 'conflict', document: doc };
      if (message.notes !== doc.notes) {
        await api(`update/${encodeURIComponent(doc.id)}/`, { method: 'PATCH', body: JSON.stringify({ notes: message.notes }) });
      }
      return { ok: true, id: doc.id, notes: message.notes };
    };
    const deleteDocument = async (message, { requireDelete = false } = {}) => {
      const url = C.canonical(message.pageUrl), id = message.id;
      if (!url || !C.validId(id) || message.confirmed !== true || typeof message.baseNotes !== 'string' ||
          typeof message.title !== 'string' || typeof message.updatedAt !== 'string') throw error('invalid_delete');
      await storageQueue;
      const mapped = (await read({ [KEY]: {} }))[KEY]?.[url]?.id;
      if (mapped && mapped !== id) throw error('document_changed');
      if (requireDelete) await capacity({ list: 2, delete: 1 });
      let data;
      try { data = await api(`list/?id=${encodeURIComponent(id)}`); }
      catch (e) { if (e.code !== 'not_found') throw e; }
      const raw = data?.results.find(item => item.id === id);
      if (!raw || raw.is_deleted) {
        if (requireDelete) {
          // A stale hover identity is not evidence that this click deleted
          // anything. Retain saved flags so it can be explicitly re-linked.
          await forget(url, id);
          throw error('delete_target_missing');
        }
        await forgetDeleted(url, id);
        return { ok: true, id, alreadyDeleted: true };
      }
      const doc = C.cleanDocument(raw, url);
      if (!doc) throw error('document_changed');
      if (doc.notes !== message.baseNotes || doc.title !== message.title || doc.updatedAt !== message.updatedAt)
        return { ok: false, code: 'delete_conflict', document: doc };
      // Another save may have retained a replacement while the preflight was pending.
      await storageQueue;
      const latest = (await read({ [KEY]: {} }))[KEY]?.[url]?.id;
      if (latest && latest !== id) throw error('document_changed');
      let alreadyDeleted = false;
      try { await api(`delete/${encodeURIComponent(id)}/`, { method: 'DELETE' }); }
      catch (e) {
        if (e.code !== 'not_found') throw e;
        if (requireDelete) { await forget(url, id); throw error('delete_not_confirmed'); }
        alreadyDeleted = true;
      }
      if (requireDelete) {
        // Only a transport-confirmed DELETE plus an uncached read of the same
        // id can produce a hover success receipt. Never retry a mutation.
        let verification;
        try { verification = await api(`list/?id=${encodeURIComponent(id)}`); }
        catch (e) { if (e.code !== 'not_found') throw error('delete_uncertain', { retryAt: e.retryAt, rateLimitSource: e.rateLimitSource }); }
        const remaining = verification?.results.find(item => item.id === id);
        if (remaining && !remaining.is_deleted) throw error('delete_still_present');
        if (verification?.results.length && !remaining) throw error('delete_uncertain');
      }
      try { await forgetDeleted(url, id, !alreadyDeleted); }
      catch { throw error('delete_cache_error'); }
      return requireDelete ? { ok: true, id, targetUrl: url, deleted: true, deleteStatus: 204, verifiedAbsent: true }
        : { ok: true, id, alreadyDeleted };
    };
    const moveLocation = async message => {
      const url = C.canonical(message.pageUrl);
      if (!url || !C.validId(message.id) || !Object.hasOwn(C.locations, message.location) || typeof message.baseLocation !== 'string')
        throw error('invalid_location');
      const checkMapping = async () => {
        await storageQueue;
        const mapped = (await read({ [KEY]: {} }))[KEY]?.[url]?.id;
        if (mapped && mapped !== message.id) throw error('document_changed');
      };
      await checkMapping();
      const doc = await byId(url, message.id);
      if (doc.location !== message.baseLocation) return { ok: false, code: 'location_conflict', document: doc };
      if (doc.location === message.location) return { ok: true, document: doc };
      await checkMapping();
      try { await api(`update/${encodeURIComponent(doc.id)}/`, { method: 'PATCH', body: JSON.stringify({ location: message.location }) }); }
      catch (e) { if (e.code === 'save_uncertain') throw error('location_uncertain'); throw e; }
      // UPDATE returns only id/url; account configuration can redirect a move.
      // Read back the actual location instead of optimistically claiming success.
      let actual;
      try { actual = await byId(url, doc.id); }
      catch { throw error('location_uncertain'); }
      try { await write({ readerDocumentUpdates: { id: actual.id, videoUrl: url, location: actual.location, updatedAt: actual.updatedAt, at: now() } }); }
      catch { throw error('location_cache_error'); }
      return { ok: actual.location === message.location, code: actual.location === message.location ? undefined : 'location_not_applied', document: actual };
    };
    const getCard = async (message) => {
      const url = C.canonical(message.targetUrl);
      if (!url) throw error('invalid_request');
      await storageQueue;
      const data = await read({ [KEY]: {}, readerSavedUrls: {}, readerCardDiscoveryAt: 0 });
      const id = data[KEY]?.[url]?.id;
      if (C.validId(id)) {
        try { return { ok: true, document: await byId(url, id) }; }
        catch (e) { if (e.code !== 'not_found') throw e; return { ok: true, document: null, code: 'unlinked' }; }
      }
      if (!Object.entries(data.readerSavedUrls || {}).some(([key, saved]) => Boolean(saved) && C.canonical(key) === url))
        return { ok: true, document: null, code: 'not_saved' };
      // Shared, persisted cold-cache budget: one page total, no pagination on hover.
      if (data.readerCardDiscoveryAt > 0 && now() - data.readerCardDiscoveryAt < 60000)
        return { ok: true, document: null, code: 'unlinked' };
      await write({ readerCardDiscoveryAt: now() });
      const result = await get({ pageUrl: url });
      return { ok: true, document: result.document, code: result.document ? undefined : 'unlinked' };
    };
    const deleteCard = async (message) => {
      const url = C.canonical(message.targetUrl);
      await storageQueue;
      if (!url || !C.validId(message.id) || (await read({ [KEY]: {} }))[KEY]?.[url]?.id !== message.id)
        throw error('document_changed');
      return deleteDocument({ ...message, pageUrl: url }, { requireDelete: true });
    };
    const handle = (message, { isCurrent = () => true, scope = null } = {}) => {
      // Never share a rejected/stale visit's reply with a new visit or another tab.
      const key = ['reader-panel-get', 'reader-card-get'].includes(message.type)
        ? JSON.stringify([message.type, scope, message.pageUrl, message.targetUrl, message.cursor, message.visit]) : null;
      if (key && pending.has(key)) return pending.get(key);
      const result = operationQueue.then(async () => {
        operationIsCurrent = isCurrent;
        if (!(await operationIsCurrent())) throw error('invalid_sender');
        operationToken = (await read({ readerToken: '' })).readerToken;
        if (message.type === 'reader-panel-get') return get(message);
        if (message.type === 'reader-panel-save-note') return saveNote(message);
        if (message.type === 'reader-panel-delete') return deleteDocument(message);
        if (message.type === 'reader-panel-move') return moveLocation(message);
        if (['reader-watch-get', 'reader-watch-prepare-delete'].includes(message.type)) {
          const url = C.canonical(message.pageUrl);
          if (!url || !C.validId(message.id)) throw error('invalid_request');
          if (message.type === 'reader-watch-prepare-delete') await capacity({ list: 3, delete: 1 });
          return { ok: true, document: await byId(url, message.id) };
        }
        if (message.type === 'reader-watch-move') return moveLocation(message);
        if (message.type === 'reader-watch-delete') return deleteDocument(message, { requireDelete: true });
        if (message.type === 'reader-card-get') return getCard(message);
        if (message.type === 'reader-card-delete') return deleteCard(message);
        throw error('invalid_request');
      })
        .catch(e => ({ ok: false, code: e.code || 'storage_error', retryAt: e.retryAt, rateLimitSource: e.rateLimitSource }));
      operationQueue = result.then(() => {});
      if (key) { pending.set(key, result); result.finally(() => pending.delete(key)); }
      return result;
    };
    return { remember, handle, savedState };
  };
  globalThis.MVSReaderService = { create };
})();
