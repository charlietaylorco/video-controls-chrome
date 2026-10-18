/* Temporary, read-only launcher hover. Never changes the panel's tab or draft. */
(() => {
  const create = ({ toggle, root, beforePeek, getTarget, send, now = Date.now }) => {
    const cache = new Map();
    let session = null, intent, leave, box, text;
    const close = () => {
      clearTimeout(intent); clearTimeout(leave); session = null;
      if (box) box.hidden = true;
    };
    const valid = s => { const t = getTarget(); return session === s && t && t.url === s.url && t.visit === s.visit; };
    const keep = () => clearTimeout(leave);
    const depart = () => { clearTimeout(intent); clearTimeout(leave); leave = setTimeout(close, 180); };
    const mount = () => {
      if (box) return;
      box = document.createElement('section'); box.className = 'peek'; box.setAttribute('class', 'peek');
      box.setAttribute('aria-label', 'Reader summary preview'); box.setAttribute('role', 'note');
      const label = document.createElement('div'); label.textContent = 'Summary'; label.setAttribute('class', 'peek-label');
      text = document.createElement('div'); text.setAttribute('class', 'peek-summary');
      box.append(label, text); root.append(box);
      box.addEventListener('pointerenter', keep); box.addEventListener('pointerleave', depart);
    };
    const begin = () => {
      if (document.hidden) return;
      beforePeek();
      const target = getTarget(); if (!target) return;
      if (session && valid(session)) return;
      close(); const s = session = { url: target.url, visit: target.visit, id: target.doc?.id };
      intent = setTimeout(async () => {
        if (!valid(s)) { close(); return; }
        mount(); box.hidden = false; text.textContent = 'Loading Reader summary…';
        const current = getTarget(), existing = cache.get(s.url);
        let reply, at;
        if (current.doc && now() - current.fetchedAt < (current.doc.summary ? 60000 : 15000)) {
          reply = { ok: true, document: current.doc }; at = current.fetchedAt;
        } else if (existing?.expires > now()) { reply = existing.reply; at = existing.at; }
        else { reply = await send({ type: 'reader-panel-get', pageUrl: s.url, cursor: null, visit: s.visit }); at = now(); }
        if (!valid(s)) return;
        const doc = reply.ok && reply.document?.videoUrl === s.url && globalThis.MVSReaderCore.validId(reply.document.id) ? reply.document : null;
        text.textContent = doc?.summary || (reply.ok ? 'Summary not available yet. Open Reader to check processing or save status.'
          : reply.code === 'rate_limited' ? 'Reader rate limit reached. Try again later.' : 'Summary unavailable. Click the icon to open the panel for details.');
        cache.delete(s.url);
        if (reply.ok) cache.set(s.url, { reply: { ...reply, document: doc }, at, expires: at + (doc?.summary ? 60000 : 15000) });
        while (cache.size > 20) cache.delete(cache.keys().next().value);
      }, 300);
    };
    toggle.addEventListener('pointerenter', begin); toggle.addEventListener('pointerleave', depart);
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
    return { close, active: () => Boolean(session), invalidate(url) { if (url) cache.delete(url); else cache.clear(); if (!url || session?.url === url) close(); },
      documentsChanged(oldValue, newValue) {
        for (const [url, entry] of cache) if (oldValue[url]?.id !== newValue[url]?.id && entry.reply.document?.id !== newValue[url]?.id) cache.delete(url);
        // A lookup may publish its own newly discovered id before replying.
        // Only an actually removed/replaced identity cancels that preview.
        if (session && oldValue[session.url]?.id && oldValue[session.url].id !== newValue[session.url]?.id) close();
      },
      cachedDoc(url) { const entry = cache.get(url); return entry?.expires > now() && entry.reply.document ? { document: entry.reply.document, at: entry.at } : null; } };
  };
  globalThis.MVSReaderPeek = { create };
})();
