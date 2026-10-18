/* Isolated-world card UI. No credentials, page events carrying API data, or remote HTML. */
(() => {
  const create = ({ button, getTarget, onHold = () => {}, onClose = () => {}, onDeleted = () => {}, now = Date.now }) => {
    const C = globalThis.MVSReaderCore, cache = new Map();
    const media = matchMedia('(prefers-color-scheme: dark)');
    let session = null, host, root, ui, intent, leave, theme = 'system', suppressFocus = false, scrollingUntil = 0;
    const send = message => new Promise(resolve => {
      try { chrome.runtime.sendMessage(message, reply => resolve(chrome.runtime.lastError ? { ok: false, code: 'runtime_error' } : reply || { ok: false, code: 'runtime_error' })); }
      catch { resolve({ ok: false, code: 'runtime_error' }); }
    });
    const valid = s => {
      const target = getTarget();
      return session === s && target && target.source === s.source && target.source.isConnected &&
        C.canonical(target.videoUrl) === s.url && C.pageKey(location.href) === s.page;
    };
    const owns = event => Boolean(host && event.composedPath().includes(host));
    const close = (focus = false) => {
      clearTimeout(intent); clearTimeout(leave);
      if (!session) return;
      session = null;
      if (host) host.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (focus && button.isConnected) { suppressFocus = true; button.focus(); }
      onClose();
    };
    const node = (tag, text, parent, attrs = {}) => {
      const el = document.createElement(tag); el.textContent = text;
      for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
      parent?.append(el); return el;
    };
    const glyph = (parent, paths) => {
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
      for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); } parent.append(svg);
    };
    const applyTheme = () => {
      if (host) host.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    const place = () => {
      if (!session || !host || host.hidden) return;
      if (!valid(session)) { close(); return; }
      const a = button.getBoundingClientRect(), box = host.getBoundingClientRect();
      if (a.bottom <= 0 || a.top >= innerHeight || a.right <= 0 || a.left >= innerWidth) { close(); return; }
      const gap = 6, margin = 8;
      const top = a.bottom + gap + box.height <= innerHeight - margin ? a.bottom + gap : a.top - gap - box.height;
      host.style.left = `${Math.max(margin, Math.min(a.left, innerWidth - box.width - margin))}px`;
      host.style.top = `${Math.max(margin, Math.min(top, innerHeight - box.height - margin))}px`;
    };
    const errorText = reply => ({
      missing_token: 'Add your Reader token in Extension options.', unauthorized: 'Reader rejected the token. Check Extension options.',
      invalid_sender: 'This card changed. Hover its Reader icon again.', document_changed: 'The Reader document changed. Refresh and review it before deleting.',
      delete_uncertain: 'Deletion could not be confirmed. Refresh to check Reader before trying again.',
      delete_cache_error: 'Reader confirmed deletion, but local saved indicators could not be cleared. Refresh to check.',
      auth_changed: 'Reader credentials changed. Refresh before continuing.', network_error: 'Reader could not be reached. Try Refresh when connected.',
      runtime_error: 'The extension is unavailable. Copy any unsaved notes before reloading.',
      storage_error: 'Extension storage is unavailable. Try again later.'
    })[reply.code] || (reply.code === 'rate_limited' ? `Reader rate limit. Try after ${new Date(reply.retryAt || now() + 60000).toLocaleTimeString()}.` : 'Reader could not complete this request. Try Refresh later.');
    const mount = () => {
      if (host) return;
      host = document.createElement('div'); host.id = 'mvs-reader-card-preview'; host.hidden = true;
      root = host.attachShadow({ mode: 'closed' });
      const style = node('style', '', root);
      style.textContent = `
        :host{position:fixed;z-index:2147483001;width:min(340px,calc(100vw - 16px));height:min(292px,calc(100dvh - 16px));font:13px/1.6 Roboto,Arial,sans-serif;color:var(--fg);color-scheme:light;--bg:#fff;--fg:#202124;--muted:#5f6368;--border:#dadce0;--hover:#e5e7eb;--error:#b3261e;--focus:#8a5b00}
        :host([hidden]){display:none}:host([data-theme=dark]){color-scheme:dark;--bg:#202124;--fg:#f1f3f4;--muted:#bcc1c8;--border:#54575d;--hover:#3c4047;--error:#ffb4ab;--focus:#e8ba62}*{box-sizing:border-box}[hidden]{display:none!important}
        .popover{height:100%;display:grid;grid-template-rows:35px minmax(0,1fr) 29px;border:1px solid var(--border);border-radius:10px;background:var(--bg);box-shadow:0 7px 28px #0003;overflow:hidden}header{display:flex;gap:2px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border)}header>span{flex:1;min-width:0;font-size:12px;font-weight:600}button,a{font:inherit;color:inherit;cursor:pointer}button{border:0;background:transparent}button:hover,a:hover{background:var(--hover)}button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}button:disabled{opacity:.4;cursor:default}.icon{display:grid;place-items:center;width:25px;height:25px;border-radius:5px;padding:4px}svg{width:17px;height:17px}.body{padding:10px 12px;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}.title{font-size:12px;font-weight:600;margin:0 0 8px;white-space:pre-wrap}.summary{white-space:pre-wrap;user-select:text}footer{padding:3px 12px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.error{color:var(--error)}.confirmation{font-size:12px}.identity{font-size:10px;color:var(--muted);user-select:text}.confirmation p{margin:0 0 8px}.buttons{display:flex;gap:8px;justify-content:flex-end}.small{padding:4px 9px;border:1px solid var(--border);border-radius:14px}.destructive{color:var(--error);border-color:currentColor}
      `;
      const box = node('section', '', root, { class: 'popover', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Reader card summary' });
      const header = node('header', '', box); node('span', 'Reader summary', header);
      const iconButton = (label, paths) => { const el = node('button', '', header, { class: 'icon', type: 'button', title: label, 'aria-label': label }); glyph(el, paths); return el; };
      const refresh = iconButton('Refresh summary', ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 5']);
      const link = node('a', '', header, { class: 'icon', title: 'Open in Reader', 'aria-label': 'Open in Reader', target: '_blank', rel: 'noopener noreferrer' }); glyph(link, ['M14 3h7v7', 'M10 14 21 3', 'M10 3H4v17h17v-6']);
      const trash = iconButton('Delete from Reader', ['M3 6h18', 'M9 6V3h6v3', 'm5 6 1 15h12l1-15', 'M10 10v7', 'M14 10v7']);
      const dismiss = iconButton('Close summary', ['m6 6 12 12', 'M6 18 18 6']);
      const body = node('div', '', box, { class: 'body', tabindex: '0' });
      const display = node('div', '', body), title = node('p', '', display, { class: 'title' }), summary = node('div', '', display, { class: 'summary' });
      const confirmation = node('div', '', body, { class: 'confirmation', role: 'alertdialog', 'aria-modal': 'false', 'aria-label': 'Delete this video from Reader?' });
      const deleteTitle = node('p', '', confirmation, { class: 'title' }), identity = node('p', '', confirmation, { class: 'identity' });
      node('p', 'Delete this Reader document, including its highlights and notes? This extension cannot undo deletion. Unsaved local notes in open Reader panels stay in their tabs; copy them before closing or reloading.', confirmation);
      const buttons = node('div', '', confirmation, { class: 'buttons' });
      const cancel = node('button', 'Cancel', buttons, { class: 'small', type: 'button' });
      const confirm = node('button', 'Delete document', buttons, { class: 'small destructive', type: 'button' });
      const status = node('footer', '', box, { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      refresh.addEventListener('click', () => { if (session) { cache.delete(session.url); void load(session); } });
      trash.addEventListener('click', () => {
        const s = session; if (!s?.doc || s.busy || !valid(s)) { close(); return; }
        s.confirm = true; render(); cancel.focus();
      });
      cancel.addEventListener('click', () => { if (session) { session.confirm = false; render(); trash.focus(); } });
      confirm.addEventListener('click', () => void remove());
      dismiss.addEventListener('click', () => close(true));
      link.addEventListener('click', event => { if (!session || !valid(session)) { event.preventDefault(); close(); } });
      host.addEventListener('pointerenter', () => { clearTimeout(leave); onHold(); });
      host.addEventListener('pointerleave', () => scheduleClose());
      host.addEventListener('focusin', () => { clearTimeout(leave); onHold(); });
      root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget) && event.relatedTarget !== button) scheduleClose(); });
      ui = { refresh, trash, link, dismiss, body, display, title, summary, confirmation, deleteTitle, identity, cancel, confirm, status };
      document.documentElement.append(host); applyTheme();
    };
    const render = () => {
      if (!session || !ui) return;
      const s = session;
      ui.display.hidden = Boolean(s.confirm); ui.confirmation.hidden = !s.confirm;
      ui.title.textContent = s.doc?.title || s.title;
      ui.summary.textContent = s.text || s.doc?.summary || 'Summary not available yet. Reader may still be processing it. Try Refresh later.';
      ui.summary.className = `summary${s.error ? ' error' : ''}`;
      ui.deleteTitle.textContent = s.doc?.title || s.title;
      ui.identity.textContent = `${s.url} · Reader ID: ${s.doc?.id || ''}`;
      ui.refresh.disabled = s.busy || Boolean(s.confirm);
      ui.trash.disabled = s.busy || !s.doc || Boolean(s.confirm);
      ui.link.href = s.doc ? C.readerUrl(s.doc.id) : 'https://read.readwise.io/';
      const status = s.busy ? (s.action === 'delete' ? 'Deleting…' : 'Loading…') : s.error ? 'Check Reader' : s.deleted ? 'Removed from Reader' : s.doc ? 'Saved in Reader' : 'Summary unavailable';
      if (ui.status.textContent !== status) ui.status.textContent = status;
      place();
    };
    const load = async s => {
      if (!valid(s) || s.busy || s.confirm) return;
      s.started = true; s.busy = true; s.action = 'read'; s.error = false; s.text = 'Loading Reader summary…'; render();
      const cached = cache.get(s.url);
      const reply = cached?.expires > now() ? cached.reply : await send({ type: 'reader-card-get', pageUrl: s.page, targetUrl: s.url, lease: s.lease });
      if (!valid(s)) { if (session === s) close(); return; }
      s.busy = false;
      if (!reply.ok) { s.error = true; s.doc = null; s.text = errorText(reply); }
      else {
        s.doc = reply.document && reply.document.videoUrl === s.url && C.validId(reply.document.id) ? reply.document : null;
        s.text = s.doc ? '' : reply.code === 'not_saved' ? 'This video is not marked saved in Reader.' : 'This older save could not be linked. Open Reader or use the watch-page Reader panel to find it.';
      }
      cache.delete(s.url);
      if (!['invalid_sender', 'auth_changed', 'runtime_error'].includes(reply.code))
        cache.set(s.url, { reply, expires: now() + (reply.code === 'rate_limited' ? Math.max(1000, (reply.retryAt || now() + 60000) - now()) : reply.ok ? (s.doc?.summary ? 60000 : 15000) : 5000) });
      while (cache.size > 50) cache.delete(cache.keys().next().value);
      render();
    };
    const remove = async () => {
      const s = session;
      if (!s?.confirm || !s.doc || s.busy || !valid(s)) { close(); return; }
      const doc = s.doc;
      s.confirm = false; s.busy = true; s.action = 'delete'; s.text = 'Checking Reader before deleting…'; s.error = false; render();
      const reply = await send({ type: 'reader-card-delete', pageUrl: s.page, targetUrl: s.url, lease: s.lease,
        id: doc.id, confirmed: true, title: doc.title, baseNotes: doc.notes, updatedAt: doc.updatedAt });
      cache.delete(s.url);
      if (!valid(s)) { if (session === s) close(); return; }
      s.busy = false;
      if (reply.ok && reply.id === doc.id) {
        s.doc = null; s.deleted = true; s.text = reply.alreadyDeleted ? 'This document is already absent from Reader.' : 'Deleted from Reader.';
        onDeleted(s.url);
      } else {
        s.error = true;
        if (reply.code === 'delete_conflict') {
          s.doc = null; s.text = 'Reader changed since the confirmation. Refresh and review the document before choosing Delete again.';
        } else s.text = errorText(reply);
      }
      render();
    };
    const scheduleClose = () => {
      clearTimeout(intent); clearTimeout(leave);
      leave = setTimeout(() => { if (session && !root?.activeElement && button.getRootNode().activeElement !== button) close(); }, 180);
    };
    const begin = (immediate = false) => {
      clearTimeout(leave);
      if (document.hidden || (!immediate && now() < scrollingUntil)) return;
      const target = getTarget(), url = C.canonical(target?.videoUrl), page = C.pageKey(location.href);
      if (!target?.saved || !target.source?.isConnected || !url || !page) { close(); return; }
      if (session && valid(session) && !immediate) return;
      if (session && valid(session) && host && !host.hidden) { ui.dismiss.focus(); return; }
      clearTimeout(intent);
      if (!session || !valid(session)) {
        close();
        session = { source: target.source, url, page, title: target.title || 'Saved YouTube video', lease: crypto.randomUUID(), busy: false, started: false, doc: null };
      }
      onHold();
      const show = () => {
        const s = session; if (!s || !valid(s)) { close(); return; }
        mount(); host.hidden = false; button.setAttribute('aria-expanded', 'true');
        render(); void load(s); if (immediate) ui.dismiss.focus();
      };
      if (immediate) show(); else intent = setTimeout(show, 300);
    };
    button.addEventListener('pointerenter', () => { suppressFocus = false; begin(); });
    button.addEventListener('pointerleave', scheduleClose);
    button.addEventListener('focusin', () => { if (!suppressFocus) begin(); });
    button.addEventListener('focusout', () => { suppressFocus = false; scheduleClose(); });
    button.addEventListener('click', () => close()); // Preserve the existing one-click save/open action.
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && getTarget()?.saved) { event.preventDefault(); event.stopPropagation(); begin(true); }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && session && (owns(event) || event.composedPath().includes(button))) {
        event.preventDefault(); event.stopPropagation();
        if (session.confirm) { session.confirm = false; render(); ui.trash.focus(); } else close(true);
      }
    }, true);
    document.addEventListener('pointerdown', event => { if (session && !owns(event) && !event.composedPath().includes(button)) close(); }, true);
    new MutationObserver(() => { if (session && !valid(session)) close(); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
    for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(event, () => { if (session && !valid(session)) close(); });
    window.addEventListener('popstate', () => close());
    window.addEventListener('resize', place);
    window.addEventListener('scroll', event => {
      if (owns(event)) return; // Summary text can scroll without cancelling its preview.
      scrollingUntil = now() + 200;
      if (session && !session.started) close(); else place();
    }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message?.type !== 'reader-card-validate') return;
      const s = session;
      const ok = sender.id === chrome.runtime.id && s && valid(s) && message.lease === s.lease && message.pageUrl === s.page && message.targetUrl === s.url;
      reply({ ok: Boolean(ok), lease: message.lease, pageUrl: message.pageUrl, targetUrl: message.targetUrl });
    });
    chrome.storage.local.get({ readerPanelTheme: 'system' }, data => { theme = ['light', 'dark'].includes(data.readerPanelTheme) ? data.readerPanelTheme : 'system'; applyTheme(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.readerPanelTheme) { theme = ['light', 'dark'].includes(changes.readerPanelTheme.newValue) ? changes.readerPanelTheme.newValue : 'system'; applyTheme(); }
      if (changes.readerToken) { cache.clear(); close(); }
      let invalidated = false;
      if (changes.readerDocuments) {
        const { oldValue = {}, newValue = {} } = changes.readerDocuments;
        for (const [url, entry] of cache) {
          if (oldValue[url]?.id !== newValue[url]?.id && entry.reply.document?.id !== newValue[url]?.id) cache.delete(url);
        }
        if (session?.doc && oldValue[session.url]?.id === session.doc.id && newValue[session.url]?.id !== session.doc.id) invalidated = true;
      }
      if (changes.readerSavedUrls) {
        cache.clear();
        const marked = (flags, url) => Object.entries(flags || {}).some(([key, saved]) => saved && C.canonical(key) === url);
        if (session && marked(changes.readerSavedUrls.oldValue, session.url) && !marked(changes.readerSavedUrls.newValue, session.url)) invalidated = true;
      }
      // A discovery lookup's own newly linked id must not erase the summary
      // when its storage event arrives after the response. Only invalidate an
      // existing target identity that was actually removed/replaced.
      if (invalidated && session && !session.busy && !session.deleted) {
        session.doc = null; session.confirm = false; session.text = 'Reader changed. Refresh to check its current summary.'; render();
      }
    });
    media.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
    return { close, owns, isActive: () => Boolean(session), update() {
      const target = getTarget();
      if (session && !valid(session)) close();
      button.setAttribute('aria-haspopup', target?.saved ? 'dialog' : 'false');
      if (!session) button.setAttribute('aria-expanded', 'false');
      if (target?.saved) button.setAttribute('aria-description', 'Hover or press ArrowDown for the summary. Click to open Reader.');
      else button.removeAttribute('aria-description');
      if (!session && !suppressFocus && target?.saved && (button.matches(':hover') || button.getRootNode().activeElement === button)) begin();
    } };
  };
  globalThis.MVSReaderCardPreview = { create };
})();
