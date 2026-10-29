/* Inline playback and website-owned text. No remote HTML is interpreted. */
(() => {
  const embedUrl = (value, origin) => {
    try {
      const url = new URL(value), site = new URL(origin);
      if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/watch' || url.username || url.password || url.port) return null;
      const id = url.searchParams.get('v');
      if (!id || !/^[\w-]{1,100}$/.test(id) || !['http:', 'https:'].includes(site.protocol)) return null;
      const embed = new URL(`https://www.youtube.com/embed/${encodeURIComponent(id)}`);
      embed.searchParams.set('autoplay', '1'); embed.searchParams.set('playsinline', '1'); embed.searchParams.set('rel', '0');
      return embed.href;
    } catch { return null; }
  };
  if (typeof module !== 'undefined') module.exports = { embedUrl };
  if (!globalThis.document) return;
  let active = null, sequence = 0;
  const drafts = new Map();
  const stopActive = () => active?.stop();
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopActive(); });
  window.addEventListener('pagehide', stopActive);
  window.addEventListener('beforeunload', event => { if (drafts.size) { event.preventDefault(); event.returnValue = ''; } });
  const node = (tag, text, parent, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; parent?.append(n); return n; };
  const attach = ({ mediaBox, copy, item, announce, reload }) => {
    let retainedDraft = drafts.get(item.videoUrl);
    let current = item, baseline = item, enabled = false, saving = false, destroyed = false, frame = null;
    let initialized = false, contentReady = false, loading = false, latestRevision = item.revision || 0;
    const play = node('button', '▶ Play here', mediaBox, 'cloud-play'); play.type = 'button';
    const close = node('button', 'Close player', mediaBox, 'cloud-stop'); close.type = 'button'; close.hidden = true;
    const handle = { stop() { frame?.remove(); frame = null; close.hidden = true; play.hidden = false; if (active === handle) active = null; } };
    play.addEventListener('click', () => {
      if (!enabled || destroyed) return;
      const url = embedUrl(current.videoUrl, location.origin); if (!url) return;
      stopActive();
      frame = document.createElement('iframe'); frame.className = 'cloud-player'; frame.src = url;
      frame.title = `YouTube player: ${current.title || 'saved video'}`;
      frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'; frame.allowFullscreen = true;
      mediaBox.append(frame); play.hidden = true; close.hidden = false; active = handle; close.focus({ preventScroll: true });
    });
    close.addEventListener('click', () => { handle.stop(); play.focus({ preventScroll: true }); });
    const details = node('details', '', copy, 'cloud-details'); node('summary', 'Description & personal note', details);
    const form = node('form', '', details, 'cloud-editor');
    const id = ++sequence;
    const field = (label, suffix, maxLength) => {
      const text = node('label', label, form), input = node('textarea', '', form); input.id = `cloud-${suffix}-${id}`; text.htmlFor = input.id; input.rows = 4; input.maxLength = maxLength; return input;
    };
    const description = field('Description', 'description', 64000);
    const note = field('Personal note · saved on this website', 'note', 64000);
    const status = node('p', '', form, 'cloud-editor-status'); status.setAttribute('role', 'status');
    const buttons = node('div', '', form, 'cloud-editor-actions');
    const save = node('button', 'Save text', buttons); save.type = 'submit';
    const reset = node('button', 'Reload saved text', buttons); reset.type = 'button';
    const retry = node('button', 'Retry loading text', buttons); retry.type = 'button'; retry.hidden = true;
    const text = value => typeof value === 'string' ? value : '';
    const dirty = () => initialized && (description.value !== text(baseline.description) || note.value !== text(baseline.notes));
    const controls = () => {
      const edited = dirty();
      if (initialized) {
        if (edited) drafts.set(item.videoUrl, { baseline, description: description.value, notes: note.value }); else drafts.delete(item.videoUrl);
      }
      save.disabled = !enabled || saving || loading || !contentReady || !edited;
      reset.disabled = saving || loading || !enabled || !contentReady;
      description.disabled = note.disabled = !enabled || !contentReady || loading;
      retry.hidden = contentReady || loading; retry.disabled = !enabled || saving;
    };
    const accept = next => { baseline = next; description.value = text(next.description); note.value = text(next.notes); status.textContent = ''; controls(); };
    const fullItem = next => next && next.videoUrl === item.videoUrl && next.contentPartial !== true && Number.isSafeInteger(next.revision) && typeof next.description === 'string' && typeof next.notes === 'string';
    const consume = next => {
      if (!fullItem(next) || next.revision < latestRevision) return false;
      const edited = dirty(); current = next; latestRevision = next.revision; contentReady = true;
      if (!initialized) {
        initialized = true; accept(next);
        if (retainedDraft) {
          baseline = retainedDraft.baseline; description.value = retainedDraft.description; note.value = retainedDraft.notes; retainedDraft = null;
          status.textContent = baseline.revision === next.revision ? 'Your unsaved edits are kept in this tab.' : 'Saved text changed elsewhere. Your edits are kept. Copy them before choosing Reload saved text.';
        }
      } else if (!edited && !saving) accept(next);
      else if (!saving && next.revision !== baseline.revision) status.textContent = 'Saved text changed elsewhere. Your edits are kept. Copy them before choosing Reload saved text.';
      controls(); return true;
    };
    const loadFull = async () => {
      if (loading || destroyed || saving) return;
      loading = true; status.textContent = 'Loading saved text…'; controls();
      let result;
      try { result = await MVSWatchTransport.send({ type: 'cloud-item', videoUrl: item.videoUrl }); }
      catch { result = { ok: false, code: 'network_error' }; }
      loading = false; if (destroyed) return;
      if (!result.ok || !consume(result.item)) {
        contentReady = false;
        status.textContent = result.ok ? 'Saved text changed while loading. Retry to get the current full text.' : MVSWatchTransport.messageFor(result) || 'Could not load the saved text. Your edits are kept. Retry before editing or saving.';
      }
      controls();
    };
    description.addEventListener('input', controls); note.addEventListener('input', controls);
    details.addEventListener('toggle', () => { if (details.open && !contentReady) void loadFull(); });
    retry.addEventListener('click', () => void loadFull());
    reset.addEventListener('click', () => { if (contentReady) accept(current); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!enabled || saving || loading || !contentReady || !initialized || destroyed || !dirty()) return;
      const captured = { description: description.value, notes: note.value };
      saving = true; status.textContent = 'Saving…'; controls();
      const result = await MVSWatchTransport.send({ type: 'cloud-edit', videoUrl: current.videoUrl, revision: baseline.revision, ...captured });
      saving = false; if (destroyed) return;
      if (result.ok && fullItem(result.item)) {
        const saved = result.item;
        current = baseline = saved; latestRevision = Math.max(latestRevision, saved.revision); contentReady = saved.revision >= latestRevision;
        status.textContent = dirty() ? 'Saved. Your newer edits are still unsaved.' : 'Saved to your cloud library.';
        announce('Description and personal note saved.'); reload();
      } else if (result.code === 'document_changed' || result.code === 'conflict') {
        if (fullItem(result.item)) { current = result.item; latestRevision = Math.max(latestRevision, current.revision); contentReady = current.revision >= latestRevision; }
        else contentReady = false;
        status.textContent = 'Saved text changed elsewhere. Your edits are kept. Copy them before choosing Reload saved text.';
      } else status.textContent = MVSWatchTransport.messageFor(result) || 'Could not confirm the save. Your edits are kept; reload saved text before retrying.';
      controls();
    });
    if (!consume(item)) { status.textContent = 'Open this section to load the full saved text.'; controls(); }
    return { update(next, usable) {
      enabled = usable;
      if (next.contentPartial === true) {
        // Never promote a list preview to an editable full-content baseline.
        if ((next.revision || 0) > latestRevision) {
          latestRevision = next.revision; contentReady = false;
          status.textContent = 'Saved text changed. Load the current full text before editing.';
        }
        current = { ...current, title: next.title };
        if (details.open && !contentReady) void loadFull();
      } else if ((next.revision || 0) >= latestRevision) consume(next);
      play.disabled = !enabled; play.setAttribute('aria-label', `Play ${current.title || 'video'} here`); controls();
    }, destroy() { destroyed = true; handle.stop(); details.remove(); play.remove(); close.remove(); } };
  };
  globalThis.MVSWatchExtras = { attach, stop: stopActive };
})();
