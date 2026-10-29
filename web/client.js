/* Hosted transport. Records and credentials are never persisted in browser storage. */
(() => {
  const authPath = kind => `/${kind === 'out' ? 'signout' : 'signin'}-with-chatgpt?return_to=%2F`;
  const createTransport = ({ request = globalThis.fetch } = {}) => {
    const listeners = new Set();
    let status = { authenticated: false, configured: true, authProvider: 'chatgpt', theme: 'system', timerDefault: 15 };
    const messageFor = result => ({
      auth_required: 'Your sign-in expired. Sign in again to continue.',
      forbidden: 'This account does not have access to Recent saves.',
      not_configured: 'The website needs its server settings before it can connect.',
      database_error: 'Cloud data is unavailable. Check the connection before trying again.',
      network_error: 'The website could not be reached. Your saved cloud records have not been cleared.',
      missing_token: 'Reader is not connected. Add its token to the website’s server settings.',
      unauthorized: 'Your sign-in expired. Sign in again to continue.',
      reader_unauthorized: 'Reader rejected its server token. Check the website’s Reader connection.',
      storage_error: 'Cloud storage is unavailable. Reader may already have changed; refresh before trying again.',
      identity_changed: 'The Reader document no longer matches this save. Refresh and review it before continuing.',
      confirmation_expired: 'Deletion approval expired or was already used. Choose Trash again to check the current document.',
      watch_storage_error: 'Cloud storage could not be updated. Reader may already have changed; refresh before retrying.',
      invalid_sender: 'This session is no longer current. Sign in again.',
      delete_cache_error: 'Reader confirmed deletion, but the cloud record could not be updated. Refresh to check.',
      location_cache_error: 'Reader changed, but the cloud record could not be updated. Refresh to check.',
      unavailable: 'The cloud service is unavailable. Try again when the project is running.',
    })[result?.code];
    const update = next => { status = { ...status, ...next }; for (const listener of listeners) listener(status); return status; };
    const raw = async (message, get = false) => {
      let response;
      try {
        response = await request(get ? '/api/recent-saves?type=cloud-status' : '/api/recent-saves', {
          method: get ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          ...(get ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }),
          signal: AbortSignal.timeout(60000),
        });
        const result = await response.json();
        if (response.status === 401) {
          update({ authenticated: false });
          if (globalThis.document) showAuth('Your sign-in expired. Sign in again to continue.');
        }
        return result && typeof result.ok === 'boolean' ? result : { ok: false, code: 'unavailable' };
      } catch { return { ok: false, code: response ? 'unavailable' : 'network_error' }; }
    };
    const ready = raw(null, true).then(result => update(result));
    const send = async message => {
      await ready;
      if (['auth-login', 'auth-logout'].includes(message.type)) return { ok: false, code: 'unsupported_auth_action' };
      if (!status.authenticated) return { ok: false, code: 'auth_required' };
      const result = await raw(message);
      if (result.ok && message.type === 'cloud-settings') update(result);
      return result;
    };
    return { ready, send, messageFor, get status() { return status; }, subscribe(listener) { listeners.add(listener); listener(status); return () => listeners.delete(listener); } };
  };
  const createTimer = ({ onChange, now = Date.now, timers = globalThis, transport = globalThis.MVSWatchTransport } = {}) => {
    const C = globalThis.MVSWatchTimerCore;
    let state = C.idle(), defaults = 15, timer, disposed = false, expiry = null, reminder;
    const remind = projected => {
      if (!globalThis.document) return;
      if (projected.phase !== 'expired' || projected.dismissed) { reminder?.remove(); reminder = null; return; }
      if (reminder) return;
      reminder = document.createElement('aside'); reminder.className = 'cloud-timer-reminder'; reminder.setAttribute('role', 'status');
      const text = document.createElement('p'); text.textContent = 'Viewing time is up. A good moment for a break.'; reminder.append(text);
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; reminder.append(dismiss);
      dismiss.addEventListener('click', async () => { dismiss.disabled = true; const result = await action('dismiss'); if (!result.ok) { dismiss.disabled = false; text.textContent = 'Could not dismiss the reminder. Try again.'; } });
      document.body.append(reminder);
    };
    const render = () => {
      timers.clearTimeout(timer); if (disposed) return;
      const projected = C.project(state, now()); onChange(projected, defaults, C.remaining(state, now())); remind(projected);
      if (state.phase === 'running' && projected.phase === 'expired' && expiry !== state.id) { expiry = state.id; void action('expire'); }
      else if (state.phase === 'running' && projected.phase !== 'expired') timer = timers.setTimeout(render, Math.min(1000, C.remaining(state, now())));
    };
    const action = async (name, extra = {}) => {
      const result = await transport.send({ type: 'viewing-timer', action: name, id: state.id, revision: state.revision, ...extra });
      if (disposed) return result;
      if (result.state) { const next = C.normalize(result.state); if (next.revision >= state.revision) state = next; }
      if (result.defaultMinutes !== undefined) defaults = C.defaultMinutes(result.defaultMinutes);
      render(); return result;
    };
    const wake = () => { if (!globalThis.document?.hidden) { expiry = null; void action('get'); } };
    globalThis.document?.addEventListener('visibilitychange', wake);
    globalThis.window?.addEventListener('pageshow', wake);
    globalThis.window?.addEventListener('focus', wake);
    const ready = transport.ready.then(status => status.authenticated ? action('get') : { ok: false, code: 'auth_required' });
    return { ready, action, refresh: render, dispose() { disposed = true; reminder?.remove(); timers.clearTimeout(timer); globalThis.document?.removeEventListener('visibilitychange', wake); globalThis.window?.removeEventListener('pageshow', wake); globalThis.window?.removeEventListener('focus', wake); } };
  };
  const showAuth = message => {
    const document = globalThis.document;
    if (!document) return;
    globalThis.MVSWatchExtras?.stop?.();
    for (const reminder of document.querySelectorAll('.cloud-timer-reminder')) reminder.remove();
    for (const page of document.querySelectorAll('main, .feedback, .cloud-session')) page.hidden = true;
    let section = document.getElementById('cloud-auth');
    if (!section) {
      section = document.createElement('section'); section.id = 'cloud-auth'; section.className = 'cloud-auth';
      const heading = document.createElement('h1'); heading.textContent = 'Recent saves'; section.append(heading);
      const lead = document.createElement('p'); lead.textContent = 'Sign in with ChatGPT to open your private library.'; section.append(lead);
      const link = document.createElement('a'); link.className = 'cloud-signin'; link.href = authPath('in'); link.target = '_top'; link.textContent = 'Sign in with ChatGPT'; section.append(link);
      const status = document.createElement('p'); status.id = 'cloud-auth-status'; status.setAttribute('role', 'status'); section.append(status);
      document.body.append(section);
    }
    section.hidden = false;
    document.getElementById('cloud-auth-status').textContent = message || '';
  };
  const api = { createTransport, createTimer, authPath };
  if (typeof module !== 'undefined') module.exports = api;
  if (!globalThis.document) return;
  const transport = globalThis.MVSWatchTransport = createTransport();
  globalThis.MVSWatchTimerClient = { create: createTimer };
  document.documentElement.classList.add('cloud-starting');
  transport.ready.then(status => {
    document.documentElement.classList.remove('cloud-starting');
    if (!status.ok || !status.configured || !status.authenticated) {
      showAuth(!status.ok ? 'The website could not connect. Reload to try again.' : !status.configured ? 'The website needs its server settings before sign-in is available.' : '');
      return;
    }
    const session = document.createElement('nav'); session.className = 'cloud-session'; session.setAttribute('aria-label', 'Account');
    const label = document.createElement('span'); label.textContent = 'Private Watchlater library'; session.append(label);
    const out = document.createElement('a'); out.href = authPath('out'); out.target = '_top'; out.textContent = 'Sign out'; session.append(out);
    document.body.append(session);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => { const choice = transport.status.theme; document.documentElement.dataset.theme = choice === 'system' ? media.matches ? 'dark' : 'light' : choice; };
    media.addEventListener('change', theme); theme();
  });
})();
