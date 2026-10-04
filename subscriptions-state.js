// Independent of YT Lists. Shared validation and the service worker's sole writer.
const SubscriptionsReviewState = (() => {
  const KEY = 'subscriptionsReviewV1';
  const TYPE = 'subscriptions-review';
  const MAX_RECORDS = 5000;
  const MAX_BYTES = 1500000;
  const MAX_HISTORY = 20;
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const cleanText = (value, limit) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const isSubscriptionsUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['www.youtube.com', 'youtube.com'].includes(url.hostname) &&
        !url.port && !url.username && !url.password && url.pathname.replace(/\/$/, '') === '/feed/subscriptions';
    } catch { return false; }
  };
  const videoId = (value) => {
    try {
      const url = new URL(value, 'https://www.youtube.com');
      if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
          url.port || url.username || url.password) return '';
      const id = url.pathname === '/watch' ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
      return ID.test(id || '') ? id : '';
    } catch { return ''; }
  };
  const sanitizeVideo = (raw) => {
    if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
    const id = raw.id;
    let thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    try {
      const url = new URL(raw.thumbnail);
      if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com' && !url.port &&
          !url.username && !url.password && new RegExp(`^/(vi|vi_webp)/${id}/[\\w-]+\\.(jpg|webp)$`).test(url.pathname)) {
        thumbnail = url.origin + url.pathname;
      }
    } catch { /* Use the canonical thumbnail. */ }
    return { id, url: `https://www.youtube.com/watch?v=${id}`, title: cleanText(raw.title, 300) || 'Untitled video',
      channel: cleanText(raw.channel, 120), duration: cleanText(raw.duration, 30), thumbnail };
  };
  const sanitizeEntry = (raw) => {
    const video = sanitizeVideo(raw?.video);
    if (!video) return null;
    const hiddenAt = Number.isSafeInteger(raw.hiddenAt) && raw.hiddenAt > 0 ? raw.hiddenAt : 0;
    const laterAt = !hiddenAt && Number.isSafeInteger(raw.laterAt) && raw.laterAt > 0 ? raw.laterAt : 0;
    return hiddenAt || laterAt ? { video, hiddenAt, laterAt } : null;
  };
  const sanitize = (raw) => {
    const state = { version: 1, revision: 0, entries: Object.create(null), history: [] };
    if (!raw || raw.version !== 1) return state;
    state.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    for (const [id, value] of Object.entries(raw.entries || {})) {
      const entry = sanitizeEntry(value);
      if (entry && entry.video.id === id) state.entries[id] = entry;
    }
    state.history = (Array.isArray(raw.history) ? raw.history : []).slice(-MAX_HISTORY).flatMap((item) => {
      if (!item || !ID.test(item.id || '') || typeof item.token !== 'string' || item.token.length > 100) return [];
      const before = sanitizeEntry(item.before);
      const after = sanitizeEntry(item.after);
      if (before && before.video.id !== item.id || after && after.video.id !== item.id) return [];
      return [{ id: item.id, token: item.token, before, after }];
    });
    return state;
  };
  const snapshot = (state) => ({ version: 1, revision: state.revision, entries: state.entries });
  const fail = (message) => { throw new Error(message); };
  const mutate = (state, message, now = Date.now(), token = '') => {
    const { action } = message;
    if (action === 'undo') {
      const item = state.history.find((item) => item.token === message.token);
      if (!item || JSON.stringify(state.entries[item.id] || null) !== JSON.stringify(item.after)) {
        fail('This decision changed or its undo expired. Your newer decisions were kept.');
      }
      if (item.before) state.entries[item.id] = item.before;
      else delete state.entries[item.id];
      state.history = state.history.filter((entry) => entry.id !== item.id);
    } else if (action === 'restoreAll' || action === 'clearLater') {
      for (const [id, entry] of Object.entries(state.entries)) {
        if (action === 'restoreAll' ? entry.hiddenAt : entry.laterAt) delete state.entries[id];
      }
      state.history = [];
    } else {
      if (!['hide', 'later', 'restore', 'remove'].includes(action)) fail('Unknown subscription action.');
      const video = sanitizeVideo(message.video);
      const id = video?.id || message.id;
      if (typeof id !== 'string' || !ID.test(id)) fail('Could not identify this video.');
      const before = state.entries[id] || null;
      let after = null;
      if (action === 'hide' || action === 'later') {
        if (!video) fail('Video details are missing.');
        after = { video, hiddenAt: action === 'hide' ? now : 0, laterAt: action === 'later' ? (before?.laterAt || now) : 0 };
      } else {
        // Restore and Remove each affect only their own collection.
        if (action === 'restore' && before?.laterAt || action === 'remove' && before?.hiddenAt) after = before;
      }
      if (after) state.entries[id] = after;
      else delete state.entries[id];
      state.history = state.history.filter((item) => item.id !== id);
      state.history.push({ id, before, after, token });
      state.history = state.history.slice(-MAX_HISTORY);
    }
    state.revision += 1;
    if (Object.keys(state.entries).length > MAX_RECORDS || new TextEncoder().encode(JSON.stringify(state)).length > MAX_BYTES) {
      fail('Subscription storage is full. Remove Later items or restore hidden videos to make space.');
    }
    return state;
  };
  const read = () => new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (result?.[KEY] && result[KEY].version !== 1) reject(new Error('This subscription data uses an unsupported version. Update the extension before changing it.'));
      else resolve(sanitize(result?.[KEY]));
    });
  });
  const write = (state) => new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: state }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  let queue = Promise.resolve();
  const handleMessage = (message, sender) => {
    if (message?.type !== TYPE || sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
        !isSubscriptionsUrl(sender.url) || sender.frameId !== 0) {
      return Promise.reject(new Error('Subscription tools are available on the desktop subscriptions page.'));
    }
    const operation = async () => {
      const state = await read();
      if (message.action === 'get') return { ok: true, state: snapshot(state) };
      const token = crypto.randomUUID();
      mutate(state, message, Date.now(), token);
      await write(state);
      return { ok: true, state: snapshot(state), undoToken: ['hide', 'later', 'restore', 'remove'].includes(message.action) ? token : null };
    };
    // Every message reads fresh persisted state. No delayed write or volatile-only cache.
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  return Object.freeze({ KEY, TYPE, MAX_RECORDS, MAX_BYTES, videoId, sanitizeVideo, sanitize, snapshot,
    isSubscriptionsUrl, mutate, handleMessage });
})();
