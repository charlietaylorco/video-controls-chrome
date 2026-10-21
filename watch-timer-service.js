/* One serialized timer per extension profile. No network or permission requests. */
(() => {
  const create = ({ storage, now = Date.now, uuid = () => crypto.randomUUID(), alarms = null }) => {
    const C = globalThis.MVSWatchTimerCore;
    let queue = Promise.resolve();
    const read = () => new Promise((resolve, reject) => storage.get({ [C.KEY]: null, [C.DEFAULT_KEY]: 15 }, data =>
      globalThis.chrome?.runtime?.lastError ? reject(Error('storage_error')) : resolve(data)));
    const write = state => new Promise((resolve, reject) => storage.set({ [C.KEY]: state }, () =>
      globalThis.chrome?.runtime?.lastError ? reject(Error('storage_error')) : resolve()));
    const arm = state => {
      // Optional only: #23's existing alarms permission can wake a suspended
      // worker. Visible YouTube clients also check the persisted deadline.
      try {
        const work = state.phase === 'running' ? alarms?.create('watch-viewing-timer', { when: state.deadline }) : alarms?.clear('watch-viewing-timer');
        work?.catch?.(() => {});
      } catch { /* Optional alarms must never require another permission. */ }
    };
    const handle = message => {
      const work = queue.then(async () => {
        const data = await read(), at = now(), previous = C.normalize(data[C.KEY]);
        let state = C.project(previous, at);
        const action = message.action || 'get';
        const same = message.id === state.id;
        if (action === 'start' && !['running', 'paused'].includes(state.phase)) {
          if (!C.validMinutes(message.minutes)) return { ok: false, code: 'invalid_duration', state, defaultMinutes: C.defaultMinutes(data[C.DEFAULT_KEY]) };
          if (message.revision !== previous.revision) return { ok: false, code: 'timer_changed', state, defaultMinutes: C.defaultMinutes(data[C.DEFAULT_KEY]) };
          state = { ...C.idle(), id: uuid(), phase: 'running', durationMinutes: message.minutes, deadline: at + message.minutes * 60000 };
        } else if (action === 'pause' && same && state.phase === 'running') {
          state = { ...state, phase: 'paused', remainingMs: C.remaining(state, at), deadline: null };
        } else if (action === 'resume' && same && state.phase === 'paused') {
          state = { ...state, phase: 'running', deadline: at + state.remainingMs, remainingMs: 0 };
        } else if (action === 'reset' && same) state = { ...C.idle(), durationMinutes: state.durationMinutes };
        else if (action === 'dismiss' && same && state.phase === 'expired') state = { ...state, dismissed: true };
        else if (!['get', 'expire', 'start', 'pause', 'resume', 'reset', 'dismiss'].includes(action)) return { ok: false, code: 'invalid_request' };
        // Start is idempotent while a timer exists. Captured IDs keep a stale
        // page's pause/reset/dismiss from affecting a newer session.
        if (JSON.stringify(state) !== JSON.stringify(previous)) { state.revision = previous.revision + 1; await write(state); }
        arm(state);
        return { ok: true, state, defaultMinutes: C.defaultMinutes(data[C.DEFAULT_KEY]) };
      }).catch(() => ({ ok: false, code: 'storage_error' }));
      queue = work.then(() => {}); return work;
    };
    return { handle };
  };
  globalThis.MVSWatchTimerService = { create };
})();
