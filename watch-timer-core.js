/* Local viewing-time state. Absolute deadlines, never decrementing counters. */
(() => {
  const KEY = 'watchViewingTimer', DEFAULT_KEY = 'watchTimerDefaultMinutes';
  const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 180;
  const defaultMinutes = value => validMinutes(value) ? value : 15;
  const idle = () => ({ phase: 'idle', id: null, revision: 0, durationMinutes: 15, remainingMs: 0, deadline: null, dismissed: false });
  const normalize = value => {
    if (!value || !['running', 'paused', 'expired', 'idle'].includes(value.phase) || !Number.isSafeInteger(value.revision) || value.revision < 0) return idle();
    if (value.phase !== 'idle' && (typeof value.id !== 'string' || !/^[\w-]{1,100}$/.test(value.id) || !validMinutes(value.durationMinutes))) return idle();
    if (value.phase === 'running' && (!Number.isFinite(value.deadline) || value.deadline <= 0)) return idle();
    if (value.phase === 'paused' && (!Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > 180 * 60000)) return idle();
    return { ...idle(), ...value };
  };
  const remaining = (state, now) => state.phase === 'running' ? Math.max(0, state.deadline - now) : state.phase === 'paused' ? state.remainingMs : 0;
  const project = (state, now) => state.phase === 'running' && remaining(state, now) === 0
    ? { ...state, phase: 'expired', remainingMs: 0 } : state;
  const format = ms => { const seconds = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  const api = { KEY, DEFAULT_KEY, validMinutes, defaultMinutes, idle, normalize, remaining, project, format };
  globalThis.MVSWatchTimerCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
