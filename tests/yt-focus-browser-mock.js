(() => {
  const data = {
    ytListsHideFeedVideos: true,
    ytListsFeedRevealDayEndMinutes: 120,
    ytListsFeedRevealUsage: { dayKey: '', count: 0 },
  };
  const changeListeners = [];

  const selectValues = (keys) => {
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

  const storageArea = {
    get(keys, callback) {
      queueMicrotask(() => callback(selectValues(keys)));
    },
    set(values, callback) {
      const changes = {};
      Object.entries(values || {}).forEach(([key, value]) => {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      });
      queueMicrotask(() => {
        callback?.();
        if (Object.keys(changes).length) {
          changeListeners.forEach((listener) => listener(changes, 'local'));
        }
      });
    },
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => new URL(path, location.href).toString(),
      sendMessage: async () => ({ ok: true }),
    },
    storage: {
      local: storageArea,
      sync: storageArea,
      onChanged: {
        addListener(listener) {
          changeListeners.push(listener);
        },
      },
    },
  };
})();
