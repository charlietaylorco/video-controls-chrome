(() => {
  const localData = {
    ytLists: [
      {
        id: 'design',
        name: 'Design',
        channels: [
          { id: 'UC_FIELD_NOTES', name: 'Field Notes', url: 'https://www.youtube.com/@fieldnotes' },
          { id: 'UC_STUDIO_PRACTICE', name: 'Studio Practice', url: 'https://www.youtube.com/@studiopractice' },
          { id: 'UC_PLAINLY_SPOKEN', name: 'Plainly Spoken', url: 'https://www.youtube.com/@plainlyspoken' },
        ],
      },
      {
        id: 'longform',
        name: 'Longform',
        channels: [
          { id: 'UC_PLAINLY_SPOKEN', name: 'Plainly Spoken', url: 'https://www.youtube.com/@plainlyspoken' },
        ],
      },
    ],
    ytListsSelectedId: 'design',
    ytListsOrder: ['all', 'reader-saved', 'downie-sent', 'design', 'longform'],
    ytListsHideShorts: true,
    ytListsHideArchived: true,
    ytListsHideFeedVideos: true,
    ytListsHideReaderSaved: false,
    ytListsHideDownieSent: false,
    ytListsTheme: 'light',
    readerToken: 'browser-test-token',
    readerSavedUrls: {},
    downieSentUrls: {},
  };
  const syncData = {};
  const changeListeners = [];

  const selectValues = (data, keys) => {
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(data, key)).map((key) => [key, data[key]]));
    }
    if (typeof keys === 'string') {
      return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: data[keys] } : {};
    }
    if (keys && typeof keys === 'object') {
      const result = { ...keys };
      Object.keys(keys).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
      });
      return result;
    }
    return { ...data };
  };

  const createStorageArea = (areaName, data) => ({
    get(keys, callback) {
      queueMicrotask(() => callback(selectValues(data, keys)));
    },
    set(values, callback) {
      const changes = {};
      Object.entries(values || {}).forEach(([key, value]) => {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      });
      queueMicrotask(() => {
        if (callback) callback();
        if (Object.keys(changes).length) {
          changeListeners.forEach((listener) => listener(changes, areaName));
        }
      });
    },
  });

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => new URL(path, location.href).toString(),
      openOptionsPage: () => Promise.resolve(),
      sendMessage(message, callback) {
        const response = message?.type === 'save-to-reader'
          ? { ok: true, url: message.pageUrl, alreadyExists: false }
          : message?.type === 'open-in-downie'
            ? { ok: true, url: message.pageUrl }
            : { ok: true };
        queueMicrotask(() => callback(response));
      },
    },
    storage: {
      local: createStorageArea('local', localData),
      sync: createStorageArea('sync', syncData),
      onChanged: {
        addListener(listener) {
          changeListeners.push(listener);
        },
      },
    },
  };

  const entries = {
    UC_FIELD_NOTES: [
      ['field-1', 'How a city learns to breathe', '2026-07-15T08:00:00Z'],
      ['field-2', 'Designing calmer public spaces', '2026-07-14T08:00:00Z'],
    ],
    UC_STUDIO_PRACTICE: [
      ['studio-1', 'Making better tools for thought', '2026-07-15T07:00:00Z'],
      ['studio-2', 'A practical typography critique', '2026-07-13T08:00:00Z'],
    ],
    UC_PLAINLY_SPOKEN: [
      ['plain-1', 'The strange economics of attention', '2026-07-15T06:00:00Z'],
      ['plain-2', 'Why deliberate media still matters', '2026-07-12T08:00:00Z'],
    ],
  };

  const buildFeed = (channelId) => {
    const items = entries[channelId] || [];
    const thumbnail = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%23e8e8e8'/%3E%3Ccircle cx='8' cy='4.5' r='1.4' fill='%23aaa'/%3E%3C/svg%3E";
    return `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
        ${items.map(([id, title, published]) => `
          <entry>
            <yt:videoId>${id}</yt:videoId>
            <title>${title}</title>
            <link rel="alternate" href="https://www.youtube.com/watch?v=${id}" />
            <published>${published}</published>
            <author><name>${channelId.replace('UC_', '').replaceAll('_', ' ')}</name></author>
            <media:group><media:thumbnail url="${thumbnail}" /></media:group>
          </entry>`).join('')}
      </feed>`;
  };

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/feeds/videos.xml')) {
      const channelId = new URL(url).searchParams.get('channel_id');
      return new Response(buildFeed(channelId), { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }
    if (url.includes('/api/v2/auth/')) {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/api/v3/save/')) {
      return new Response(JSON.stringify({ url: 'https://www.youtube.com/watch?v=mock' }), { status: 201 });
    }
    if (url.includes('/watch?')) {
      return new Response('<html><script>var x={"lengthSeconds":"1120"}</script></html>', { status: 200 });
    }
    return new Response('<html><meta itemprop="channelId" content="UC_BROWSER_TEST"></html>', { status: 200 });
  };
})();
