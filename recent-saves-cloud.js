/* Optional HTTPS sync. Only explicit, verified pairing can upload local history. */
(() => {
  const KEY = 'recentSavesCloud', ALARM = 'recent-saves-cloud';
  const origin = value => {
    try {
      if (typeof value !== 'string' || value !== value.trim() || /:\d+(?:[/?#]|$)/.test(value.replace(/^https:/i, ''))) return null;
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash ||
          !u.hostname.includes('.') || !/^[a-z0-9.-]+$/.test(u.hostname) || u.hostname.includes('..') || /[:\[\]]/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) ||
          u.hostname.endsWith('.') || /(^|\.)(localhost|local|internal)$/.test(u.hostname)) return null;
      return u.origin;
    } catch { return null; }
  };
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
  const validScope = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const create = ({ storage, store, fetch: request = globalThis.fetch, permissions, alarms, now = Date.now,
    uuid = () => crypto.randomUUID(), lastError = () => globalThis.chrome?.runtime?.lastError } = {}) => {
    let serial = Promise.resolve(), running = null, controller = null, operation = 0;
    const fail = code => Object.assign(new Error(code), { code });
    const read = () => new Promise((resolve, reject) => storage.get({ [KEY]: null }, data => lastError() ? reject(fail('storage_error')) : resolve(data[KEY])));
    const write = state => new Promise((resolve, reject) => storage.set({ [KEY]: state }, () => lastError() ? reject(fail('storage_error')) : resolve(state)));
    const locked = action => { const job = serial.then(action); serial = job.catch(() => {}); return job; };
    const current = (a, b) => Boolean(a && b && a.generation === b.generation && a.origin === b.origin && a.token === b.token && a.scope === b.scope);
    const allowed = site => new Promise(resolve => {
      if (!permissions?.contains) { resolve(false); return; }
      try { permissions.contains({ origins: [site + '/*'] }, value => resolve(!lastError() && value === true)); } catch { resolve(false); }
    });
    const schedule = when => {
      try { const result = when ? alarms?.create(ALARM, { when }) : alarms?.clear(ALARM); result?.catch?.(() => {}); } catch { /* next worker wake resumes durable work */ }
    };
    const publicState = state => ({ ok: true, connected: Boolean(state?.scope && validToken(state?.token)), origin: origin(state?.origin) || '',
      scope: state?.scope || '', phase: state?.phase || 'disconnected', ready: state?.phase === 'ready' && state?.importComplete === true,
      imported: state?.imported || 0, syncedAt: state?.syncedAt || 0, retryAt: state?.retryAt || 0, code: state?.error || '' });
    const status = async () => publicState(await read());
    const patchCurrent = (expected, patch) => locked(async () => {
      const state = await read();
      if (!current(state, expected)) return null;
      return write({ ...state, ...patch });
    });
    const api = async (state, body) => {
      if (!origin(state.origin) || !validToken(state.token) || !await allowed(state.origin)) throw fail('permission_required');
      const abort = new AbortController(); controller = abort;
      const timeout = setTimeout(() => abort.abort(), 15000);
      let response;
      try {
        response = await request(state.origin + '/api/recent-saves', { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: abort.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: JSON.stringify(body) });
      } catch { throw fail('network_error'); }
      finally { clearTimeout(timeout); if (controller === abort) controller = null; }
      if ([401, 403].includes(response.status)) throw fail('pairing_expired');
      if (!response.ok) throw fail(response.status === 429 ? 'rate_limited' : 'server_error');
      let result; try { result = await response.json(); } catch { throw fail('invalid_response'); }
      if (!result?.ok) throw fail(result?.code === 'unauthorized' ? 'pairing_expired' : 'server_error');
      if (!validScope(result.scope) || state.scope && result.scope !== state.scope) throw fail('account_changed');
      return result;
    };
    const connect = async (site, token) => {
      const normalized = origin(site);
      if (!normalized || !validToken(token)) return { ok: false, code: 'invalid_pairing' };
      const op = ++operation; controller?.abort();
      try {
        const result = await api({ origin: normalized, token }, { type: 'cloud-ping' });
        if (op !== operation) return { ok: false, code: 'connection_changed' };
        const state = await locked(async () => {
          if (op !== operation) return null;
          return write({ origin: normalized, token, scope: result.scope, generation: uuid(), phase: 'paired', importComplete: false,
            imported: 0, cursor: null, attempts: 0, retryAt: 0, error: '' });
        });
        schedule(null);
        return state ? publicState(state) : { ok: false, code: 'connection_changed' };
      } catch (e) { return { ok: false, code: e.code || 'network_error' }; }
    };
    const disconnect = async () => {
      ++operation; controller?.abort(); schedule(null);
      await locked(() => write(null)); return publicState(null);
    };
    const invalidateSource = async () => {
      ++operation; controller?.abort(); schedule(null);
      await locked(async () => {
        const state = await read();
        if (state) await write({ ...state, generation: uuid(), phase: 'paused', importComplete: false, retryAt: 0, error: 'reader_account_changed' });
      });
    };
    const resume = () => {
      if (running) return running;
      running = (async () => {
        let state = await read();
        if (!state || !['importing', 'ready'].includes(state.phase)) return;
        if (state.retryAt > now()) { schedule(state.retryAt); return; }
        try {
          // Five rows keep bounded 64k summaries/20k descriptions below request
          // limits even with multibyte text. Bound a worker run; each batch saves its cursor before
          // the next request, so worker suspension/restart safely repeats a batch.
          for (let batches = 0; batches < 10; batches++) {
            if (!current(await read(), state)) return;
            const importing = state.phase === 'importing';
            const page = importing ? await store.exportPage(state.cursor, 5) : await store.dirtyPage(5);
            if (!page.items.length) {
              if (importing) {
                state = await patchCurrent(state, { phase: 'ready', importComplete: true, cursor: null, attempts: 0, retryAt: 0, error: '', syncedAt: now() });
                if (!state) return;
                continue;
              }
              await patchCurrent(state, { attempts: 0, retryAt: 0, error: '', syncedAt: now() }); schedule(null); return;
            }
            const result = await api(state, { type: 'cloud-import', items: page.items });
            if (!current(await read(), state)) return;
            const expected = new Set(page.items.map(row => row.videoUrl));
            if (!Array.isArray(result.accepted) || result.accepted.length !== expected.size ||
                new Set(result.accepted).size !== expected.size || result.accepted.some(url => !expected.has(url))) throw fail('incomplete_acknowledgement');
            // A newer local update keeps its durable dirty marker.
            const acknowledged = await locked(async () => {
              if (!current(await read(), state)) return false;
              await store.acknowledge(page.items); return true;
            });
            if (!acknowledged || !current(await read(), state)) return;
            const complete = importing && !page.hasNext;
            state = await patchCurrent(state, { imported: state.imported + (importing ? page.items.length : 0),
              ...(importing ? { cursor: page.nextCursor, phase: complete ? 'ready' : 'importing', importComplete: complete } : {}),
              syncedAt: now(), attempts: 0, retryAt: 0, error: '' });
            if (!state) return;
          }
          schedule(now() + 60000);
        } catch (e) {
          const attempts = (state?.attempts || 0) + 1;
          const stopped = ['pairing_expired', 'account_changed', 'permission_required'].includes(e.code);
          const retryAt = stopped ? 0 : now() + Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6));
          const updated = await patchCurrent(state, { attempts, retryAt, error: e.code || 'storage_error', ...(stopped ? { phase: 'paused' } : {}) });
          if (updated) schedule(retryAt || null);
        }
      })().catch(() => {}).finally(() => { running = null; });
      return running;
    };
    const startImport = async () => {
      ++operation; controller?.abort();
      const state = await locked(async () => {
        const value = await read();
        if (!value || !validScope(value.scope) || value.phase === 'paused') return null;
        return write({ ...value, generation: uuid(), phase: 'importing', importComplete: false, cursor: null, imported: 0, attempts: 0, retryAt: 0, error: '' });
      });
      if (!state) return { ok: false, code: 'pairing_required' };
      schedule(now() + 1000); void resume(); return publicState(state);
    };
    const dirty = async () => {
      const state = await read();
      if (state && ['ready', 'importing'].includes(state.phase)) schedule(Math.max(now() + 2000, state.retryAt || 0));
    };
    const destination = async () => {
      const state = await read();
      return state?.phase === 'ready' && state.importComplete && origin(state.origin) && await allowed(state.origin) ? state.origin + '/' : null;
    };
    const handle = async message => {
      try {
        if (message.action === 'status') return await status();
        if (message.action === 'connect') {
          const saved = await read();
          const token = message.token || (saved?.origin === origin(message.origin) ? saved.token : '');
          return await connect(message.origin, token);
        }
        if (message.action === 'import') return await startImport();
        if (message.action === 'disconnect') return await disconnect();
        return { ok: false, code: 'invalid_request' };
      } catch { return { ok: false, code: 'storage_error' }; }
    };
    return { handle, status, connect, disconnect, invalidateSource, startImport, resume, dirty, destination };
  };
  const api = { create, origin, validToken, KEY, ALARM };
  globalThis.MVSRecentSavesCloud = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
