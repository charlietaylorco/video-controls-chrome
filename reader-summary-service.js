/* One durable, bounded summary schedule per new save. Never stores notes or credentials. */
(() => {
  const KEY = 'readerSummaryJobs', WINDOW = 5 * 60000, DELAYS = [15000, 15000, 30000, 60000, 120000];
  const create = ({ storage, reader, now = Date.now, timers = globalThis, alarms = null }) => {
    const C = globalThis.MVSReaderCore, cache = new Map(), fetching = new Map();
    let queue = Promise.resolve(), timer, running = false;
    const read = defaults => new Promise((resolve, reject) => storage.get(defaults, data =>
      globalThis.chrome?.runtime?.lastError ? reject(new Error('storage_error')) : resolve(data)));
    const write = patch => new Promise((resolve, reject) => storage.set(patch, () =>
      globalThis.chrome?.runtime?.lastError ? reject(new Error('storage_error')) : resolve()));
    const serial = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
    const save = jobs => write({ [KEY]: jobs });
    const arm = jobs => {
      timers.clearTimeout?.(timer);
      const next = Object.values(jobs).filter(job => job.status === 'pending').map(job => job.nextAt);
      if (!next.length) { alarms?.clear('reader-summary'); return; }
      const at = Math.max(now() + 1, Math.min(...next));
      // The timer gives an awake worker the requested 15s check; the one-shot
      // alarm survives MV3 suspension. A late wake never restarts the budget.
      timer = timers.setTimeout?.(() => { void resume(); }, at - now());
      alarms?.create('reader-summary', { when: at });
    };
    const recordSave = (value, id, { alreadyExists = false, existingSummary = false } = {}) => serial(async () => {
      const url = C.canonical(value);
      if (!url || alreadyExists || existingSummary || cache.get(url)?.reply.document?.id === id && cache.get(url).reply.document.summary) return;
      const data = await read({ [KEY]: {} }), jobs = { ...data[KEY] };
      // A repeat notification of the same save must not restart its budget.
      if (jobs[url] && jobs[url].id === (C.validId(id) ? id : null)) return;
      cache.delete(url);
      jobs[url] = { id: C.validId(id) ? id : null, savedAt: now(), nextAt: now() + DELAYS[0], attempts: 0, status: 'pending' };
      // Bound metadata as well as network work. Old terminal entries are expendable.
      const entries = Object.entries(jobs).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 200);
      await save(Object.fromEntries(entries)); arm(Object.fromEntries(entries));
    });
    const resume = async () => {
      if (running) return;
      running = true;
      try {
        // Claim work durably before fetching. A killed worker consumes the attempt
        // and resumes at the next deadline instead of issuing duplicate reads.
        const claimed = await serial(async () => {
          const data = await read({ [KEY]: {}, readerToken: '', readerDocuments: {}, readerDeletedVideos: {} });
          const jobs = { ...data[KEY] }; let changed = false, selected;
          for (const [url, job] of Object.entries(jobs)) {
            if (job.status !== 'pending') continue;
            if (now() >= job.savedAt + WINDOW || job.attempts >= DELAYS.length || data.readerDeletedVideos[url] ||
                (job.id && data.readerDocuments[url]?.id && data.readerDocuments[url].id !== job.id)) {
              jobs[url] = { ...job, status: 'unavailable' }; changed = true; continue;
            }
            if (!selected && job.nextAt <= now()) selected = [url, job];
          }
          if (selected) {
            const [url, job] = selected, attempts = job.attempts + 1;
            jobs[url] = { ...job, attempts, nextAt: now() + (DELAYS[attempts] || 15000) };
            changed = true;
            selected = { url, job: jobs[url], token: data.readerToken };
          }
          if (changed) await save(jobs);
          return selected;
        });
        if (claimed) {
          const { url, job, token } = claimed;
          const isCurrent = async () => {
            const data = await read({ [KEY]: {}, readerToken: '', readerDeletedVideos: {}, readerDocuments: {} });
            const latest = data[KEY][url];
            return data.readerToken === token && latest?.savedAt === job.savedAt && latest?.id === job.id &&
              !data.readerDeletedVideos[url] && (!job.id || !data.readerDocuments[url]?.id || data.readerDocuments[url].id === job.id);
          };
          const reply = await reader.handle({ type: 'reader-summary-get', pageUrl: url }, { isCurrent, scope: 'summary-schedule' });
          await serial(async () => {
            if (!await isCurrent()) return;
            const jobs = { ...(await read({ [KEY]: {} }))[KEY] }, latest = jobs[url];
            const ready = reply.ok && Boolean(reply.document?.summary?.trim());
            const fatal = ['missing_token', 'unauthorized', 'auth_changed', 'invalid_sender', 'storage_error'].includes(reply.code);
            const exhausted = latest.attempts >= DELAYS.length || latest.nextAt >= latest.savedAt + WINDOW;
            const retryAt = Math.max(latest.nextAt, reply.retryAt || 0);
            jobs[url] = { ...latest, status: ready ? 'ready' : fatal ? 'error' : exhausted || retryAt >= latest.savedAt + WINDOW ? 'unavailable' : 'pending',
              nextAt: retryAt, code: reply.ok ? null : reply.code, retryAt: reply.retryAt, rateLimitSource: reply.rateLimitSource };
            if (reply.document && (!job.id || reply.document.id === job.id)) {
              cache.set(url, { reply, at: now(), savedAt: job.savedAt, jobId: job.id, token });
              while (cache.size > 50) cache.delete(cache.keys().next().value);
            }
            await save(jobs);
          });
        }
        const next = await serial(async () => {
          const jobs = (await read({ [KEY]: {} }))[KEY];
          // One API operation at a time, with headroom under Reader's shared budget.
          const next = Object.fromEntries(Object.entries(jobs).map(([url, job]) => [url,
            claimed && job.status === 'pending' && job.nextAt <= now() ? { ...job, nextAt: now() + 3500 } : job]));
          if (JSON.stringify(next) !== JSON.stringify(jobs)) await save(next);
          return next;
        });
        arm(next);
      } catch { /* Storage/worker failures never invalidate the successful save. Reopen/alarm can resume. */ }
      finally { running = false; }
    };
    const invalidateAuth = () => serial(async () => {
      cache.clear();
      const jobs = { ...(await read({ [KEY]: {} }))[KEY] };
      for (const [url, job] of Object.entries(jobs)) if (job.status === 'pending') jobs[url] = { ...job, status: 'error', code: 'auth_changed' };
      await save(jobs); arm(jobs);
    });
    const handle = async (message, context = {}) => {
      const reads = ['reader-panel-get', 'reader-card-get', 'reader-watch-get'];
      if (!reads.includes(message.type)) {
        const url = C.canonical(message.pageUrl || message.targetUrl);
        cache.delete(url);
        const result = await reader.handle(message, context);
        cache.delete(url);
        return result;
      }
      if (!await (context.isCurrent?.() ?? true)) return { ok: false, code: 'invalid_sender' };
      const url = C.canonical(message.targetUrl || message.pageUrl);
      const data = await read({ [KEY]: {}, readerToken: '', readerDocuments: {}, readerDeletedVideos: {} });
      const job = data[KEY][url];
      if (!job || data.readerDeletedVideos[url] || (job.id && data.readerDocuments[url]?.id && job.id !== data.readerDocuments[url].id))
        return reader.handle(message, context);
      const cached = cache.get(url);
      const validCache = cached?.savedAt === job.savedAt && cached.jobId === job.id && cached.token === data.readerToken && now() - cached.at < (cached.reply.ok ? 60000 : 5000);
      if (job.status === 'pending') {
        void resume();
        const state = { summaryState: 'pending', nextSummaryAt: job.nextAt };
        if (job.code) return { ok: false, code: job.code, retryAt: job.retryAt, rateLimitSource: job.rateLimitSource, ...state };
        return { ok: true, document: validCache ? cached.reply.document : null, code: 'summary_pending', ...state };
      }
      if (job.code && job.status === 'error' && !message.fresh) return { ok: false, code: job.code, retryAt: job.retryAt, rateLimitSource: job.rateLimitSource };
      if (validCache && !message.fresh) return { ...cached.reply, summaryState: job.status };
      // Ready/terminal jobs do not start another automatic schedule. Explicit
      // reads keep the existing refresh behavior (and service rate limits).
      const key = JSON.stringify([url, job.id, data.readerToken, job.savedAt]);
      if (!fetching.has(key)) {
        const isCurrent = async () => {
          const latest = await read({ [KEY]: {}, readerToken: '', readerDocuments: {}, readerDeletedVideos: {} });
          return latest.readerToken === data.readerToken && latest[KEY][url]?.savedAt === job.savedAt && latest[KEY][url]?.id === job.id &&
            !latest.readerDeletedVideos[url] && (!job.id || !latest.readerDocuments[url]?.id || latest.readerDocuments[url].id === job.id);
        };
        const work = reader.handle(message, { isCurrent, scope: 'summary-shared-read' }).then(async reply => {
          const current = await read({ [KEY]: {}, readerToken: '' });
          if (current.readerToken === data.readerToken && current[KEY][url]?.savedAt === job.savedAt && current[KEY][url]?.id === job.id && !['invalid_sender', 'auth_changed'].includes(reply.code))
            cache.set(url, { reply, at: now(), savedAt: job.savedAt, jobId: job.id, token: data.readerToken });
          return reply;
        });
        fetching.set(key, work); work.finally(() => fetching.delete(key));
      }
      const reply = await fetching.get(key);
      if (!await (context.isCurrent?.() ?? true)) return { ok: false, code: 'invalid_sender' };
      const latest = await read({ [KEY]: {}, readerToken: '', readerDocuments: {}, readerDeletedVideos: {} });
      return !latest.readerDeletedVideos[url] && (!job.id || !latest.readerDocuments[url]?.id || latest.readerDocuments[url].id === job.id) && latest.readerToken === data.readerToken && latest[KEY][url]?.savedAt === job.savedAt && latest[KEY][url]?.id === job.id
        ? reply : { ok: false, code: 'invalid_sender' };
    };
    return { recordSave, resume, invalidateAuth, summaryStates: async () => (await read({ [KEY]: {} }))[KEY], handle: (message, context) => handle(message, context).catch(() => ({ ok: false, code: 'storage_error' })), remember: (...args) => reader.remember(...args), savedState: (...args) => reader.savedState(...args) };
  };
  globalThis.MVSReaderSummaryService = { create };
})();
