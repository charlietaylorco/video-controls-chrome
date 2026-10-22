/* Indexed history has no rolling expiry/count cap. Only summary cache is evicted. */
(() => {
  const create = ({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange,
    storage, now = Date.now, notify = () => {}, name = 'mvs-reader-watch-v1' } = {}) => {
    const C = globalThis.MVSReaderCore, W = globalThis.MVSReaderWatchCore;
    let opening, initializing;
    const fail = () => Object.assign(new Error('watch_storage_error'), { code: 'watch_storage_error' });
    const open = () => opening ||= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(fail()); return; }
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
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
      const result = await transaction(['items', 'summaries'], 'readwrite', (tx, done) => {
        const items = tx.objectStore('items'), summaries = tx.objectStore('summaries');
        const request = items.get(videoUrl);
        request.onsuccess = () => {
          try {
            const row = change(request.result);
            if (!row) { done(null); return; }
            items.put(W.decorate(row)); done(row);
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
    const recordSave = (videoUrl, id, metadata = {}, { openExisting = false } = {}) => update(videoUrl, previous => {
      const at = now();
      return { ...previous, videoUrl, readerId: C.validId(id) ? id : previous?.status === 'saved' ? previous.readerId : null,
        savedAt: openExisting && previous ? previous.savedAt : at, firstSavedAt: previous?.firstSavedAt || at,
        title: W.text(metadata.title, 500) || previous?.title || '', author: W.text(metadata.author, 300) || previous?.author || '',
        tags: previous?.readerId === id && previous.status === 'saved' ? previous.tags : null,
        location: previous?.readerId === id && previous.status === 'saved' ? previous.location : '',
        checkedAt: previous?.readerId === id && previous.status === 'saved' ? previous.checkedAt : 0, status: 'saved', provenance: 'extension' };
    });
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
    const page = async ({ filter = 'watch', cursor = null, query = '', channel = '', tag = '', isCurrent = () => true } = {}) => {
      const definition = W.indexFor(filter), criteria = W.searchCriteria(query, channel, tag);
      if (!definition || !W.validCursor(cursor) || !criteria) throw Object.assign(fail(), { code: 'invalid_request' });
      await ready();
      return transaction(['items', 'summaries'], 'readonly', (tx, done) => {
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
    };
    return { ready, recordSave, verify, mark, get, page };
  };
  globalThis.MVSReaderWatchStore = { create };
})();
