/* Compact desktop/mobile YouTube header entry; no Reader data or polling. */
(() => {
  const create = ({ document = globalThis.document, window = globalThis.window, chrome = globalThis.chrome } = {}) => {
    const id = 'mvs-recent-saves-header', styleId = id + '-style';
    let style = document.getElementById(styleId);
    if (!style) { style = document.createElement('style'); style.id = styleId; document.documentElement.append(style); }
    style.textContent = '#mvs-recent-saves-header{box-sizing:border-box;display:inline-grid;place-items:center;flex:0 0 auto;vertical-align:middle;margin:0 4px;width:36px;height:36px;padding:8px;border:0;border-radius:50%;background:transparent;color:var(--yt-spec-text-primary,#0f0f0f);cursor:pointer}html[dark] #mvs-recent-saves-header{color:var(--yt-spec-text-primary,#f1f1f1)}#mvs-recent-saves-header:hover{background:var(--yt-spec-badge-chip-background,rgba(127,127,127,.15))}#mvs-recent-saves-header:focus-visible{outline:2px solid currentColor;outline-offset:2px}#mvs-recent-saves-header svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}';
    const host = document.createElement('button'), button = host; host.id = id; button.type = 'button'; button.title = 'Recent saves'; button.setAttribute('aria-label', 'Recent saves');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M5 3h14v18l-7-4-7 4V3Zm5 4 5 3-5 3V7Z'); svg.append(path); button.append(svg);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'open-watch-list' }, () => { void chrome.runtime.lastError; }); } catch { /* extension reload requires a page reload */ }
    });
    let target = null, timer = null, destroyed = false;
    const selectors = ['ytd-masthead #end #buttons', 'ytd-masthead #end', '#masthead #end #buttons', '#masthead #end', 'ytm-mobile-topbar-renderer'];
    const healthy = () => host.isConnected && target?.isConnected && target.contains(host);
    const observer = new window.MutationObserver(() => { if (!healthy()) schedule(); });
    const observe = () => {
      observer.disconnect();
      if (target) {
        // Watch the small header subtree and ancestor child lists, not the feed.
        observer.observe(target, { childList: true, subtree: true });
        for (let node = target.parentElement; node; node = node.parentElement) observer.observe(node, { childList: true });
      } else if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    const sync = () => {
      if (destroyed) return;
      target = null;
      for (const selector of selectors) { const found = document.querySelector(selector); if (found) { target = found; break; } }
      if (target && !target.contains(host)) target.append(host);
      observe();
    };
    const schedule = () => {
      if (timer !== null || destroyed) return;
      timer = window.setTimeout(() => { timer = null; sync(); }, 100);
    };
    const navigate = () => schedule();
    window.addEventListener('yt-navigate-finish', navigate); document.addEventListener('DOMContentLoaded', navigate); sync();
    return { refresh: sync, destroy() { destroyed = true; if (timer !== null) window.clearTimeout(timer); observer.disconnect(); host.remove(); window.removeEventListener('yt-navigate-finish', navigate); document.removeEventListener('DOMContentLoaded', navigate); } };
  };
  globalThis.MVSRecentHeader = { create };
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(location.hostname) && !location.pathname?.startsWith('/embed/') && !globalThis.__mvsRecentHeader) globalThis.__mvsRecentHeader = create();
})();
