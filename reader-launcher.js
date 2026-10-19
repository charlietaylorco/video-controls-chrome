/* Viewport-owned Recent saves shortcut. Never mounts inside YouTube's layout. */
(() => {
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const defaults = { showRecentSavesLauncher: true, recentSavesLauncherPosition: 'bottom-left', readerPanelTheme: 'system', showReaderPanel: false };
  const create = ({ document = globalThis.document, window = globalThis.window, chrome = globalThis.chrome } = {}) => {
    if (document === globalThis.document && globalThis.__mvsRecentLauncher) return globalThis.__mvsRecentLauncher;
    globalThis.__mvsRecentHeader?.destroy?.();
    for (const id of ['mvs-recent-saves-header', 'mvs-recent-saves-header-style', 'mvs-recent-saves-launcher']) document.getElementById(id)?.remove();
    const host = document.createElement('div'); host.id = 'mvs-recent-saves-launcher';
    const root = host.attachShadow({ mode: 'closed' }), style = document.createElement('style');
    style.textContent = `
      :host{all:initial!important;position:fixed!important;display:block!important;width:32px!important;height:32px!important;margin:0!important;padding:0!important;border:0!important;z-index:2147482999!important;--bg:#fff;--text:#252720;--line:#dedfd7;color-scheme:light}
      :host([hidden]){display:none!important}
      :host([data-theme=dark]){--bg:#22251f;--text:#eeefe8;--line:#41463b;color-scheme:dark}
      :host([data-position=bottom-left]){bottom:max(16px,env(safe-area-inset-bottom))!important;left:max(16px,env(safe-area-inset-left))!important;top:auto!important;right:auto!important}
      :host([data-position=bottom-right]){bottom:max(16px,env(safe-area-inset-bottom))!important;right:max(16px,env(safe-area-inset-right))!important;top:auto!important;left:auto!important}
      :host([data-position=top-left]){top:max(16px,env(safe-area-inset-top))!important;left:max(16px,env(safe-area-inset-left))!important;bottom:auto!important;right:auto!important}
      :host([data-position=top-right]){top:max(16px,env(safe-area-inset-top))!important;right:max(16px,env(safe-area-inset-right))!important;bottom:auto!important;left:auto!important}
      :host([data-position=top-right][data-panel=true]){top:max(52px,env(safe-area-inset-top))!important}
      button{box-sizing:border-box;display:grid;place-items:center;width:32px;height:32px;padding:6px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);box-shadow:0 2px 8px #0002;cursor:pointer}
      button:hover{filter:brightness(.94)}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}
      svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    `;
    const button = document.createElement('button'); button.type = 'button'; button.title = 'Recent saves'; button.setAttribute('aria-label', 'Recent saves');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M5 3h14v18l-7-4-7 4V3Zm5 4 5 3-5 3V7Z'); svg.append(path); button.append(svg); root.append(style, button);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'open-watch-list' }, () => { void chrome.runtime.lastError; }); } catch { /* refresh the tab after an extension reload */ }
    });
    for (const event of ['keydown', 'keyup', 'keypress']) button.addEventListener(event, key => key.stopPropagation());
    const media = window.matchMedia('(prefers-color-scheme: dark)'), settings = { ...defaults }, changed = new Set();
    let ready = false, destroyed = false, timer = null;
    const browsingRoute = () => !/^\/(?:watch|live)(?:\/|$)/.test(window.location?.pathname || '') && !window.location?.pathname?.startsWith('/embed/');
    const visible = () => ready && settings.showRecentSavesLauncher !== false && !document.fullscreenElement && !document.webkitFullscreenElement && !document.webkitIsFullScreen && browsingRoute();
    const observer = new window.MutationObserver(() => { if (visible() && (!host.isConnected || host.parentElement !== document.documentElement)) schedule(); });
    const sync = () => {
      if (destroyed) return;
      host.setAttribute('data-position', positions.includes(settings.recentSavesLauncherPosition) ? settings.recentSavesLauncherPosition : 'bottom-left');
      const theme = ['light', 'dark'].includes(settings.readerPanelTheme) ? settings.readerPanelTheme : media.matches ? 'dark' : 'light';
      host.setAttribute('data-theme', theme); host.setAttribute('data-panel', String(settings.showReaderPanel === true));
      if (visible() && document.documentElement) { if (host.parentElement !== document.documentElement) document.documentElement.append(host); }
      else host.remove();
      observer.disconnect(); observer.observe(document, { childList: true });
      if (document.documentElement) observer.observe(document.documentElement, { childList: true });
    };
    const schedule = () => { if (timer !== null || destroyed) return; timer = window.setTimeout(() => { timer = null; sync(); }, 100); };
    const onStorage = (changes, area) => {
      if (area !== 'local') return;
      let updated = false;
      for (const key of Object.keys(defaults)) if (changes[key]) { changed.add(key); settings[key] = changes[key].newValue ?? defaults[key]; updated = true; }
      if (updated) sync();
    };
    chrome.storage.onChanged.addListener(onStorage);
    chrome.storage.local.get(defaults, values => {
      void chrome.runtime.lastError;
      if (destroyed) return;
      for (const key of Object.keys(defaults)) if (!changed.has(key)) settings[key] = values?.[key] ?? defaults[key];
      ready = true; sync();
    });
    media.addEventListener('change', sync);
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(event, sync);
    document.addEventListener('DOMContentLoaded', schedule); window.addEventListener('yt-navigate-finish', sync);
    const controller = { refresh: sync, destroy() {
      destroyed = true; if (timer !== null) window.clearTimeout(timer); observer.disconnect(); host.remove();
      chrome.storage.onChanged.removeListener(onStorage); media.removeEventListener('change', sync);
      for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.removeEventListener(event, sync);
      document.removeEventListener('DOMContentLoaded', schedule); window.removeEventListener('yt-navigate-finish', sync);
      if (globalThis.__mvsRecentLauncher === controller) delete globalThis.__mvsRecentLauncher;
    } };
    return controller;
  };
  globalThis.MVSRecentLauncher = { create };
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(location.hostname) && !location.pathname?.startsWith('/embed/') && !globalThis.__mvsRecentLauncher) globalThis.__mvsRecentLauncher = create();
})();
