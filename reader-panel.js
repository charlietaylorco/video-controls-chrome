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
    if (!states.has(url)) states.set(url, { ...C.draft(), status: '', cursor: null, loaded: false, tab: 'summary' });
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
    if (!s) return;
    s.tab = tab;
    render();
    if (focus) (tab === 'summary' ? view.summaryTab : view.noteTab).focus();
  };
  const createView = () => {
    host = document.createElement('div');
    host.id = 'mvs-reader-panel';
    root = host.attachShadow({ mode: 'closed' });
    const style = element('style', '', root);
    style.textContent = `
      :host{--reader-top:clamp(12px,calc(100dvh - 180px),72px);position:fixed;top:var(--reader-top);right:max(12px,env(safe-area-inset-right));width:min(390px,calc(100vw - 24px));z-index:2147483000;pointer-events:none;color:var(--yt-spec-text-primary,#171717);font:14px/1.55 "YouTube Sans",Roboto,sans-serif;color-scheme:light dark}
      *{box-sizing:border-box}[hidden]{display:none!important}button,a,textarea{font:inherit}button,a{color:inherit}button{cursor:pointer}
      .launch-row{display:flex;justify-content:flex-end}.toggle{pointer-events:auto;display:flex;align-items:center;gap:8px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.3));border-radius:20px;padding:6px 12px 6px 7px;font-size:12px;font-weight:600;background:var(--yt-spec-base-background,#fff);box-shadow:0 2px 10px #00000012}
      .mark{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:#f2c867;color:#292219;font:bold 16px Georgia,serif}.draft-dot{width:6px;height:6px;border-radius:50%;background:#c5912e}.body{pointer-events:auto;margin-top:8px;max-height:min(680px,calc(100dvh - var(--reader-top) - 56px));overflow:auto;overscroll-behavior:contain;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.25));border-radius:16px;background:var(--yt-spec-base-background,#fff);box-shadow:0 12px 48px #00000024}
      .heading{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 8px;position:sticky;top:0;background:var(--yt-spec-base-background,#fff);z-index:1}.heading h2{font-size:14px;margin:0;font-weight:650}.close{border:0;background:transparent;border-radius:50%;width:28px;height:28px;font-size:22px;line-height:1}
      .content{padding:0 16px 16px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}button.small,a{padding:5px 10px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.3));border-radius:18px;background:transparent;text-decoration:none;font-size:12px}
      button:hover,a:hover{background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.12))}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #b38523;outline-offset:2px}
      .tabs{display:flex;gap:18px;border-bottom:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.2));margin:14px 0}.tab{position:relative;padding:8px 0;background:transparent;border:0;border-bottom:2px solid transparent;font-size:13px;color:var(--yt-spec-text-secondary,#666)}.tab[aria-selected="true"]{color:var(--yt-spec-text-primary,#171717);border-bottom-color:currentColor;font-weight:600}.tab .draft-dot{display:inline-block;vertical-align:middle;margin-left:5px}
      .summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.75}.tags{display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.1));overflow-wrap:anywhere;max-width:100%}
      label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:650;margin:0 0 8px;color:var(--yt-spec-text-secondary,#666)}textarea{display:block;resize:vertical;width:100%;min-height:160px;max-height:320px;padding:11px;border-radius:10px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.4));background:transparent;color:inherit;line-height:1.6}
      .footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}.save{border:0;border-radius:20px;background:#e9be61;color:#211b10;font-weight:600;padding:7px 14px}.muted,.status,.hint{font-size:12px;color:var(--yt-spec-text-secondary,#666)}.status{margin:8px 0 12px;overflow-wrap:anywhere}.hint{font-size:11px;margin:12px 0 0;line-height:1.5}
      .conflict{border-left:3px solid #c59b42;padding:8px 10px;margin-top:12px;font-size:12px}.remote{white-space:pre-wrap;max-height:150px;overflow:auto;overflow-wrap:anywhere;margin-bottom:8px}.conflict button{margin:4px 3px 0 0}
      @media(max-width:420px){.content{padding:0 13px 14px}.heading{padding:10px 13px 6px}}
    `;
    const row = element('div', '', root, { class: 'launch-row' });
    const toggle = element('button', '', row, { class: 'toggle', type: 'button', 'aria-label': 'Open Reader', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'reader-body' });
    element('span', 'r', toggle, { class: 'mark', 'aria-hidden': 'true' });
    element('span', 'Reader', toggle);
    const dot = element('span', '', toggle, { class: 'draft-dot', 'aria-hidden': 'true' });
    const body = element('section', '', root, { class: 'body', id: 'reader-body', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'reader-title' });
    body.hidden = true;
    const heading = element('div', '', body, { class: 'heading' });
    element('h2', 'Reader', heading, { id: 'reader-title' });
    const close = element('button', '×', heading, { class: 'close', type: 'button', 'aria-label': 'Close Reader' });
    const content = element('div', '', body, { class: 'content' });
    const toolbar = element('div', '', content, { class: 'toolbar' });
    const refresh = element('button', 'Refresh', toolbar, { class: 'small', type: 'button' });
    const link = element('a', 'Open in Reader ↗', toolbar, { target: '_blank', rel: 'noopener noreferrer' });
    const settings = element('button', 'Options', toolbar, { class: 'small', type: 'button', 'aria-label': 'Extension options' });
    settings.addEventListener('click', () => void send({ type: 'open-options' }));
    const status = element('p', '', content, { class: 'status', role: 'status', 'aria-live': 'polite' });
    const next = element('button', 'Search next 100 videos', content, { class: 'small', type: 'button' });
    const details = element('div', '', content);
    const tags = element('div', '', details, { class: 'tags', 'aria-label': 'Reader tags' });
    const tabs = element('div', '', details, { class: 'tabs', role: 'tablist', 'aria-label': 'Reader views' });
    const summaryTab = element('button', 'Summary', tabs, { class: 'tab', id: 'reader-summary-tab', type: 'button', role: 'tab', 'aria-controls': 'reader-summary-view' });
    const noteTab = element('button', 'Note', tabs, { class: 'tab', id: 'reader-note-tab', type: 'button', role: 'tab', 'aria-controls': 'reader-note-view' });
    const noteDot = element('span', '', noteTab, { class: 'draft-dot', 'aria-hidden': 'true' });
    const summaryView = element('div', '', details, { id: 'reader-summary-view', role: 'tabpanel', 'aria-labelledby': 'reader-summary-tab', tabindex: '0' });
    const summary = element('div', '', summaryView, { class: 'summary' });
    const noteView = element('div', '', details, { id: 'reader-note-view', role: 'tabpanel', 'aria-labelledby': 'reader-note-tab' });
    element('label', 'Document Note', noteView, { for: 'reader-note' });
    const note = element('textarea', '', noteView, { id: 'reader-note', placeholder: 'Add a thought about this video…' });
    const conflict = element('div', '', noteView, { class: 'conflict' });
    element('p', 'Reader has a different note. Compare it below; your draft is kept above.', conflict);
    const remote = element('div', '', conflict, { class: 'remote' });
    const useRemote = element('button', 'Use Reader note', conflict, { class: 'small', type: 'button' });
    const keepDraft = element('button', 'Keep my draft for next save', conflict, { class: 'small', type: 'button' });
    const footer = element('div', '', noteView, { class: 'footer' });
    const save = element('button', 'Save note', footer, { class: 'save', type: 'button' });
    const dirty = element('span', '', footer, { class: 'muted' });
    element('p', 'Drafts stay in this tab when dismissed or switching videos. Save replaces the Document Note; an empty note clears it.', noteView, { class: 'hint' });
    toggle.addEventListener('click', () => {
      if (open) { dismiss(); return; }
      open = true; render();
      // The tabs may be hidden while an unsaved video is being located.
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
    view = { toggle, dot, body, refresh, link, status, next, details, summary, tags, summaryTab, noteTab, noteDot, summaryView, noteView, note, conflict, remote, save, dirty };
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
    view.summaryView.hidden = s?.tab === 'note';
    view.noteView.hidden = s?.tab !== 'note';
    if (!s) return;
    view.status.textContent = s.status;
    view.refresh.disabled = s.busy;
    view.next.hidden = !s.cursor || Boolean(s.doc);
    view.next.disabled = s.busy;
    view.link.hidden = !s.doc;
    if (s.doc) view.link.href = C.readerUrl(s.doc.id);
    else view.link.removeAttribute('href');
    view.details.hidden = !s.doc && !s.dirty;
    view.summary.textContent = s.doc?.summary || 'Summary not available yet. Reader may still be processing it, or automatic summaries may be disabled. Try Refresh later.';
    view.tags.replaceChildren();
    for (const tag of s.doc?.tags || []) element('span', tag, view.tags, { class: 'tag' });
    if (!s.doc?.tags.length) element('span', 'No tags yet', view.tags, { class: 'muted' });
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
      s.status = s.conflict ? 'Reader changed. Review the note conflict before saving.' : 'Up to date with Reader.';
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
