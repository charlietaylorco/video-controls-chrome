/* Recent saves uses existing worker actions and local flags, never credentials. */
(() => {
  const create = ({ send, announce }) => {
    const C = globalThis.MVSReaderCore, rows = new Set(), pending = new Set(), statuses = new Map(), statusTimers = new Map();
    const specs = {
      raindrop: { setting: 'showRaindrop', flags: 'raindropSavedUrls', idle: 'Save video to Raindrop', done: 'Saved in Raindrop', working: 'Saving to Raindrop…',
        path: 'M6 19h12a4 4 0 0 0 .7-7.94A7 7 0 0 0 5.2 9.1 5 5 0 0 0 6 19Z' },
      downie: { setting: 'showDownie', flags: 'downieSentUrls', idle: 'Send to Downie', done: 'Sent to Downie', working: 'Sending to Downie…',
        path: 'M12 4v9m-3.5-2.5 3.5 3.5 3.5-3.5M5 18h14' }
    };
    let ready = false, config = {};
    const initialChanges = {};
    const saved = { raindrop: new Set(), downie: new Set() };
    const readFlags = (action, flags) => { saved[action] = new Set(Object.entries(flags && typeof flags === 'object' ? flags : {}).filter(([, at]) => at).map(([url]) => C.canonical(url)).filter(Boolean)); };
    const render = row => {
      for (const [action, button] of Object.entries(row.buttons)) {
        const spec = specs[action], key = `${action}:${row.url}`, busy = pending.has(key);
        button.hidden = !ready || config[spec.setting] === false;
        button.disabled = !row.enabled || busy;
        const label = busy ? spec.working : saved[action].has(row.url) ? spec.done : spec.idle;
        button.title = label; button.setAttribute('aria-label', `${label}: ${row.title}`);
        button.setAttribute('aria-busy', String(busy)); button.dataset.saved = String(saved[action].has(row.url));
        button.dataset.status = busy ? 'loading' : statuses.get(key) || '';
      }
      row.group.hidden = Object.values(row.buttons).every(button => button.hidden);
    };
    const renderAll = () => rows.forEach(render);
    chrome.storage.local.get({ showRaindrop: true, showDownie: true, raindropSavedUrls: {}, downieSentUrls: {} }, data => {
      if (chrome.runtime.lastError) { config = { showRaindrop: false, showDownie: false }; ready = true; renderAll(); return; }
      config = { ...data, ...initialChanges }; ready = true;
      for (const [action, spec] of Object.entries(specs)) readFlags(action, config[spec.flags]);
      renderAll();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [action, spec] of Object.entries(specs)) {
        if (changes[spec.setting]) { config[spec.setting] = changes[spec.setting].newValue; if (!ready) initialChanges[spec.setting] = changes[spec.setting].newValue; }
        if (changes[spec.flags]) { readFlags(action, changes[spec.flags].newValue); if (!ready) initialChanges[spec.flags] = changes[spec.flags].newValue; }
      }
      renderAll();
    });
    const failure = (action, reply) => {
      if (reply.code === 'request_uncertain') return 'The request could not be confirmed. Check ' + (action === 'raindrop' ? 'Raindrop' : 'Downie') + ' before trying again.';
      if (reply.code === 'runtime_error') return 'The extension is unavailable. Reopen Recent saves after reloading the extension.';
      if (action === 'raindrop') return reply.code === 'missing_token' ? 'Add your Raindrop token in extension Options.'
        : reply.code === 'unauthorized' ? 'Check your Raindrop token in extension Options.' : 'Raindrop save failed. Try again.';
      return 'Could not send to Downie. Check that Downie is installed and its browser prompt is allowed, then try again.';
    };
    const activate = async (row, action) => {
      const key = `${action}:${row.url}`;
      if (!ready || !row.enabled || !row.group.isConnected || config[specs[action].setting] === false || pending.has(key) || C.canonical(row.url) !== row.url) return;
      const origin = row.buttons[action], hadFocus = document.activeElement === origin;
      clearTimeout(statusTimers.get(key)); statuses.delete(key);
      pending.add(key); renderAll();
      const reply = await send({ type: 'watch-card-action', action, pageUrl: row.url });
      pending.delete(key);
      if (reply.ok) saved[action].add(row.url);
      if ([...rows].some(current => current.url === row.url)) {
        statuses.set(key, reply.ok ? 'success' : 'error');
        statusTimers.set(key, setTimeout(() => { statuses.delete(key); statusTimers.delete(key); renderAll(); }, 1400));
      }
      renderAll();
      if (hadFocus && rows.has(row) && row.group.isConnected && !origin.disabled && !origin.hidden && document.activeElement === document.body) origin.focus({ preventScroll: true });
      announce(reply.ok ? (action === 'raindrop' ? 'Saved to Raindrop.' : 'Sent to Downie.') + (reply.stateWarning ? ' Local sent status could not be stored.' : '') : failure(action, reply), !reply.ok || Boolean(reply.stateWarning));
    };
    const attach = (parent, url) => {
      const group = document.createElement('div'); group.className = 'card-destination-actions'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Raindrop and Downie'); parent.append(group);
      const row = { group, url, title: 'video', enabled: false, buttons: {} }; rows.add(row);
      for (const [action, spec] of Object.entries(specs)) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'destination-action card-destination-action'; button.dataset.action = action;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', spec.path); svg.append(path); button.append(svg); group.append(button); row.buttons[action] = button;
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void activate(row, action); });
      }
      render(row);
      return { update(title, enabled) { row.title = title || 'video'; row.enabled = enabled; render(row); }, destroy() {
        row.enabled = false; rows.delete(row);
        for (const action of Object.keys(specs)) { const key = `${action}:${row.url}`; clearTimeout(statusTimers.get(key)); statusTimers.delete(key); statuses.delete(key); }
      } };
    };
    return { attach };
  };
  globalThis.MVSWatchCardActions = { create };
})();
