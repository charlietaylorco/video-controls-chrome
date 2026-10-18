/* Isolated, opt-in YouTube UI. Remote strings are always rendered as text. */
(() => {
  if (window.top !== window || window.__mvsReaderPanel) return;
  window.__mvsReaderPanel = true;
  const C = globalThis.MVSReaderCore;
  const states = new Map();
  let enabled = false;
  let activeUrl = null;
  let host, root, view;
  let open = false;
  let peek, menu = null;
  let syncTimer = null;
  let visit = 0;
  let theme = 'system';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let position = null; // This tab only, shared across videos; reload returns to the corner.
  let drag = null;
  const applyTheme = () => {
    if (!host) return;
    const resolved = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
    host.dataset.theme = resolved;
    view?.note.setTheme(resolved);
  };
  const clearFeedback = (s) => {
    if (!s) return;
    clearTimeout(s.feedbackTimer);
    clearTimeout(s.moveTimer);
    if (s.moveFeedback && s.status === s.moveFeedback) s.status = '';
    s.moveFeedback = '';
    s.feedback = null;
  };
  const confirmSave = (s, url, id, request, sent) => {
    clearFeedback(s);
    if (s.dirty || s.value !== sent) return;
    const feedback = { id, request, sent };
    s.feedback = feedback;
    s.feedbackTimer = setTimeout(() => {
      if (s.feedback !== feedback || s.request !== request || s.doc?.id !== id || s.value !== sent) return;
      s.feedback = null;
      if (activeUrl === url) render();
    }, 3000);
  };
  const placePopover = () => {
    if (!open || !view || !position) return;
    Object.assign(view.body.style, { position: 'fixed', width: `${Math.min(390, innerWidth)}px`, marginTop: '0', maxHeight: `${Math.min(680, innerHeight)}px` });
    const rect = view.body.getBoundingClientRect();
    position.x = Math.max(0, Math.min(position.x, innerWidth - rect.width));
    position.y = Math.max(0, Math.min(position.y, innerHeight - rect.height));
    view.body.style.left = `${position.x}px`;
    view.body.style.top = `${position.y}px`;
  };
  const endDrag = () => {
    const pointerId = drag?.id;
    drag = null;
    if (view?.header) {
      view.header.dataset.dragging = 'false';
      if (pointerId !== undefined && view.header.hasPointerCapture(pointerId)) view.header.releasePointerCapture(pointerId);
    }
  };

  const stateFor = (url) => {
    if (!states.has(url)) states.set(url, { ...C.draft(), status: '', statusKind: 'info', action: 'read', feedback: null, cursor: null, loaded: false, tab: 'summary', tagsOpen: false });
    return states.get(url);
  };
  const current = () => activeUrl && stateFor(activeUrl);
  const send = (message) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => resolve(chrome.runtime.lastError
        ? { ok: false, code: 'runtime_error' } : response || { ok: false, code: 'runtime_error' }));
    } catch { resolve({ ok: false, code: 'runtime_error' }); }
  });
  const messageFor = (response) => ({
    missing_token: 'Add your Reader token in Extension options, then refresh.',
    auth_changed: 'Reader credentials changed during the request. Your draft is kept; Refresh before saving.',
    unauthorized: 'Reader rejected the token. Check Extension options, then refresh.',
    network_error: 'Reader could not be reached. Check your connection, then refresh.',
    save_uncertain: 'Save could not be confirmed. Your draft is kept. Refresh to check Reader before trying again.',
    delete_uncertain: 'Deletion could not be confirmed. Refresh to check Reader before trying again. Your draft is kept.',
    delete_cache_error: 'Reader confirmed deletion, but the local saved indicator could not be cleared. Refresh to check Reader. Your draft is kept.',
    document_changed: 'The matched document changed. Refresh and review it before deleting. Your draft is kept.',
    invalid_delete: 'Deletion was not sent. Reopen the confirmation for this document.',
    invalid_location: 'Choose Later, Shortlist or Archive from the location menu.',
    location_uncertain: 'The location change could not be confirmed. Refresh to check Reader before trying again. Your note draft is kept.',
    location_cache_error: 'Reader was updated, but other panels could not be notified. Refresh to confirm its location.',
    not_found: 'This Reader document was deleted or no longer matches this video. Your draft is kept. Refresh to find it again.',
    invalid_sender: 'This tab is still changing videos. Try Refresh in a moment. Your draft is kept.',
    ambiguous: 'Multiple Reader documents match. Open Reader to choose the correct document.',
    storage_error: 'Extension storage is unavailable. Your draft is kept in this tab.',
    runtime_error: 'The extension reloaded or is unavailable. Reload this tab after copying any draft.',
    invalid_request: 'The note could not be sent. Notes must be text and no longer than 500,000 characters.',
    reader_error: 'Reader returned an error. Your draft is kept. Try Refresh later.'
  })[response.code] || (response.code === 'rate_limited'
    ? `Reader rate limit reached. Try again after ${new Date(response.retryAt || Date.now() + 60000).toLocaleTimeString()}.`
    : 'Could not complete the request. Your draft is kept.');
  const element = (tag, text, parent, attrs = {}) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (parent) parent.append(node);
    return node;
  };
  const dismiss = (restoreFocus = false) => {
    closeMenu(); peek?.close();
    endDrag();
    clearTimeout(current()?.retryTimer);
    if (current()) current().deleteConfirm = null;
    open = false;
    render();
    if (restoreFocus && host?.isConnected) view.toggle.focus();
  };
  const closeMenu = (focus = false) => {
    const kind = menu?.kind; menu = null;
    if (!view) return;
    view.locationMenu.hidden = view.moreMenu.hidden = true;
    view.location.setAttribute('aria-expanded', 'false'); view.more.setAttribute('aria-expanded', 'false');
    if (focus) (kind === 'location' ? view.location : view.more).focus();
  };
  const menuItems = () => (menu?.kind === 'location' ? view.locationItems : [view.link, view.settings])
    .filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
  const openMenu = (kind, last = false) => {
    if (!open || !sameVideo() || (kind === 'location' ? view.location.disabled : view.more.disabled)) return;
    if (menu?.kind === kind) { closeMenu(true); return; }
    closeMenu();
    const s = current(); menu = { kind, url: activeUrl, id: s?.doc?.id, baseLocation: s?.doc?.location || '' };
    render(); const items = menuItems(); items[last ? items.length - 1 : 0]?.focus();
  };
  const positionMenu = () => {
    if (!menu) return;
    const trigger = menu.kind === 'location' ? view.location : view.more;
    const popup = menu.kind === 'location' ? view.locationMenu : view.moreMenu;
    const r = trigger.getBoundingClientRect(), box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.width - 8))}px`;
    const below = r.top + r.height + 4;
    popup.style.top = `${Math.max(8, Math.min(below, innerHeight - box.height - 8))}px`;
  };
  const menuKey = event => {
    if (!menu) return;
    const items = menuItems(), index = items.indexOf(root.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const kind = menu.kind; closeMenu();
      (event.shiftKey ? (kind === 'location' ? view.location : view.more) : kind === 'location' ? view.refresh : view.close).focus();
    }
    else if (event.key === ' ' && root.activeElement === view.link) { event.preventDefault(); view.link.click(); }
  };
  const sameVideo = () => {
    if (C.canonical(location.href) === activeUrl) return true;
    sync();
    return false; // A click on the previous document must never mutate the next one.
  };
  const selectTab = (tab, focus = false) => {
    if (!sameVideo()) return;
    const s = current();
    if (!s || (tab === 'note' && !s.doc && !s.dirty)) return;
    s.tab = tab;
    render();
    if (focus) (tab === 'summary' ? view.summaryTab : view.noteTab).focus();
  };
  const icon = (parent, paths) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
    parent.append(svg);
  };
  const createView = () => {
    host = document.createElement('div');
    host.id = 'mvs-reader-panel';
    root = host.attachShadow({ mode: 'closed' });
    const style = element('style', '', root);
    style.textContent = `
      :host{position:fixed;top:0;right:0;width:min(390px,100vw);z-index:2147483000;pointer-events:none;color:var(--reader-text);font:14px/1.55 "YouTube Sans",Roboto,sans-serif;color-scheme:light;--reader-bg:#ffffff;--reader-text:#202124;--reader-muted:#5f6368;--reader-border:#dadce0;--reader-chip:#f1f3f4;--reader-hover:#e5e7eb;--reader-focus:#8a5b00;--reader-error:#b3261e;--reader-warning:#8a5b00;--reader-success:#137333;--reader-shadow:#00000024}
      :host([data-theme="dark"]){color-scheme:dark;--reader-bg:#202124;--reader-text:#f1f3f4;--reader-muted:#bcc1c8;--reader-border:#54575d;--reader-chip:#303238;--reader-hover:#3c4047;--reader-focus:#e8ba62;--reader-error:#ffb4ab;--reader-warning:#e8ba62;--reader-success:#81c995;--reader-shadow:#00000066}
      *{box-sizing:border-box}[hidden]{display:none!important}button,a,textarea{font:inherit}button,a{color:inherit}button{cursor:pointer}svg{display:block;width:17px;height:17px;flex-shrink:0}
      .launch-row{display:flex;justify-content:flex-end}.toggle{pointer-events:auto;position:relative;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--reader-border);border-top:0;border-right:0;border-radius:0 0 0 11px;padding:0;background:var(--reader-bg);box-shadow:0 2px 8px #00000010}.toggle svg{width:20px;height:20px}.toggle .draft-dot{position:absolute;top:5px;right:5px}
      .draft-dot{width:5px;height:5px;border-radius:50%;background:#c5912e}.body{pointer-events:auto;margin-top:4px;max-height:min(680px,calc(100dvh - 40px));overflow:auto;overscroll-behavior:contain;border:1px solid var(--reader-border);border-radius:12px 0 12px 12px;background:var(--reader-bg);box-shadow:0 10px 36px var(--reader-shadow)}
      .header{cursor:grab;touch-action:none;user-select:none;display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:6px;align-items:center;padding:6px 6px 0;position:sticky;top:0;background:var(--reader-bg);z-index:1;border-bottom:1px solid var(--reader-border)}.header[data-dragging="true"]{cursor:grabbing}.tabs{grid-column:1;display:flex;gap:8px;white-space:nowrap}.tab{display:flex;align-items:center;gap:4px;height:32px;padding:0 2px;background:transparent;border:0;border-bottom:2px solid transparent;font-size:12px;color:var(--reader-muted)}.tab[aria-selected="true"]{color:var(--reader-text);border-bottom-color:currentColor;font-weight:600}
      .actions{grid-column:4;display:flex;gap:2px;align-items:center}.icon{display:grid;place-items:center;width:28px;height:28px;flex-shrink:0;padding:0;border:0;border-radius:6px;background:transparent;text-decoration:none}.icon[aria-disabled="true"]{opacity:.4;pointer-events:none}
      .location{grid-column:2;display:flex;align-items:center;gap:2px;width:86px;height:25px;padding:0 5px;background:var(--reader-chip);border:0;border-radius:6px;font-size:11px}.location-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.location svg{width:12px;height:12px;margin-left:auto}.popup-menu{pointer-events:auto;position:fixed;z-index:5;width:180px;max-height:calc(100dvh - 16px);overflow:auto;padding:4px;background:var(--reader-bg);border:1px solid var(--reader-border);border-radius:9px;box-shadow:0 5px 20px var(--reader-shadow)}.menu-item{display:flex;align-items:center;gap:7px;width:100%;min-height:32px;padding:5px 9px;border:0;border-radius:5px;background:transparent;text-decoration:none;text-align:left;font-size:12px}.menu-item[aria-checked="true"]{font-weight:600;background:var(--reader-chip)}.menu-item[aria-disabled="true"]{opacity:.4;pointer-events:none}.peek{pointer-events:auto;position:absolute;top:40px;right:0;width:100%;height:min(260px,calc(100dvh - 48px));overflow:auto;overscroll-behavior:contain;padding:12px;border:1px solid var(--reader-border);border-radius:12px 0 12px 12px;background:var(--reader-bg);box-shadow:0 8px 28px var(--reader-shadow)}.peek-label{font-size:11px;color:var(--reader-muted);margin-bottom:7px}.peek-summary{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
      .tag-toggle{grid-column:3;display:flex;align-items:center;gap:4px;justify-self:start;min-width:0;max-width:100%;height:25px;padding:0 6px;border:0;border-radius:6px;font-size:11px;background:var(--reader-chip)}.tag-toggle svg{width:12px;height:12px}.tag-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tag-count{flex-shrink:0;font-size:10px;color:var(--reader-muted)}.tag-total{display:none}.tags{display:flex;gap:5px;flex-wrap:wrap;max-height:130px;overflow:auto;margin:0 0 10px}.tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--reader-chip);overflow-wrap:anywhere;max-width:100%}
      button:hover,a:hover{background:var(--reader-hover)}.toggle:hover,.toggle:active{background:var(--reader-hover);color:var(--reader-text)}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--reader-focus);outline-offset:-2px}
      .content{padding:12px;position:relative}.content[data-empty="true"]{min-height:160px}.content[data-empty="true"] .status{max-height:100px}.content[data-empty="true"] > .small{position:absolute;bottom:12px;left:12px}.summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.75}.editor{height:160px;min-height:160px;max-height:320px;resize:vertical;overflow:hidden;border:1px solid var(--reader-border);border-radius:9px}.editor iframe{display:block;width:100%;height:100%;border:0}.note-view{position:relative}
      .footer{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center;height:32px;margin-top:9px}.footer .muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.footer [data-kind="error"]{color:var(--reader-error)}.footer [data-kind="success"]{color:var(--reader-success)}.save{border:0;border-radius:18px;background:#e9be61;color:#211b10;font-weight:600;padding:6px 13px}.muted,.status{font-size:12px;color:var(--reader-muted)}.status{position:absolute;top:8px;left:12px;right:12px;z-index:3;margin:0;padding:9px 10px;max-height:130px;overflow:auto;overflow-wrap:anywhere;border:1px solid var(--reader-border);border-radius:8px;background:var(--reader-bg);box-shadow:0 3px 12px var(--reader-shadow)}.status[data-kind="error"]{color:var(--reader-error)}.status[data-kind="warning"]{color:var(--reader-warning)}.small{padding:5px 9px;border:1px solid var(--reader-border);border-radius:18px;background:transparent;font-size:12px}
      .conflict{position:absolute;left:0;right:0;bottom:41px;z-index:3;max-height:145px;overflow:auto;background:var(--reader-bg);border:1px solid var(--reader-border);border-left:3px solid var(--reader-warning);border-radius:8px;box-shadow:0 3px 12px var(--reader-shadow);padding:8px 10px;font-size:12px}.remote{white-space:pre-wrap;max-height:65px;overflow:auto;overflow-wrap:anywhere;margin-bottom:8px}.conflict button{margin:4px 3px 0 0}
      .delete-confirm{font-size:12px;overflow-wrap:anywhere}.delete-confirm h2{font-size:15px;margin:0 0 8px}.delete-confirm p{margin:8px 0}.delete-title{font-weight:600;white-space:pre-wrap;max-height:90px;overflow:auto}.delete-identity{color:var(--reader-muted);font-size:11px;user-select:text}.delete-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.destructive{color:var(--reader-error);border-color:currentColor}
      @media(max-width:360px){.tag-name,.tag-count,.tag-toggle svg{display:none}.tag-total{display:inline}.tag-toggle{padding:0 4px}.location{width:68px;padding:0 3px}.header{gap:4px;padding-left:5px;padding-right:5px}.tabs{gap:5px}.tab{font-size:11px}.actions{gap:0}}
    `;
    const row = element('div', '', root, { class: 'launch-row' });
    const toggle = element('button', '', row, { class: 'toggle', type: 'button', title: 'Reader summary and note', 'aria-label': 'Reader summary and note', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'reader-body' });
    icon(toggle, ['M12 5v15', 'M12 6C9 3.5 5 3.5 2.5 4.5v14c3-1.2 6.5-.5 9.5 2', 'M12 6c3-2.5 7-2.5 9.5-1.5v14c-3-1.2-6.5-.5-9.5 2']);
    const dot = element('span', '', toggle, { class: 'draft-dot', 'aria-hidden': 'true' });
    const body = element('section', '', root, { class: 'body', id: 'reader-body', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Reader' });
    body.hidden = true;
    const header = element('div', '', body, { class: 'header' });
    const tabs = element('div', '', header, { class: 'tabs', role: 'tablist', 'aria-label': 'Reader views' });
    const summaryTab = element('button', 'Summary', tabs, { class: 'tab', id: 'reader-summary-tab', type: 'button', role: 'tab', 'aria-controls': 'reader-summary-view' });
    const noteTab = element('button', 'Note', tabs, { class: 'tab', id: 'reader-note-tab', type: 'button', role: 'tab', 'aria-controls': 'reader-note-view' });
    const noteDot = element('span', '', noteTab, { class: 'draft-dot', 'aria-hidden': 'true' });
    const locationButton = element('button', '', header, { class: 'location', type: 'button', 'aria-label': 'Reader location', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'reader-location-menu' });
    const locationLabel = element('span', '', locationButton, { class: 'location-label' });
    icon(locationButton, ['m7 10 5 5 5-5']);
    const tagToggle = element('button', '', header, { class: 'tag-toggle', type: 'button', 'aria-label': 'Show tags', 'aria-expanded': 'false', 'aria-controls': 'reader-tags' });
    icon(tagToggle, ['m20 13-7 7L3 10V3h7l10 10Z', 'M7 7h.01']);
    const tagName = element('span', '', tagToggle, { class: 'tag-name' });
    const tagCount = element('span', '', tagToggle, { class: 'tag-count', 'aria-hidden': 'true' });
    const tagTotal = element('span', '', tagToggle, { class: 'tag-total', 'aria-hidden': 'true' });
    const actions = element('div', '', header, { class: 'actions' });
    const refresh = element('button', '', actions, { class: 'icon', type: 'button', title: 'Refresh', 'aria-label': 'Refresh' });
    icon(refresh, ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 5', 'M20 7v5']);
    const more = element('button', '', actions, { class: 'icon', type: 'button', title: 'More Reader actions', 'aria-label': 'More Reader actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'reader-more-menu' });
    icon(more, ['M5 12h.01', 'M12 12h.01', 'M19 12h.01']);
    const locationMenu = element('div', '', root, { class: 'popup-menu', role: 'menu', id: 'reader-location-menu', 'aria-label': 'Reader location' }); locationMenu.hidden = true;
    const locationItems = Object.entries(C.locations).map(([value, label]) => {
      const item = element('button', label, locationMenu, { class: 'menu-item', type: 'button', role: 'menuitemradio', 'data-location': value, tabindex: '-1' });
      item.addEventListener('click', () => selectLocation(value)); return item;
    });
    const trash = element('button', 'Trash', locationMenu, { class: 'menu-item destructive', type: 'button', role: 'menuitem', 'aria-label': 'Delete from Reader', tabindex: '-1' }); locationItems.push(trash);
    const moreMenu = element('div', '', root, { class: 'popup-menu', role: 'menu', id: 'reader-more-menu', 'aria-label': 'More Reader actions' }); moreMenu.hidden = true;
    const link = element('a', 'Open in Reader', moreMenu, { class: 'menu-item', role: 'menuitem', title: 'Open in Reader', 'aria-label': 'Open in Reader', target: '_blank', rel: 'noopener noreferrer', tabindex: '-1' });
    icon(link, ['M14 3h7v7', 'M10 14 21 3', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5']);
    const settings = element('button', 'Options', moreMenu, { class: 'menu-item', role: 'menuitem', type: 'button', title: 'Options', 'aria-label': 'Extension options', tabindex: '-1' });
    icon(settings, ['M10 2h4l.6 2.7L17 6.1l2.6-.8 2 3.4-2 1.9v2.8l2 1.9-2 3.4-2.6-.8-2.4 1.4L14 22h-4l-.6-2.7L7 17.9l-2.6.8-2-3.4 2-1.9v-2.8l-2-1.9 2-3.4 2.6.8 2.4-1.4L10 2Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0']);
    const close = element('button', '', actions, { class: 'icon close', type: 'button', title: 'Close', 'aria-label': 'Close Reader' });
    icon(close, ['m6 6 12 12', 'M6 18 18 6']);
    const content = element('div', '', body, { class: 'content' });
    const status = element('p', '', content, { class: 'status', role: 'status', 'aria-live': 'polite' });
    const next = element('button', 'Search next 100 videos', content, { class: 'small', type: 'button' });
    const tags = element('div', '', content, { class: 'tags', id: 'reader-tags', 'aria-label': 'Reader tags' });
    const deletion = element('div', '', content, { class: 'delete-confirm', role: 'alertdialog', 'aria-modal': 'false', 'aria-labelledby': 'reader-delete-heading', 'aria-describedby': 'reader-delete-effects reader-delete-draft' });
    element('h2', 'Delete from Reader?', deletion, { id: 'reader-delete-heading' });
    const deleteTitle = element('p', '', deletion, { class: 'delete-title' });
    const deleteIdentity = element('p', '', deletion, { class: 'delete-identity' });
    element('p', 'Deletes this Reader document, including its highlights and their notes. This extension cannot undo deletion.', deletion, { id: 'reader-delete-effects' });
    const deleteDraft = element('p', '', deletion, { id: 'reader-delete-draft' });
    const deleteActions = element('div', '', deletion, { class: 'delete-actions' });
    const cancelDelete = element('button', 'Cancel', deleteActions, { class: 'small', type: 'button' });
    const confirmDelete = element('button', 'Delete document', deleteActions, { class: 'small destructive', type: 'button' });
    const details = element('div', '', content);
    const summaryView = element('div', '', details, { id: 'reader-summary-view', role: 'tabpanel', 'aria-labelledby': 'reader-summary-tab', tabindex: '0' });
    const summary = element('div', '', summaryView, { class: 'summary' });
    const noteView = element('div', '', details, { class: 'note-view', id: 'reader-note-view', role: 'tabpanel', 'aria-labelledby': 'reader-note-tab' });
    const editor = element('div', '', noteView, { class: 'editor' });
    const note = MVSReaderEditor.create({
      onInput(value) { const s = current(); if (s) { clearFeedback(s); C.edit(s, value); render(); } },
      onEscape() { if (current()?.deleteConfirm) cancelDeletion(); else dismiss(true); }
    });
    editor.append(note.frame);
    const conflict = element('div', '', noteView, { class: 'conflict' });
    element('p', 'Reader has a different note. Your draft is preserved in the editor.', conflict);
    const remote = element('div', '', conflict, { class: 'remote' });
    const useRemote = element('button', 'Use Reader note', conflict, { class: 'small', type: 'button' });
    const keepDraft = element('button', 'Keep my draft for next save', conflict, { class: 'small', type: 'button' });
    const footer = element('div', '', noteView, { class: 'footer' });
    const save = element('button', 'Save note', footer, { class: 'save', type: 'button' });
    const dirty = element('span', '', footer, { class: 'muted', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    header.addEventListener('pointerdown', event => {
      if (!open || event.button !== 0 || !event.isPrimary || event.composedPath().some(node => node instanceof Element && node.matches('button,a,input,textarea,select,[contenteditable]'))) return;
      const rect = body.getBoundingClientRect();
      event.preventDefault();
      event.stopPropagation();
      drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      position = { x: rect.left, y: rect.top };
      header.dataset.dragging = 'true';
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('lostpointercapture', endDrag);
    settings.addEventListener('click', () => { closeMenu(); void send({ type: 'open-options' }); });
    more.addEventListener('click', () => openMenu('more'));
    locationButton.addEventListener('click', () => openMenu('location'));
    for (const [button, kind] of [[more, 'more'], [locationButton, 'location']]) button.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openMenu(kind, event.key === 'ArrowUp'); }
    });
    moreMenu.addEventListener('keydown', menuKey); locationMenu.addEventListener('keydown', menuKey);
    tagToggle.addEventListener('click', () => { if (!sameVideo()) return; const s = current(); if (s) { s.tagsOpen = !s.tagsOpen; render(); } });
    link.addEventListener('click', event => { if (!sameVideo() || link.getAttribute('aria-disabled') === 'true') event.preventDefault(); closeMenu(); });
    toggle.addEventListener('click', () => {
      const changed = C.canonical(location.href) !== activeUrl;
      sync(false); // Bind before opening, even if YouTube's event is still pending.
      if (!host.isConnected) return;
      if (open && !changed) { dismiss(); return; }
      const cached = peek?.cachedDoc(activeUrl), state = current();
      peek?.close();
      if (cached && !state.busy && cached.at > (state.fetchedAt || 0)) {
        C.receive(state, cached.document); state.loaded = true; state.fetchedAt = cached.at; state.locationUncertain = false;
        state.cursor = null; state.status = state.conflict ? 'Reader changed. Review the note conflict before saving.' : '';
        state.statusKind = state.conflict ? 'warning' : 'info';
      }
      open = true; render();
      (current()?.doc || current()?.dirty ? (current().tab === 'note' ? noteTab : summaryTab) : close).focus();
      if (!current()?.loaded) void load();
    });
    close.addEventListener('click', () => dismiss(true));
    summaryTab.addEventListener('click', () => selectTab('summary'));
    noteTab.addEventListener('click', () => selectTab('note'));
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tab = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'note' : current()?.tab === 'note' ? 'summary' : 'note';
      selectTab(tab, true);
    });
    refresh.addEventListener('click', () => void load());
    trash.addEventListener('click', () => selectLocation('trash'));
    cancelDelete.addEventListener('click', cancelDeletion);
    confirmDelete.addEventListener('click', () => void deleteDocument());
    deletion.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        (root.activeElement === cancelDelete ? confirmDelete : cancelDelete).focus();
      }
    });
    next.addEventListener('click', () => void load(true));
    save.addEventListener('click', () => void saveNote());
    useRemote.addEventListener('click', () => resolveConflict(false));
    keepDraft.addEventListener('click', () => resolveConflict(true));
    view = { header, content, toggle, dot, body, close, refresh, link, trash, settings, more, moreMenu, location: locationButton, locationLabel, locationMenu, locationItems, status, next, details, summary, tags, tagToggle, tagName, tagCount, tagTotal, summaryTab, noteTab, noteDot, summaryView, noteView, note, conflict, remote, save, dirty,
      deletion, deleteTitle, deleteIdentity, deleteDraft, cancelDelete, confirmDelete };
    peek = globalThis.MVSReaderPeek?.create({ toggle, root, send, beforePeek: () => sync(false), getTarget: () => {
      const s = current();
      return !open && !s?.busy && enabled && host.isConnected && !document.fullscreenElement && C.canonical(location.href) === activeUrl
        ? { url: activeUrl, visit, doc: s?.locationUncertain ? null : s?.doc, fetchedAt: s?.fetchedAt || 0 } : null;
    } });
  };
  const render = () => {
    if (!view) return;
    const s = current();
    view.toggle.setAttribute('aria-expanded', String(open));
    view.toggle.setAttribute('aria-label', `Reader${s?.dirty ? ', unsaved draft' : ''}`);
    view.toggle.title = s?.dirty ? 'Reader · Unsaved note draft' : 'Reader summary and note';
    view.dot.hidden = !s?.dirty;
    view.body.hidden = !open;
    view.summaryTab.setAttribute('aria-selected', String(s?.tab !== 'note'));
    view.summaryTab.tabIndex = s?.tab === 'note' ? -1 : 0;
    view.noteTab.setAttribute('aria-selected', String(s?.tab === 'note'));
    view.noteTab.setAttribute('aria-label', s?.dirty ? 'Note, unsaved draft' : 'Note');
    view.noteTab.tabIndex = s?.tab === 'note' ? 0 : -1;
    view.noteDot.hidden = !s?.dirty;
    view.noteTab.disabled = !s?.doc && !s?.dirty;
    view.summaryView.hidden = s?.tab === 'note';
    view.noteView.hidden = s?.tab !== 'note';
    if (!s) return;
    const confirming = Boolean(s.deleteConfirm);
    if (menu && (menu.url !== activeUrl || menu.id !== s.doc?.id || confirming)) closeMenu();
    view.location.disabled = s.busy || !s.doc || confirming || Boolean(s.locationUncertain);
    view.more.disabled = confirming;
    view.locationLabel.textContent = s.locationUncertain ? 'Unconfirmed' : s.doc ? C.locationLabel(s.doc.location) : 'Not saved';
    view.location.title = s.locationUncertain ? 'Location unconfirmed. Refresh to check Reader.' : C.locationLabel(s.doc?.location);
    view.location.setAttribute('aria-description', `Current location: ${view.locationLabel.textContent}`);
    view.location.setAttribute('aria-expanded', String(menu?.kind === 'location'));
    view.more.setAttribute('aria-expanded', String(menu?.kind === 'more'));
    view.locationMenu.hidden = menu?.kind !== 'location'; view.moreMenu.hidden = menu?.kind !== 'more';
    for (const item of view.locationItems) {
      item.disabled = view.location.disabled;
      if (item.getAttribute('data-location')) item.setAttribute('aria-checked', String(s.doc?.location === item.getAttribute('data-location')));
    }
    view.deletion.hidden = !confirming;
    view.summaryTab.disabled = confirming;
    view.noteTab.disabled = confirming || (!s.doc && !s.dirty);
    view.trash.disabled = s.busy || !s.doc || confirming;
    view.tagToggle.disabled = confirming;
    view.details.inert = confirming;
    if (confirming) {
      view.deleteTitle.textContent = s.deleteConfirm.title || 'Untitled Reader video';
      view.deleteIdentity.textContent = `${s.deleteConfirm.url} · Reader ID: ${s.deleteConfirm.id}`;
      view.deleteDraft.textContent = s.dirty ? 'Your unsaved local note will stay in this tab for copying. It will not be saved to Reader. Copy it before reloading or closing this tab.' : 'Your saved Document Note is part of this Reader document.';
    }
    if (view.status.textContent !== s.status) view.status.textContent = s.status;
    view.status.dataset.kind = s.statusKind;
    const editing = s.tab === 'note' && (s.doc || s.dirty);
    view.status.hidden = confirming || !s.status || (Boolean(s.conflict) && s.action !== 'delete') || (editing && !['error', 'warning'].includes(s.statusKind));
    view.content.dataset.empty = String(!s.doc && !s.dirty);
    view.refresh.disabled = s.busy || confirming;
    view.next.hidden = !s.cursor || Boolean(s.doc);
    view.next.disabled = s.busy || confirming;
    view.link.setAttribute('aria-disabled', String(!s.doc));
    view.link.tabIndex = s.doc ? 0 : -1;
    if (s.doc) view.link.href = C.readerUrl(s.doc.id);
    else view.link.removeAttribute('href');
    view.details.hidden = confirming || (!s.doc && !s.dirty);
    view.summary.textContent = s.doc?.summary || 'Summary not available yet. Reader may still be processing it, or automatic summaries may be disabled. Try Refresh later.';
    const tags = s.doc?.tags || [];
    view.tagToggle.hidden = tags.length === 0;
    view.tagToggle.title = tags.length ? tags.join(', ') : 'Tags';
    view.tagToggle.setAttribute('aria-label', `Show ${tags.length} tag${tags.length === 1 ? '' : 's'}`);
    view.tagToggle.setAttribute('aria-expanded', String(Boolean(s.tagsOpen)));
    view.tagName.textContent = tags[0] || '';
    view.tagCount.textContent = tags.length > 1 ? `+${tags.length - 1}` : '';
    view.tagTotal.textContent = String(tags.length);
    view.tags.hidden = confirming || !s.tagsOpen || !tags.length;
    // Do not recreate text nodes on every keypress or move focus out of the header.
    const tagKey = JSON.stringify(tags);
    if (view.tags.dataset.key !== tagKey) {
      view.tags.dataset.key = tagKey;
      view.tags.replaceChildren();
      for (const tag of tags) element('span', tag, view.tags, { class: 'tag' });
    }
    if (view.note.value !== s.value) view.note.value = s.value;
    view.save.disabled = confirming || s.busy || !s.dirty || !s.doc || Boolean(s.conflict);
    const feedback = s.busy ? 'Working…' : s.conflict ? 'Review conflict' : s.statusKind === 'error' ? (s.action === 'save' ? 'Not saved' : 'Check error') : s.moveFeedback || (s.dirty ? 'Unsaved draft' : s.feedback ? 'Saved' : '');
    if (view.dirty.textContent !== feedback) view.dirty.textContent = feedback;
    view.dirty.dataset.kind = s.statusKind === 'error' ? 'error' : s.feedback || s.moveFeedback ? 'success' : 'info';
    view.conflict.hidden = !s.conflict;
    view.remote.textContent = s.conflict?.notes || '(Empty note)';
    placePopover();
    positionMenu();
  };
  const load = async (nextPage = false, retried = false) => {
    if (!sameVideo()) return;
    const url = activeUrl, s = current();
    if (!s || s.busy || s.deleteConfirm) return;
    peek?.invalidate(url); closeMenu();
    clearTimeout(s.retryTimer);
    clearFeedback(s); s.statusKind = 'info'; s.action = 'read';
    s.busy = true; s.status = 'Checking Reader…'; render();
    const request = ++s.request, readingVisit = visit;
    const response = await send({ type: 'reader-panel-get', pageUrl: url, cursor: nextPage ? s.cursor : null, visit: readingVisit });
    sameVideo();
    if (s.request !== request) return;
    s.busy = false; s.loaded = response.code !== 'invalid_sender';
    // Browser tab metadata can briefly lag a committed SPA URL. Retry this read
    // once only; never retry a mutation or keep looping on navigation/errors.
    if (response.code === 'invalid_sender' && !retried && open && url === activeUrl && visit === readingVisit) {
      s.status = 'Checking Reader…';
      s.retryTimer = setTimeout(() => {
        if (open && visit === readingVisit && activeUrl === url && s.request === request && !s.busy) void load(nextPage, true);
      }, 250);
      render(); return;
    }
    if (response.ok && response.document) {
      s.fetchedAt = Date.now(); s.locationUncertain = false;
      C.receive(s, response.document); s.cursor = null;
      s.status = s.conflict ? 'Reader changed. Review the note conflict before saving.' : '';
      s.statusKind = s.conflict ? 'warning' : 'info';
    } else if (response.ok) {
      if (s.doc) C.removed(s, s.doc.id);
      s.conflict = null; s.cursor = response.nextCursor;
      s.status = s.cursor ? 'Not found in the videos checked so far. Search the next page, or save using the existing video overlay.'
        : 'No matching saved video found. Save using the existing video overlay, then Refresh. Documents outside Reader’s video category can be opened in Reader.';
    } else { s.status = messageFor(response); s.statusKind = 'error'; }
    if (url === activeUrl) render();
  };
  const selectLocation = async value => {
    const selected = menu;
    if (selected?.kind !== 'location') return;
    closeMenu();
    if (!sameVideo()) return;
    const url = activeUrl, s = current();
    if (!s?.doc || s.busy || s.doc.id !== selected.id || selected.url !== url) return;
    if (value === 'trash') { requestDeletion(); return; }
    if (!Object.hasOwn(C.locations, value) || s.locationUncertain) return;
    peek?.invalidate(url);
    clearFeedback(s); s.action = 'location'; s.statusKind = 'info'; s.status = 'Checking Reader before moving…';
    const id = s.doc.id, request = ++s.request;
    s.busy = true; render();
    const response = await send({ type: 'reader-panel-move', pageUrl: url, id, location: value, baseLocation: selected.baseLocation });
    sameVideo(); if (s.request !== request) return;
    s.busy = false;
    if (response.document?.id === id && response.document.videoUrl === url && s.doc?.id === id) {
      C.receive(s, response.document); s.fetchedAt = Date.now(); s.locationUncertain = false;
    }
    if (response.ok && response.document?.id === id && response.document.videoUrl === url && response.document.location === value && s.doc?.id === id) {
      if (s.conflict) { s.status = 'Location updated. Reader also has a different note; review the conflict.'; s.statusKind = 'warning'; }
      else {
        s.moveFeedback = `Now in ${C.locationLabel(s.doc.location)}`; s.status = s.moveFeedback; s.statusKind = 'info';
        const feedback = s.moveFeedback;
        s.moveTimer = setTimeout(() => {
          if (s.request !== request || s.doc?.id !== id || s.moveFeedback !== feedback) return;
          s.moveFeedback = ''; if (s.status === feedback) s.status = '';
          if (activeUrl === url) render();
        }, 3000);
      }
    } else if (response.code === 'location_conflict') {
      s.status = 'Reader’s location changed. Review its current location before choosing again.'; s.statusKind = 'warning';
    } else if (response.code === 'location_not_applied') {
      s.status = `Reader kept ${C.locationLabel(s.doc?.location)}. That destination may not be enabled in your Library.`; s.statusKind = 'error';
    } else {
      s.locationUncertain = response.ok || ['location_uncertain', 'location_cache_error'].includes(response.code);
      s.status = messageFor(response.ok ? { code: 'location_uncertain' } : response); s.statusKind = 'error';
    }
    if (url === activeUrl) render();
  };
  const saveNote = async () => {
    if (!sameVideo()) return;
    const url = activeUrl, s = current();
    if (!s?.doc || s.busy || !s.dirty || s.conflict || s.deleteConfirm) return;
    peek?.invalidate(url);
    clearFeedback(s); s.statusKind = 'info'; s.action = 'save';
    const id = s.doc.id, sent = s.value, request = ++s.request;
    s.busy = true; s.status = 'Checking Reader before saving…'; render();
    const response = await send({ type: 'reader-panel-save-note', pageUrl: url, id, notes: sent, baseNotes: s.base });
    sameVideo();
    if (s.request !== request) return;
    s.busy = false;
    if (response.ok && response.id === id && s.doc?.id === id) {
      C.saved(s, sent); s.fetchedAt = Date.now(); s.status = ''; s.statusKind = 'info';
      confirmSave(s, url, id, request, sent);
    } else if (response.code === 'conflict') {
      s.conflict = response.document; s.status = 'Reader changed. Review the note conflict before saving.'; s.statusKind = 'warning';
    } else {
      if (response.code === 'not_found') s.doc = null;
      s.status = messageFor(response); s.statusKind = 'error';
    }
    if (url === activeUrl) render();
  };
  const requestDeletion = () => {
    if (!sameVideo()) return;
    const s = current();
    if (!s?.doc || s.busy || C.canonical(location.href) !== activeUrl) return;
    closeMenu(); peek?.invalidate(activeUrl); clearFeedback(s);
    s.deleteConfirm = { url: activeUrl, id: s.doc.id, title: s.doc.title || '', baseNotes: s.doc.notes, updatedAt: s.doc.updatedAt || '' };
    render(); view.cancelDelete.focus();
  };
  const cancelDeletion = () => {
    const s = current();
    if (!s?.deleteConfirm) return;
    s.deleteConfirm = null; render(); view.location.focus();
  };
  const deleteDocument = async () => {
    if (!sameVideo()) return;
    const url = activeUrl, s = current(), confirmation = s?.deleteConfirm;
    if (!confirmation || s.busy || confirmation.url !== url || C.canonical(location.href) !== url || s.doc?.id !== confirmation.id) return;
    const id = confirmation.id, request = ++s.request;
    s.deleteConfirm = null; s.busy = true; s.status = 'Checking Reader before deleting…'; s.statusKind = 'info'; s.action = 'delete';
    render(); view.trash.blur();
    const response = await send({ type: 'reader-panel-delete', pageUrl: url, id, confirmed: true,
      title: confirmation.title, baseNotes: confirmation.baseNotes, updatedAt: confirmation.updatedAt });
    sameVideo();
    if (s.request !== request) return;
    s.busy = false;
    if (response.ok && response.id === id && C.removed(s, id)) {
      s.cursor = null; s.loaded = true; s.tagsOpen = false;
      s.status = response.alreadyDeleted ? 'This document is already absent from Reader.' : 'Deleted from Reader.';
      s.status += s.dirty ? ' Your unsaved note is kept in this tab for copying.' : ' Save using the existing video overlay if you want to add it again.';
      s.statusKind = s.dirty ? 'warning' : 'info';
      if (s.dirty) s.tab = 'note';
    } else if (response.code === 'delete_conflict' && response.document?.id === id) {
      C.receive(s, response.document);
      s.status = 'Reader changed since the confirmation. Review the current document before choosing Delete again. Your draft is kept.';
      s.statusKind = 'warning';
    } else { s.status = messageFor(response); s.statusKind = 'error'; }
    if (url === activeUrl) { render(); if (open) view.close.focus(); }
  };
  const resolveConflict = (keep) => {
    if (!sameVideo()) return;
    const s = current();
    if (!s?.conflict || s.busy) return;
    const value = s.value;
    s.doc = s.conflict; s.base = s.conflict.notes; s.conflict = null;
    C.edit(s, keep ? value : s.base);
    s.statusKind = 'info';
    s.status = keep ? 'Draft kept. Save note will check Reader again before replacing it.' : 'Using the note from Reader.';
    render();
  };
  const sync = (readIfOpen = true) => {
    clearTimeout(syncTimer); syncTimer = null;
    const url = C.canonical(location.href);
    const supported = url && !/^\/(embed|shorts)\//.test(location.pathname);
    const changed = url !== activeUrl;
    if (changed) {
      closeMenu(); peek?.close();
      const previous = current();
      clearFeedback(previous); clearTimeout(previous?.retryTimer);
      if (previous) {
        previous.deleteConfirm = null;
        if (previous.busy && previous.action === 'read') { previous.request++; previous.busy = false; }
      }
      activeUrl = url; visit++; endDrag();
      const nextState = current();
      if (nextState) {
        nextState.loaded = false; nextState.cursor = null; nextState.deleteConfirm = null;
        if (!nextState.busy) { nextState.status = ''; nextState.statusKind = 'info'; }
      }
    }
    if (!enabled || !supported || document.fullscreenElement) { dismiss(); host?.remove(); return; }
    if (!host) createView();
    if (host.parentElement !== document.documentElement) document.documentElement.append(host);
    view.note.mount(); applyTheme();
    render();
    if (changed && open && readIfOpen && !current()?.busy) void load();
  };
  const schedule = () => {
    if (syncTimer === null) syncTimer = setTimeout(sync, 150);
  };
  chrome.storage.local.get({ showReaderPanel: false, readerPanelTheme: 'system' }, data => {
    enabled = data.showReaderPanel === true;
    theme = ['light', 'dark'].includes(data.readerPanelTheme) ? data.readerPanelTheme : 'system';
    sync();
  });
  systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.readerPanelTheme) { theme = ['light', 'dark'].includes(changes.readerPanelTheme.newValue) ? changes.readerPanelTheme.newValue : 'system'; applyTheme(); }
    if (changes.showReaderPanel) { enabled = changes.showReaderPanel.newValue === true; schedule(); }
    if (changes.readerToken) {
      closeMenu(); peek?.invalidate();
      for (const s of states.values()) { clearTimeout(s.retryTimer); clearFeedback(s); s.deleteConfirm = null; s.loaded = false; s.doc = null; s.conflict = null; s.request++; s.busy = false; }
      render();
    }
    // Storage changes never drive API reads. Invalidate a removed/replaced identity
    // in other open panels too, retaining drafts and cancelling stale confirmations.
    if (changes.readerDocuments) {
      const { oldValue = {}, newValue = {} } = changes.readerDocuments;
      peek?.documentsChanged(oldValue, newValue);
      for (const [url, s] of states) {
        s.loaded = false;
        const previous = oldValue?.[url]?.id;
        if (!s.doc || previous !== s.doc.id || newValue?.[url]?.id === previous || (s.busy && s.action === 'delete')) continue;
        clearFeedback(s); C.removed(s, previous); s.deleteConfirm = null;
        // An ongoing lookup can discover a replacement after it removes a stale
        // index entry. Keep that read's reply valid; pending edits are invalidated.
        if (!(s.busy && s.action === 'read')) { s.request++; s.busy = false; }
        s.status = 'The saved Reader document was removed or replaced. Refresh to check Reader. Your local draft is kept.';
        s.statusKind = 'warning'; s.cursor = null;
        if (s.dirty) s.tab = 'note';
      }
      render();
    }
    if (changes.readerDocumentUpdates) {
      const update = changes.readerDocumentUpdates.newValue;
      if (update) {
        peek?.invalidate(update.videoUrl);
        const s = states.get(update.videoUrl);
        if (s?.doc?.id === update.id && !(s.busy && s.action === 'location')) {
          s.doc = { ...s.doc, location: update.location, updatedAt: update.updatedAt }; s.loaded = false; s.fetchedAt = 0;
          s.locationUncertain = false; s.deleteConfirm = null; closeMenu(); render();
        }
      }
    }
  });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', () => sync());
  document.addEventListener('yt-page-data-updated', () => sync());
  document.addEventListener('fullscreenchange', schedule);
  document.addEventListener('pointerdown', event => {
    if (menu && !event.composedPath().includes(view.moreMenu) && !event.composedPath().includes(view.locationMenu) && !event.composedPath().includes(view.more) && !event.composedPath().includes(view.location)) closeMenu();
    if (peek?.active() && !event.composedPath().includes(host)) peek.close();
    if (open && !event.composedPath().includes(host)) dismiss();
  }, true);
  document.addEventListener('focusin', event => {
    if (menu && !event.composedPath().includes(view.moreMenu) && !event.composedPath().includes(view.locationMenu) && !event.composedPath().includes(view.more) && !event.composedPath().includes(view.location)) closeMenu();
    if (open && !event.composedPath().includes(host)) dismiss();
  });
  document.addEventListener('keydown', event => {
    if (!open && peek?.active() && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); peek.close(); return; }
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (menu) closeMenu(true); else if (current()?.deleteConfirm) cancelDeletion(); else dismiss(true);
    }
  }, true);
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopPropagation();
    position = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
    placePopover();
  }, true);
  window.addEventListener('pointerup', event => {
    if (drag && event.pointerId === drag.id) { event.stopPropagation(); endDrag(); }
  }, true);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => { endDrag(); placePopover(); positionMenu(); });
  window.addEventListener('popstate', () => sync());
  window.addEventListener('beforeunload', event => {
    if ([...states.values()].some(s => s.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
