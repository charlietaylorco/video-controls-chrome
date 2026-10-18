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
  let scheduled = false;
  const stateFor = (url) => {
    if (!states.has(url)) states.set(url, { ...C.draft(), status: '', cursor: null, loaded: false, tab: 'summary', tagsOpen: false });
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
    not_found: 'This Reader document was deleted or no longer matches this video. Your draft is kept. Refresh to find it again.',
    invalid_sender: 'The video changed. Reopen the panel on this video and try again.',
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
    open = false;
    render();
    if (restoreFocus && host?.isConnected) view.toggle.focus();
  };
  const selectTab = (tab, focus = false) => {
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
      :host{position:fixed;top:0;right:0;width:min(390px,100vw);z-index:2147483000;pointer-events:none;color:var(--yt-spec-text-primary,#171717);font:14px/1.55 "YouTube Sans",Roboto,sans-serif;color-scheme:light dark}
      *{box-sizing:border-box}[hidden]{display:none!important}button,a,textarea{font:inherit}button,a{color:inherit}button{cursor:pointer}svg{display:block;width:17px;height:17px;flex-shrink:0}
      .launch-row{display:flex;justify-content:flex-end}.toggle{pointer-events:auto;position:relative;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.3));border-top:0;border-right:0;border-radius:0 0 0 11px;padding:0;background:var(--yt-spec-base-background,#fff);box-shadow:0 2px 8px #00000010}.toggle svg{width:20px;height:20px}.toggle .draft-dot{position:absolute;top:5px;right:5px}
      .draft-dot{width:5px;height:5px;border-radius:50%;background:#c5912e}.body{pointer-events:auto;margin-top:4px;max-height:min(680px,calc(100dvh - 40px));overflow:auto;overscroll-behavior:contain;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.25));border-radius:12px 0 12px 12px;background:var(--yt-spec-base-background,#fff);box-shadow:0 10px 36px #00000024}
      .header{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:center;padding:5px 6px 0;position:sticky;top:0;background:var(--yt-spec-base-background,#fff);z-index:1;border-bottom:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.2))}.tabs{grid-column:1;display:flex;gap:8px;white-space:nowrap}.tab{display:flex;align-items:center;gap:4px;height:32px;padding:0 2px;background:transparent;border:0;border-bottom:2px solid transparent;font-size:12px;color:var(--yt-spec-text-secondary,#666)}.tab[aria-selected="true"]{color:var(--yt-spec-text-primary,#171717);border-bottom-color:currentColor;font-weight:600}
      .actions{grid-column:3;display:flex;gap:2px;align-items:center}.icon{display:grid;place-items:center;width:28px;height:28px;flex-shrink:0;padding:0;border:0;border-radius:6px;background:transparent;text-decoration:none}.icon[aria-disabled="true"]{opacity:.4;pointer-events:none}
      .tag-toggle{grid-column:2;display:flex;align-items:center;gap:4px;justify-self:start;min-width:0;max-width:100%;height:25px;padding:0 6px;border:0;border-radius:6px;font-size:11px;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.1))}.tag-toggle svg{width:12px;height:12px}.tag-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tag-count{flex-shrink:0;font-size:10px;color:var(--yt-spec-text-secondary,#666)}.tag-total{display:none}.tags{display:flex;gap:5px;flex-wrap:wrap;max-height:130px;overflow:auto;margin:0 0 10px}.tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.1));overflow-wrap:anywhere;max-width:100%}
      button:hover,a:hover{background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.12))}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #b38523;outline-offset:-2px}
      .content{padding:12px}.summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.75}textarea{display:block;resize:vertical;width:100%;min-height:160px;max-height:320px;padding:10px;border-radius:9px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.4));background:transparent;color:inherit;line-height:1.6}
      .footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:9px}.save{border:0;border-radius:18px;background:#e9be61;color:#211b10;font-weight:600;padding:6px 13px}.muted,.status{font-size:12px;color:var(--yt-spec-text-secondary,#666)}.status{margin:0 0 10px;overflow-wrap:anywhere}.small{padding:5px 9px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.3));border-radius:18px;background:transparent;font-size:12px}
      .conflict{border-left:3px solid #c59b42;padding:8px 10px;margin-top:10px;font-size:12px}.remote{white-space:pre-wrap;max-height:150px;overflow:auto;overflow-wrap:anywhere;margin-bottom:8px}.conflict button{margin:4px 3px 0 0}
      @media(max-width:360px){.tag-name,.tag-count{display:none}.tag-total{display:inline}.tag-toggle{padding:0 5px}.header{gap:4px;padding-left:5px;padding-right:5px}.tabs{gap:5px}.tab{font-size:11px}.actions{gap:0}}
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
    const tagToggle = element('button', '', header, { class: 'tag-toggle', type: 'button', 'aria-label': 'Show tags', 'aria-expanded': 'false', 'aria-controls': 'reader-tags' });
    icon(tagToggle, ['m20 13-7 7L3 10V3h7l10 10Z', 'M7 7h.01']);
    const tagName = element('span', '', tagToggle, { class: 'tag-name' });
    const tagCount = element('span', '', tagToggle, { class: 'tag-count', 'aria-hidden': 'true' });
    const tagTotal = element('span', '', tagToggle, { class: 'tag-total', 'aria-hidden': 'true' });
    const actions = element('div', '', header, { class: 'actions' });
    const refresh = element('button', '', actions, { class: 'icon', type: 'button', title: 'Refresh', 'aria-label': 'Refresh' });
    icon(refresh, ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 5', 'M20 7v5']);
    const link = element('a', '', actions, { class: 'icon', title: 'Open in Reader', 'aria-label': 'Open in Reader', target: '_blank', rel: 'noopener noreferrer' });
    icon(link, ['M14 3h7v7', 'M10 14 21 3', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5']);
    const settings = element('button', '', actions, { class: 'icon', type: 'button', title: 'Options', 'aria-label': 'Extension options' });
    icon(settings, ['M10 2h4l.6 2.7L17 6.1l2.6-.8 2 3.4-2 1.9v2.8l2 1.9-2 3.4-2.6-.8-2.4 1.4L14 22h-4l-.6-2.7L7 17.9l-2.6.8-2-3.4 2-1.9v-2.8l-2-1.9 2-3.4 2.6.8 2.4-1.4L10 2Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0']);
    const close = element('button', '', actions, { class: 'icon close', type: 'button', title: 'Close', 'aria-label': 'Close Reader' });
    icon(close, ['m6 6 12 12', 'M6 18 18 6']);
    const content = element('div', '', body, { class: 'content' });
    const status = element('p', '', content, { class: 'status', role: 'status', 'aria-live': 'polite' });
    const next = element('button', 'Search next 100 videos', content, { class: 'small', type: 'button' });
    const tags = element('div', '', content, { class: 'tags', id: 'reader-tags', 'aria-label': 'Reader tags' });
    const details = element('div', '', content);
    const summaryView = element('div', '', details, { id: 'reader-summary-view', role: 'tabpanel', 'aria-labelledby': 'reader-summary-tab', tabindex: '0' });
    const summary = element('div', '', summaryView, { class: 'summary' });
    const noteView = element('div', '', details, { id: 'reader-note-view', role: 'tabpanel', 'aria-labelledby': 'reader-note-tab' });
    const note = element('textarea', '', noteView, { id: 'reader-note', 'aria-label': 'Document Note', placeholder: 'Add a thought about this video…' });
    const conflict = element('div', '', noteView, { class: 'conflict' });
    element('p', 'Reader has a different note. Compare it below; your draft is kept above.', conflict);
    const remote = element('div', '', conflict, { class: 'remote' });
    const useRemote = element('button', 'Use Reader note', conflict, { class: 'small', type: 'button' });
    const keepDraft = element('button', 'Keep my draft for next save', conflict, { class: 'small', type: 'button' });
    const footer = element('div', '', noteView, { class: 'footer' });
    const save = element('button', 'Save note', footer, { class: 'save', type: 'button' });
    const dirty = element('span', '', footer, { class: 'muted' });
    settings.addEventListener('click', () => void send({ type: 'open-options' }));
    tagToggle.addEventListener('click', () => { const s = current(); if (s) { s.tagsOpen = !s.tagsOpen; render(); } });
    toggle.addEventListener('click', () => {
      if (open) { dismiss(); return; }
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
    next.addEventListener('click', () => void load(true));
    note.addEventListener('input', () => { const s = current(); if (s) { C.edit(s, note.value); render(); } });
    save.addEventListener('click', () => void saveNote());
    useRemote.addEventListener('click', () => resolveConflict(false));
    keepDraft.addEventListener('click', () => resolveConflict(true));
    view = { toggle, dot, body, refresh, link, status, next, details, summary, tags, tagToggle, tagName, tagCount, tagTotal, summaryTab, noteTab, noteDot, summaryView, noteView, note, conflict, remote, save, dirty };
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
    view.status.textContent = s.status;
    view.status.hidden = !s.status;
    view.refresh.disabled = s.busy;
    view.next.hidden = !s.cursor || Boolean(s.doc);
    view.next.disabled = s.busy;
    view.link.setAttribute('aria-disabled', String(!s.doc));
    view.link.tabIndex = s.doc ? 0 : -1;
    if (s.doc) view.link.href = C.readerUrl(s.doc.id);
    else view.link.removeAttribute('href');
    view.details.hidden = !s.doc && !s.dirty;
    view.summary.textContent = s.doc?.summary || 'Summary not available yet. Reader may still be processing it, or automatic summaries may be disabled. Try Refresh later.';
    const tags = s.doc?.tags || [];
    view.tagToggle.hidden = tags.length === 0;
    view.tagToggle.title = tags.length ? tags.join(', ') : 'Tags';
    view.tagToggle.setAttribute('aria-label', `Show ${tags.length} tag${tags.length === 1 ? '' : 's'}`);
    view.tagToggle.setAttribute('aria-expanded', String(Boolean(s.tagsOpen)));
    view.tagName.textContent = tags[0] || '';
    view.tagCount.textContent = tags.length > 1 ? `+${tags.length - 1}` : '';
    view.tagTotal.textContent = String(tags.length);
    view.tags.hidden = !s.tagsOpen || !tags.length;
    // Do not recreate text nodes on every keypress or move focus out of the header.
    const tagKey = JSON.stringify(tags);
    if (view.tags.dataset.key !== tagKey) {
      view.tags.dataset.key = tagKey;
      view.tags.replaceChildren();
      for (const tag of tags) element('span', tag, view.tags, { class: 'tag' });
    }
    if (view.note.value !== s.value) view.note.value = s.value;
    view.save.disabled = s.busy || !s.dirty || !s.doc || Boolean(s.conflict);
    view.dirty.textContent = s.busy ? 'Working…' : s.dirty ? 'Unsaved draft' : 'Saved in Reader';
    view.conflict.hidden = !s.conflict;
    view.remote.textContent = s.conflict?.notes || '(Empty note)';
  };
  const load = async (nextPage = false) => {
    const url = activeUrl, s = current();
    if (!s || s.busy) return;
    s.busy = true; s.status = 'Checking Reader…'; render();
    const request = ++s.request;
    const response = await send({ type: 'reader-panel-get', pageUrl: url, cursor: nextPage ? s.cursor : null });
    if (s.request !== request) return;
    s.busy = false; s.loaded = true;
    if (response.ok && response.document) {
      C.receive(s, response.document); s.cursor = null;
      s.status = s.conflict ? 'Reader changed. Review the note conflict before saving.' : '';
    } else if (response.ok) {
      s.doc = null; s.cursor = response.nextCursor;
      s.status = s.cursor ? 'Not found in the videos checked so far. Search the next page, or save using the existing video overlay.'
        : 'No matching saved video found. Save using the existing video overlay, then Refresh. Documents outside Reader’s video category can be opened in Reader.';
    } else s.status = messageFor(response);
    if (url === activeUrl) render();
  };
  const saveNote = async () => {
    const url = activeUrl, s = current();
    if (!s?.doc || s.busy || !s.dirty || s.conflict) return;
    const id = s.doc.id, sent = s.value, request = ++s.request;
    s.busy = true; s.status = 'Checking Reader before saving…'; render();
    const response = await send({ type: 'reader-panel-save-note', pageUrl: url, id, notes: sent, baseNotes: s.base });
    if (s.request !== request) return;
    s.busy = false;
    if (response.ok && response.id === id && s.doc?.id === id) {
      C.saved(s, sent); s.status = s.dirty ? 'Saved. Newer edits are still an unsaved draft.' : 'Document Note saved.';
    } else if (response.code === 'conflict') {
      s.conflict = response.document; s.status = 'Reader changed. Review the note conflict before saving.';
    } else {
      if (response.code === 'not_found') s.doc = null;
      s.status = messageFor(response);
    }
    if (url === activeUrl) render();
  };
  const resolveConflict = (keep) => {
    const s = current();
    if (!s?.conflict || s.busy) return;
    const value = s.value;
    s.doc = s.conflict; s.base = s.conflict.notes; s.conflict = null;
    C.edit(s, keep ? value : s.base);
    s.status = keep ? 'Draft kept. Save note will check Reader again before replacing it.' : 'Using the note from Reader.';
    render();
  };
  const sync = () => {
    scheduled = false;
    const url = C.canonical(location.href);
    const supported = url && !/^\/(embed|shorts)\//.test(location.pathname);
    if (url !== activeUrl) { activeUrl = url; dismiss(); }
    if (!enabled || !supported || document.fullscreenElement) { dismiss(); host?.remove(); return; }
    if (!host) createView();
    if (host.parentElement !== document.documentElement) document.documentElement.append(host);
    render();
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; setTimeout(sync, 150); }
  };
  chrome.storage.local.get({ showReaderPanel: false }, data => { enabled = data.showReaderPanel === true; sync(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.showReaderPanel) { enabled = changes.showReaderPanel.newValue === true; schedule(); }
    if (changes.readerToken) {
      for (const s of states.values()) { s.loaded = false; s.doc = null; s.conflict = null; s.request++; s.busy = false; }
      render();
    }
    // Saving via the existing overlay only invalidates readiness; opening/Refresh drives reads.
    if (changes.readerDocuments) for (const s of states.values()) s.loaded = false;
  });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('fullscreenchange', schedule);
  document.addEventListener('pointerdown', event => {
    if (open && !event.composedPath().includes(host)) dismiss();
  }, true);
  document.addEventListener('focusin', event => {
    if (open && !event.composedPath().includes(host)) dismiss();
  });
  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    }
  }, true);
  window.addEventListener('popstate', schedule);
  window.addEventListener('beforeunload', event => {
    if ([...states.values()].some(s => s.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
