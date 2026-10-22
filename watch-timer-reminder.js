/* Gentle local reminder on YouTube, including its HTML fullscreen player. */
(() => {
  if (window !== top || globalThis.mvsViewingReminder) return;
  globalThis.mvsViewingReminder = true;
  let state, host, message, dismiss, error, client;
  const mount = () => {
    if (host) return;
    host = document.createElement('div'); host.id = 'mvs-viewing-timer-reminder';
    const root = host.attachShadow({ mode: 'closed' }), style = document.createElement('style');
    style.textContent = `:host{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483646;width:min(430px,calc(100vw - 32px));color-scheme:light dark;font:14px/1.5 system-ui;color:#252720}:host([hidden]){display:none}section{padding:16px 18px;border:1px solid #d7d9d0;border-radius:12px;background:#fff;box-shadow:0 6px 24px #0002}strong{font-weight:600}p{margin:3px 0 12px}nav{display:flex;gap:16px;align-items:center}button,a{font:inherit;color:inherit}button{padding:6px 13px;border:1px solid #d7d9d0;border-radius:8px;background:#f1f2ed;cursor:pointer}a{font-size:12px}button:focus-visible,a:focus-visible{outline:2px solid #987126;outline-offset:2px}.error{font-size:12px;color:#a52b25;margin:8px 0 0}@media(prefers-color-scheme:dark){:host{color:#eeefe8}section{background:#22251f;border-color:#515749}button{background:#31362c;border-color:#515749}.error{color:#ffb4ab}}`;
    const section = document.createElement('section'); section.setAttribute('role', 'alert');
    const heading = document.createElement('strong'); heading.textContent = 'Your viewing timer is up';
    message = document.createElement('p');
    const actions = document.createElement('nav'); dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
    const link = document.createElement('a'); link.textContent = 'Recent saves'; link.href = chrome.runtime.getURL('watch.html'); link.target = '_blank'; link.rel = 'noopener noreferrer';
    error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'status'); error.hidden = true;
    dismiss.addEventListener('click', async () => { dismiss.disabled = true; const result = await client.action('dismiss'); dismiss.disabled = false; error.hidden = result.ok; error.textContent = result.ok ? '' : 'Could not dismiss. Try again.'; });
    actions.append(dismiss, link); section.append(heading, message, actions, error); root.append(style, section);
  };
  const render = next => {
    state = next;
    if (state.phase !== 'expired' || state.dismissed || document.hidden) { if (host) host.hidden = true; return; }
    mount();
    const text = `${state.durationMinutes} ${state.durationMinutes === 1 ? 'minute has' : 'minutes have'} passed. A good moment to take a break.`;
    if (message.textContent !== text) message.textContent = text;
    const full = document.fullscreenElement;
    const parent = full && !['VIDEO', 'AUDIO'].includes(full.tagName) ? full : document.documentElement;
    if (host.parentElement !== parent) parent.append(host);
    host.hidden = false;
  };
  client = MVSWatchTimerClient.create({ onChange: render });
  document.addEventListener('fullscreenchange', () => { client.refresh(); });
  document.addEventListener('yt-navigate-finish', () => { client.refresh(); });
  new MutationObserver(() => { if (state?.phase === 'expired' && !state.dismissed && !host?.isConnected) render(state); }).observe(document.documentElement, { childList: true });
})();
