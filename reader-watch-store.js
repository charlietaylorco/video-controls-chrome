/* Indexed history has no rolling expiry/count cap. Only summary cache is evicted. */
(() => {
  const create = ({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange,
    storage, now = Date.now, notify = () => {}, name = 'mvs-reader-watch-v1' } = {}) => {
    const C = globalThis.MVSReaderCore, W = globalThis.MVSReaderWatchCore;
    let opening, initializing;
    const fail = () => Object.assign(new Error('watch_storage_error'), { code: 'watch_storage_error' });
    const open = () => opening ||= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(fail()); return; }
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('cloudDirty', { keyPath: 'videoUrl' });
        if (db.objectStoreNames.contains('items')) return;
        const items = db.createObjectStore('items', { keyPath: 'videoUrl' });
        items.createIndex('recent', ['savedAt', 'videoUrl']);
        items.createIndex('queueRecent', ['queue', 'savedAt', 'videoUrl']);
        items.createIndex('activeRecent', ['active', 'savedAt', 'videoUrl']);
        items.createIndex('locationRecent', ['filterLocation', 'savedAt', 'videoUrl']);
        db.createObjectStore('meta');
        db.createObjectStore('summaries', { keyPath: 'videoUrl' }).createIndex('checkedAt', 'checkedAt');
      };
      request.onerror = request.onblocked = () => reject(fail());
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }).catch(() => { opening = null; throw fail(); });
    const transaction = async (names, mode, run) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        let value;
        const tx = db.transaction(names, mode);
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(fail());
        try { run(tx, result => { value = result; }); } catch { tx.abort(); }
      }).catch(() => { throw fail(); });
    };
    const ready = () => initializing ||= (async () => {
      const migrated = await transaction(['meta'], 'readonly', (tx, done) => {
        const r = tx.objectStore('meta').get('migrated'); r.onsuccess = () => done(r.result);
      });
      if (migrated) return;
      const retained = storage ? await new Promise((resolve, reject) => storage.get({ readerSavedUrls: {}, readerDocuments: {}, readerDeletedVideos: {} }, data =>
        globalThis.chrome?.runtime?.lastError ? reject(fail()) : resolve(data))) : {};
      await transaction(['items', 'meta'], 'readwrite', tx => {
        const items = tx.objectStore('items');
        for (const row of W.seeds(retained)) {
          const request = items.get(row.videoUrl); request.onsuccess = () => { try { if (!request.result) items.put(row); } catch { tx.abort(); } };
        }
        tx.objectStore('meta').put(true, 'migrated');
      });
    })().catch(error => { initializing = null; throw error; });
    const update = async (videoUrl, change, cached) => {
      if (C.canonical(videoUrl) !== videoUrl) throw Object.assign(fail(), { code: 'invalid_request' });
      await ready();
      const result = await transaction(['items', 'summaries', 'cloudDirty'], 'readwrite', (tx, done) => {
        const items = tx.objectStore('items'), summaries = tx.objectStore('summaries');
        const request = items.get(videoUrl);
        request.onsuccess = () => {
          try {
            const row = change(request.result);
            if (!row) { done(null); return; }
            row.updatedAt = Math.max(now(), (Number(request.result?.updatedAt) || 0) + 1);
            items.put(W.decorate(row));
            tx.objectStore('cloudDirty').put({ videoUrl, updatedAt: row.updatedAt });
            done(row);
            if (cached) {
              summaries.put(cached);
              const count = summaries.count(); count.onsuccess = () => {
                let excess = count.result - W.CACHE_SIZE;
                if (excess <= 0) return;
                const cursor = summaries.index('checkedAt').openCursor();
                cursor.onsuccess = () => { const c = cursor.result; if (c && excess-- > 0) { c.delete(); c.continue(); } };
              };
            } else {
              const old = summaries.get(videoUrl); old.onsuccess = () => { if (old.result && (old.result.id !== row.readerId || row.status !== 'saved')) summaries.delete(videoUrl); };
            }
          } catch { tx.abort(); }
        };
      });
      if (result) { try { await notify(videoUrl); } catch { /* history committed; notifications are best effort */ } }
      return result;
    };
    const durationCache = async () => {
      if (!storage) return {};
      try { return await new Promise(resolve => storage.get({ ytListsDurationCache: {}, ytListsFeedCache: {} }, data =>
        resolve(globalThis.chrome?.runtime?.lastError ? {} : data))); } catch { return {}; }
    };
    const recordSave = async (videoUrl, id, metadata = {}, { openExisting = false } = {}) => {
      const bound = C.canonical(metadata.durationVideoUrl) === videoUrl;
      const live = bound && metadata.durationIsLive === true;
      const captured = bound ? C.durationSeconds(metadata.durationSeconds) : null;
      const seconds = live ? null : captured || W.cachedDuration(videoUrl, await durationCache());
      return update(videoUrl, previous => {
        const at = now();
        const keepLive = live || (!captured && previous?.durationIsLive === true);
        return { ...previous, videoUrl, readerId: C.validId(id) ? id : previous?.status === 'saved' ? previous.readerId : null,
          savedAt: openExisting && previous ? previous.savedAt : at, firstSavedAt: previous?.firstSavedAt || at,
          title: W.text(metadata.title, 500) || previous?.title || '', author: W.text(metadata.author, 300) || previous?.author || '',
          description: typeof metadata.description === 'string' ? W.text(metadata.description, 20000) : previous?.description || '',
          durationSeconds: keepLive ? null : seconds || C.durationSeconds(previous?.durationSeconds),
          durationIsLive: keepLive,
          tags: previous?.readerId === id && previous.status === 'saved' ? previous.tags : null,
          location: previous?.readerId === id && previous.status === 'saved' ? previous.location : '',
          checkedAt: previous?.readerId === id && previous.status === 'saved' ? previous.checkedAt : 0, status: 'saved', provenance: 'extension' };
      });
    };
    const verify = (videoUrl, doc) => {
      if (doc.videoUrl !== videoUrl || !C.validId(doc.id)) return Promise.reject(fail());
      const at = now(), summary = W.text(doc.summary, W.SUMMARY_LIMIT);
      return update(videoUrl, previous => !previous || previous.status === 'deleted' || previous.readerId && previous.readerId !== doc.id && previous.status !== 'missing' ? null : {
        ...previous, readerId: doc.id, title: W.text(doc.title, 500) || previous.title, author: W.text(doc.author, 300) || previous.author,
        tags: Array.isArray(doc.tags) ? W.tags(doc.tags) : previous.readerId === doc.id && previous.status === 'saved' ? previous.tags : null, location: W.text(doc.location, 100), status: 'saved', checkedAt: at,
      }, { videoUrl, id: doc.id, summary, truncated: typeof doc.summary === 'string' && doc.summary.length > summary.length, checkedAt: at });
    };
    const mark = (videoUrl, id, status) => update(videoUrl, previous => previous?.readerId === id && !(previous.status === 'deleted' && status === 'missing')
      ? { ...previous, status, checkedAt: now() } : null);
    const get = async videoUrl => {
      await ready(); return transaction(['items'], 'readonly', (tx, done) => {
        const request = tx.objectStore('items').get(videoUrl); request.onsuccess = () => done(request.result || null);
      });
    };
    const cachedSummary = async (videoUrl, id) => {
      await ready();
      return transaction(['summaries'], 'readonly', (tx, done) => {
        const request = tx.objectStore('summaries').get(videoUrl);
        request.onsuccess = () => done(request.result?.id === id ? request.result.summary : null);
      });
    };
    const page = async ({ filter = 'watch', cursor = null, query = '', channel = '', tag = '', isCurrent = () => true } = {}) => {
      const definition = W.indexFor(filter), criteria = W.searchCriteria(query, channel, tag);
      if (!definition || !W.validCursor(cursor) || !criteria) throw Object.assign(fail(), { code: 'invalid_request' });
      await ready();
      const result = await transaction(['items', 'summaries'], 'readonly', (tx, done) => {
        const [index, prefix] = definition, rows = [];
        const range = keyRange.bound([prefix, 0, ''], cursor ? [prefix, ...cursor] : [prefix, Number.MAX_SAFE_INTEGER, '\uffff'], false, Boolean(cursor));
        // Only the bounded summary cache is searched up front. Stream retained
        // metadata through the existing location index; never load all history
        // into memory or call Reader. Unfiltered pages keep their 13-row fast path.
        const summaryMatches = new Map();
        const scanItems = () => {
          const request = tx.objectStore('items').index(index).openCursor(range, 'prev');
          request.onsuccess = () => {
            if (!isCurrent()) { done({ stale: true }); return; }
            const current = request.result;
            if (current && rows.length < W.PAGE_SIZE + 1) {
              const row = current.value, cached = summaryMatches.get(row.videoUrl);
              if (W.matches(row, criteria, cached?.id === row.readerId && row.status === 'saved' ? cached.terms : [])) rows.push(row);
              if (rows.length <= W.PAGE_SIZE) { current.continue(); return; }
            }
            const hasNext = rows.length > W.PAGE_SIZE, items = rows.slice(0, W.PAGE_SIZE);
            for (const item of items) {
              const summary = tx.objectStore('summaries').get(item.videoUrl);
              summary.onsuccess = () => {
                const cached = summary.result;
                item.summary = cached?.id === item.readerId && item.status === 'saved' ? cached.summary : null;
                item.summaryTruncated = Boolean(cached?.id === item.readerId && cached.truncated);
                item.summaryCheckedAt = cached?.id === item.readerId ? cached.checkedAt : 0;
              };
            }
            done({ items, hasNext, nextCursor: hasNext ? W.cursor(items.at(-1)) : null });
          };
        };
        if (!criteria.terms.length) scanItems();
        else {
          const summaries = tx.objectStore('summaries').openCursor();
          summaries.onsuccess = () => {
            if (!isCurrent()) { done({ stale: true }); return; }
            const current = summaries.result;
            if (!current) { scanItems(); return; }
            const cached = current.value, normalized = W.normalize(cached.summary);
            const terms = criteria.terms.filter(term => normalized.includes(term));
            if (terms.length) summaryMatches.set(cached.videoUrl, { id: cached.id, terms });
            current.continue();
          };
        }
      });
      // Enrich only this bounded page from existing local caches. Old records
      // need no schema rewrite, Reader request or YouTube fetch.
      if (!result.stale) {
        const missing = result.items.some(item => !item.durationIsLive && !C.durationSeconds(item.durationSeconds));
        const cached = missing ? await durationCache() : {};
        for (const item of result.items) item.durationSeconds = item.durationIsLive ? null : C.durationSeconds(item.durationSeconds) || W.cachedDuration(item.videoUrl, cached);
      }
      return isCurrent() ? result : { stale: true };
    };
    // Export only retained video metadata. Reader/Raindrop tokens and private note
    // drafts are never read, serialized, or sent to the website.
    const snapshot = (row, cached) => {
      const item = {};
      for (const key of ['videoUrl', 'readerId', 'savedAt', 'firstSavedAt', 'title', 'author', 'description', 'durationSeconds', 'durationIsLive', 'tags', 'location', 'checkedAt', 'status', 'provenance']) {
        if (row[key] !== undefined) item[key] = row[key];
      }
      item.updatedAt = Number(row.updatedAt) || Number(row.checkedAt) || row.savedAt;
      if (cached?.id === row.readerId && row.status === 'saved') {
        item.summary = cached.summary; item.summaryTruncated = Boolean(cached.truncated); item.summaryCheckedAt = cached.checkedAt;
      }
      return item;
    };
    const exportRows = async ({ cursor = null, limit = 25, dirty = false } = {}) => {
      if (!W.validCursor(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 25) throw Object.assign(fail(), { code: 'invalid_request' });
      await ready();
      const result = await transaction(['items', 'summaries', 'cloudDirty'], 'readonly', (tx, done) => {
        const rows = [], source = dirty ? tx.objectStore('cloudDirty') : tx.objectStore('items').index('recent');
        const range = !dirty && cursor ? keyRange.upperBound(cursor, true) : null;
        const request = source.openCursor(range, dirty ? 'next' : 'prev');
        request.onsuccess = () => {
          const current = request.result;
          if (current && rows.length < limit + 1) { rows.push(current.value); current.continue(); return; }
          const hasNext = rows.length > limit, selected = rows.slice(0, limit), items = [];
          for (const selectedRow of selected) {
            const append = row => {
              if (!row) return;
              const index = items.length; items.push(snapshot(row));
              const cached = tx.objectStore('summaries').get(row.videoUrl);
              cached.onsuccess = () => { items[index] = snapshot(row, cached.result); };
            };
            if (dirty) { const row = tx.objectStore('items').get(selectedRow.videoUrl); row.onsuccess = () => append(row.result); }
            else append(selectedRow);
          }
          done({ items, hasNext, nextCursor: !dirty && hasNext ? W.cursor(selected.at(-1)) : null });
        };
      });
      const cached = result.items.some(row => !row.durationIsLive && !C.durationSeconds(row.durationSeconds)) ? await durationCache() : {};
      for (const row of result.items) row.durationSeconds = row.durationIsLive ? null : C.durationSeconds(row.durationSeconds) || W.cachedDuration(row.videoUrl, cached);
      return result;
    };
    const acknowledge = async items => {
      await ready();
      return transaction(['cloudDirty'], 'readwrite', tx => {
        const dirty = tx.objectStore('cloudDirty');
        for (const item of items) {
          const request = dirty.get(item.videoUrl);
          request.onsuccess = () => { if (request.result?.updatedAt === item.updatedAt) dirty.delete(item.videoUrl); };
        }
      });
    };
    return { ready, recordSave, verify, mark, get, cachedSummary, page,
      exportPage: (cursor = null, limit = 25) => exportRows({ cursor, limit }),
      dirtyPage: (limit = 25) => exportRows({ limit, dirty: true }), acknowledge };

  };
  globalThis.MVSReaderWatchStore = { create };
})();
