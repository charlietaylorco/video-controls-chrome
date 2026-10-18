/* Shared identity and draft rules. No Reader credentials or page HTML. */
(() => {
  const canonical = (value) => {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
      let id;
      if (['youtu.be', 'www.youtu.be'].includes(u.hostname)) id = u.pathname.match(/^\/([\w-]{1,100})\/?$/)?.[1];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname)) {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else id = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
      }
      return id && /^[\w-]{1,100}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    } catch { return null; }
  };
  const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  const readerUrl = (id) => validId(id) ? `https://read.readwise.io/read/${id}` : null;
  const cleanDocument = (doc, videoUrl) => {
    if (!doc || !validId(doc.id) || doc.is_deleted || doc.parent_id || canonical(doc.source_url) !== videoUrl) return null;
    const tags = Array.isArray(doc.tags) ? doc.tags : Object.entries(doc.tags || {}).map(([key, tag]) =>
      typeof tag?.name === 'string' ? tag.name : key);
    return { id: doc.id, videoUrl, url: readerUrl(doc.id), title: typeof doc.title === 'string' ? doc.title : '',
      summary: typeof doc.summary === 'string' ? doc.summary : '',
      notes: typeof doc.notes === 'string' ? doc.notes : '',
      tags: tags.filter(tag => typeof tag === 'string').slice(0, 100),
      updatedAt: typeof doc.updated_at === 'string' ? doc.updated_at : '' };
  };
  const draft = () => ({ doc: null, value: '', base: '', dirty: false, conflict: null, busy: false, request: 0 });
  const edit = (state, value) => { state.value = value; state.dirty = value !== state.base; };
  const receive = (state, doc) => {
    // A replacement document must never silently inherit a draft for a deleted one.
    if (state.dirty && (state.doc?.id !== doc.id || state.base !== doc.notes)) state.conflict = doc;
    else if (!state.dirty) { state.value = doc.notes; state.base = doc.notes; state.conflict = null; }
    state.doc = doc;
  };
  const saved = (state, sent) => {
    state.base = sent;
    state.doc = { ...state.doc, notes: sent };
    state.dirty = state.value !== sent;
    state.conflict = null;
  };
  const removed = (state, id) => {
    if (state.doc?.id !== id) return false;
    state.doc = null; state.conflict = null;
    // Keep dirty text, including edits made while deletion was in flight. A later
    // replacement document must go through receive()'s explicit conflict review.
    if (!state.dirty) state.value = state.base = '';
    return true;
  };
  const api = { canonical, validId, readerUrl, cleanDocument, draft, edit, receive, saved, removed };
  globalThis.MVSReaderCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
