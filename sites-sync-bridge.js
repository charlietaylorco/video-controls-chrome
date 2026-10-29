/* Private Sites relay. Owns only nonce-marked tabs it created; never reuses user tabs. */
(() => {
  const ORIGIN = 'https://watchlater.chimping.chatgpt.site', PATH = '/extension-sync';
  const KEY = 'recentSavesSitesRelay', CLOSE_ALARM = 'recent-saves-sites-relay-close';
  const nonceValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
  const create = ({ chrome = globalThis.chrome, timers = globalThis, now = Date.now, uuid = () => crypto.randomUUID(), timeoutMs = 12000, pollMs = 100 } = {}) => {
    let owned = null, opening = null, initialized = null, idleTimer = null, busy = 0;
    const fail = code => Object.assign(new Error(code), { code });
    const call = (api, name, ...args) => new Promise((resolve, reject) => {
      try { api[name](...args, value => chrome.runtime.lastError ? reject(fail('sign_in_required')) : resolve(value)); }
      catch { reject(fail('sign_in_required')); }
    });
    const persist = async record => {
      if (chrome.storage?.session) await call(chrome.storage.session, 'set', { [KEY]: record });
    };
    const validRecord = record => record && Number.isInteger(record.tabId) && record.tabId >= 0 && nonceValid(record.nonce) && record.url === ORIGIN + PATH + '#rs-' + record.nonce;
    const initialize = () => initialized ||= (async () => {
      if (!chrome.storage?.session) return;
      const data = await call(chrome.storage.session, 'get', { [KEY]: null });
      if (validRecord(data?.[KEY])) owned = data[KEY];
    })();
    const exact = (tab, record) => tab?.id === record.tabId && tab.url === record.url && !tab.pendingUrl && tab.incognito !== true;
    const forget = async record => {
      if (owned === record) { owned = null; await persist(null); }
    };
    const close = async () => {
      await initialize();
      if (busy || !owned) return;
      const record = owned;
      let tab; try { tab = await call(chrome.tabs, 'get', record.tabId); } catch { await forget(record); return; }
      // A navigated-away tab may now belong to the user. Never close it.
      if (exact(tab, record)) { try { await call(chrome.tabs, 'remove', record.tabId); } catch { /* already gone */ } }
      await forget(record);
    };
    const idle = () => {
      timers.clearTimeout(idleTimer);
      idleTimer = timers.setTimeout(() => { void close().catch(() => {}); }, 2000);
      try { const result = chrome.alarms?.create(CLOSE_ALARM, { when: now() + 60000 }); result?.catch?.(() => {}); } catch { /* session record is recoverable on next run */ }
    };
    chrome.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === CLOSE_ALARM) void close().catch(() => {}); });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'sites-sync-ready') return undefined;
      const record = owned;
      if (!record || sender.id !== chrome.runtime.id || sender.tab?.id !== record.tabId || sender.url !== record.url ||
          sender.frameId !== 0 || sender.documentLifecycle && sender.documentLifecycle !== 'active' || message.nonce !== record.nonce ||
          typeof sender.documentId !== 'string' || !sender.documentId) { respond({ ok: false }); return undefined; }
      record.documentId = sender.documentId; record.ready = true;
      void persist(record).catch(() => {}); respond({ ok: true }); return undefined;
    });
    const ensure = () => opening ||= (async () => {
      await initialize();
      if (owned) {
        const record = owned;
        let current;
        try { current = await call(chrome.tabs, 'get', record.tabId); } catch { /* a closed owned tab can be recreated */ }
        if (current && exact(current, record)) return record;
        await forget(record);
        if (current) throw fail('sign_in_required');
      }
      const nonce = uuid(); if (!nonceValid(nonce)) throw fail('relay_error');
      const url = ORIGIN + PATH + '#rs-' + nonce;
      const tab = await call(chrome.tabs, 'create', { url, active: false });
      if (!Number.isInteger(tab?.id) || tab.incognito === true) throw fail('sign_in_required');
      owned = { tabId: tab.id, nonce, url, ready: false, documentId: null };
      await persist(owned); idle(); return owned;
    })().finally(() => { opening = null; });
    const waitReady = async (record, signal) => {
      record.ready = false; record.documentId = null;
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        if (signal?.aborted || owned !== record) throw fail('connection_changed');
        const tab = await call(chrome.tabs, 'get', record.tabId);
        if (tab.incognito || tab.pendingUrl && tab.pendingUrl !== record.url || tab.url && tab.url !== record.url && tab.url !== 'about:blank') throw fail('sign_in_required');
        if (exact(tab, record)) {
          // A challenge also recovers readiness after worker suspension, without
          // relying on a one-time content-script notification being replayed.
          try {
            const reply = await call(chrome.tabs, 'sendMessage', record.tabId, { type: 'sites-sync-check', nonce: record.nonce }, { frameId: 0 });
            if (reply?.ok && reply.nonce === record.nonce && reply.url === record.url && record.ready && record.documentId) return;
          } catch { /* document_idle script may not have been injected yet */ }
        }
        await new Promise(resolve => timers.setTimeout(resolve, pollMs));
      }
      throw fail('sign_in_required');
    };
    const request = async (url, init = {}) => {
      if (url !== ORIGIN + '/api/recent-saves' || init.method !== 'POST') throw fail('invalid_request');
      let body; try { body = JSON.parse(init.body); } catch { throw fail('invalid_request'); }
      if (!['cloud-ping', 'cloud-import'].includes(body?.type) || body.type === 'cloud-import' && (!Array.isArray(body.items) || body.items.length > 25)) throw fail('invalid_request');
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(init.headers?.Authorization || '')?.[1];
      if (!token) throw fail('invalid_request');
      busy++; timers.clearTimeout(idleTimer);
      try {
        const record = await ensure(); await waitReady(record, init.signal);
        if (!exact(await call(chrome.tabs, 'get', record.tabId), record) || init.signal?.aborted) throw fail('sign_in_required');
        const requestId = uuid();
        const result = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, value) => { if (settled) return; settled = true; timers.clearTimeout(timer); init.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
          const abort = () => finish(fail('connection_changed'));
          const timer = timers.setTimeout(() => finish(fail('sign_in_required')), timeoutMs);
          init.signal?.addEventListener('abort', abort, { once: true });
          call(chrome.tabs, 'sendMessage', record.tabId, { type: 'sites-sync-request', nonce: record.nonce, requestId, token, body }, { frameId: 0, documentId: record.documentId })
            .then(value => finish(null, value), error => finish(error));
        });
        if (owned !== record || !exact(await call(chrome.tabs, 'get', record.tabId), record) || result?.nonce !== record.nonce || result?.requestId !== requestId || result?.url !== record.url) throw fail('sign_in_required');
        if (result.code) throw fail(result.code === 'sign_in_required' ? result.code : 'network_error');
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || !result.body || typeof result.body.ok !== 'boolean') throw fail('invalid_response');
        return { status: result.status, ok: result.status >= 200 && result.status < 300, json: async () => result.body };
      } finally { busy--; idle(); }
    };
    return { request, close };
  };
  const api = { create, ORIGIN, PATH, KEY, CLOSE_ALARM };
  globalThis.MVSSitesSyncBridge = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
