/* Shared page client: local rendering ticks; messages only for state changes/expiry. */
(() => {
  const create = ({ onChange, now = Date.now, timers = globalThis }) => {
    const C = globalThis.MVSWatchTimerCore;
    let state = C.idle(), defaults = 15, timer, disposed = false, expiry = null, defaultRevision = 0;
    const send = message => new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type: 'viewing-timer', ...message }, reply => resolve(chrome.runtime.lastError ? { ok: false, code: 'runtime_error' } : reply || { ok: false, code: 'runtime_error' })); }
      catch { resolve({ ok: false, code: 'runtime_error' }); }
    });
    const accept = next => {
      const normalized = C.normalize(next);
      if (normalized.revision >= state.revision) state = normalized;
    };
    const render = () => {
      timers.clearTimeout(timer);
      if (disposed) return;
      const current = C.project(state, now()); onChange(current, defaults, C.remaining(state, now()));
      if (state.phase === 'running' && current.phase === 'expired') {
        if (expiry !== state.id) { expiry = state.id; void action('expire'); }
      } else if (state.phase === 'running') timer = timers.setTimeout(render, Math.min(1000, C.remaining(state, now())));
    };
    const action = async (name, extra = {}) => {
      const defaultAtRequest = defaultRevision;
      const result = await send({ action: name, id: state.id, revision: state.revision, ...extra });
      if (disposed) return result;
      if (result.state) accept(result.state);
      if (defaultRevision === defaultAtRequest && result.defaultMinutes !== undefined) defaults = C.defaultMinutes(result.defaultMinutes);
      render(); return result;
    };
    const changed = (changes, area) => {
      if (area !== 'local') return;
      if (changes[C.KEY]) accept(changes[C.KEY].newValue);
      if (changes[C.DEFAULT_KEY]) { defaultRevision++; defaults = C.defaultMinutes(changes[C.DEFAULT_KEY].newValue); }
      if (changes[C.KEY] || changes[C.DEFAULT_KEY]) render();
    };
    const wake = () => { if (!document.hidden) { expiry = null; render(); } };
    chrome.storage.onChanged.addListener(changed);
    document.addEventListener('visibilitychange', wake); window.addEventListener('pageshow', wake); window.addEventListener('focus', wake);
    // A late initial reply cannot overwrite a newer storage notification.
    const ready = action('get');
    return { action, ready, refresh: render, dispose() {
      disposed = true; timers.clearTimeout(timer); chrome.storage.onChanged.removeListener?.(changed);
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('pageshow', wake); window.removeEventListener('focus', wake);
    } };
  };
  globalThis.MVSWatchTimerClient = { create };
})();
