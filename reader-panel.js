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
    if (!states.has(url)) states.set(url, { ...C.draft(), status: '', cursor: null, loaded: false });
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
  const createView = () => {
    host = document.createElement('div');
    host.id = 'mvs-reader-panel';
    root = host.attachShadow({ mode: 'closed' });
    const style = element('style', '', root);
    style.textContent = `
      :host{display:block;margin:14px 0;color:var(--yt-spec-text-primary,#171717);font:14px/1.55 "YouTube Sans",Roboto,sans-serif;color-scheme:light dark}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,a,textarea{font:inherit}button,a{color:inherit}button{cursor:pointer}
      .shell{border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.28));border-radius:16px;overflow:hidden;background:var(--yt-spec-base-background,#fff)}
      .toggle{border:0;background:transparent;display:flex;align-items:center;gap:10px;width:100%;padding:13px 18px;text-align:left;font-weight:600}
      .mark{display:grid;place-items:center;width:25px;height:25px;border-radius:7px;background:#f2c867;color:#292219;font:bold 16px Georgia,serif}
      .sub{font-weight:400;color:var(--yt-spec-text-secondary,#666);font-size:12px;margin-left:auto}.chevron{font-size:16px}
      .body{padding:0 20px 20px;border-top:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.2))}
      .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 0 4px}
      button.small,a{padding:6px 12px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.3));border-radius:20px;background:transparent;text-decoration:none;font-size:12px}
      button:hover,a:hover{background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.12))}button:disabled{opacity:.5;cursor:default}
      button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #b38523;outline-offset:3px}
      h3,label{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:650;margin:20px 0 8px;color:var(--yt-spec-text-secondary,#666)}
      .summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.7;max-height:380px;overflow:auto}
      .tags{display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:12px;padding:3px 10px;border-radius:6px;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.1));overflow-wrap:anywhere;max-width:100%}
      textarea{display:block;resize:vertical;width:100%;min-height:130px;padding:12px;border-radius:10px;border:1px solid var(--yt-spec-10-percent-layer,rgba(128,128,128,.4));background:transparent;color:inherit;line-height:1.6}
      .footer{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px}.save{border:0;border-radius:20px;background:#e9be61;color:#211b10;font-weight:600;padding:8px 16px}
      .muted,.status,.hint{font-size:12px;color:var(--yt-spec-text-secondary,#666)}.status{margin:10px 0;overflow-wrap:anywhere}
      .conflict{border-left:3px solid #c59b42;padding:8px 12px;margin-top:12px}.remote{white-space:pre-wrap;max-height:150px;overflow:auto;overflow-wrap:anywhere}.hint{margin:10px 0 0}
      @media(max-width:600px){.sub{display:none}.body{padding:0 14px 16px}.summary{font-size:14px}}
    `;
    const shell = element('section', '', root, { class: 'shell', 'aria-label': 'Reader' });
    const toggle = element('button', '', shell, { class: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'reader-body' });
    element('span', 'r', toggle, { class: 'mark', 'aria-hidden': 'true' });
    element('span', 'Reader', toggle);
    const subtitle = element('span', 'Summary · Tags · Document Note', toggle, { class: 'sub' });
    const chevron = element('span', '+', toggle, { class: 'chevron', 'aria-hidden': 'true' });
    const body = element('div', '', shell, { class: 'body', id: 'reader-body' });
    body.hidden = true;
    const toolbar = element('div', '', body, { class: 'toolbar' });
    const refresh = element('button', 'Refresh', toolbar, { class: 'small', type: 'button' });
    const link = element('a', 'Open in Reader ↗', toolbar, { target: '_blank', rel: 'noopener noreferrer' });
    const settings = element('button', 'Extension options', toolbar, { class: 'small', type: 'button' });
    settings.addEventListener('click', () => void send({ type: 'open-options' }));
    const status = element('p', '', body, { class: 'status', role: 'status', 'aria-live': 'polite' });
    const next = element('button', 'Search next 100 videos', body, { class: 'small', type: 'button' });
    const details = element('div', '', body);
    element('h3', 'Summary', details);
    const summary = element('div', '', details, { class: 'summary' });
    element('h3', 'Tags', details);
    const tags = element('div', '', details, { class: 'tags' });
    element('label', 'Document Note', details, { for: 'reader-note' });
    const note = element('textarea', '', details, { id: 'reader-note', placeholder: 'Add a thought about this video…' });
    const conflict = element('div', '', details, { class: 'conflict' });
    element('p', 'Reader has a different note. Compare it below; your draft is kept above.', conflict);
    const remote = element('div', '', conflict, { class: 'remote' });
    const useRemote = element('button', 'Use Reader note', conflict, { class: 'small', type: 'button' });
    const keepDraft = element('button', 'Keep my draft for next save', conflict, { class: 'small', type: 'button' });
    const footer = element('div', '', details, { class: 'footer' });
    const save = element('button', 'Save note', footer, { class: 'save', type: 'button' });
    const dirty = element('span', '', footer, { class: 'muted' });
    element('p', 'Drafts stay in this tab while you switch videos. Save replaces the Document Note; an empty note clears it.', details, { class: 'hint' });
    toggle.addEventListener('click', () => {
      open = !open; render();
      if (open && !current()?.loaded) void load();
    });
    refresh.addEventListener('click', () => void load());
    next.addEventListener('click', () => void load(true));
    note.addEventListener('input', () => { const s = current(); if (s) { C.edit(s, note.value); render(); } });
    save.addEventListener('click', () => void saveNote());
    useRemote.addEventListener('click', () => resolveConflict(false));
    keepDraft.addEventListener('click', () => resolveConflict(true));
    view = { toggle, subtitle, chevron, body, refresh, link, status, next, details, summary, tags, note, conflict, remote, save, dirty };
  };
  const render = () => {
    if (!view) return;
    const s = current();
    view.toggle.setAttribute('aria-expanded', String(open));
    view.chevron.textContent = open ? '−' : '+';
    view.body.hidden = !open;
    view.subtitle.textContent = s?.dirty ? 'Unsaved draft' : 'Summary · Tags · Document Note';
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
    // Embeds and Shorts have no stable below-player details surface in this MVP.
    const supported = url && !/^\/(embed|shorts)\//.test(location.pathname);
    if (url !== activeUrl) { activeUrl = url; open = false; render(); }
    if (!enabled || !supported) { host?.remove(); return; }
    if (!host) createView();
    {
      const anchor = document.querySelector('ytd-watch-metadata #above-the-fold') ||
        document.querySelector('#primary-inner') || document.querySelector('#watch-below-the-player');
      if (anchor && host.parentElement !== anchor) anchor.append(host);
    }
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
  window.addEventListener('popstate', schedule);
  window.addEventListener('beforeunload', event => {
    if ([...states.values()].some(s => s.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
