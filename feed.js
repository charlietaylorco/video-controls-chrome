const STORAGE_KEY = 'ytLists';
const SELECTED_KEY = 'ytListsSelectedId';
const HIDE_SHORTS_KEY = 'ytListsHideShorts';
const HIDE_ARCHIVED_KEY = 'ytListsHideArchived';
const HIDE_FEED_VIDEOS_KEY = 'ytListsHideFeedVideos';
const FEED_CACHE_KEY = 'ytListsFeedCache';
const DURATION_CACHE_KEY = 'ytListsDurationCache';
const ARCHIVE_KEY = 'ytListsArchived';
const LIST_ORDER_KEY = 'ytListsOrder';
const THEME_KEY = 'ytListsTheme';
const READWISE_API_KEY_KEY = 'readerToken';
const READER_SAVED_URLS_KEY = 'readerSavedUrls';
const DOWNIE_SENT_URLS_KEY = 'downieSentUrls';
const READWISE_SAVE_ENDPOINT = 'https://readwise.io/api/v3/save/';
const READWISE_AUTH_ENDPOINT = 'https://readwise.io/api/v2/auth/';
const SMART_READER_SAVED_ID = 'reader-saved';
const SYNC_KEYS = new Set([
  LIST_ORDER_KEY,
  SELECTED_KEY,
  HIDE_SHORTS_KEY,
  HIDE_ARCHIVED_KEY,
  HIDE_FEED_VIDEOS_KEY,
  THEME_KEY,
]);
const MAX_PER_CHANNEL = 20;
const MAX_CACHED_PER_CHANNEL = 200;
const INITIAL_COUNT = 50;
const BATCH_SIZE = 25;
const CACHE_PERSIST_DELAY = 800;

const state = {
  lists: [],
  selectedListId: 'all',
  items: [],
  visibleCount: INITIAL_COUNT,
  renderedCount: 0,
  isLoading: false,
  lastUpdated: null,
  hideShorts: true,
  hideArchived: true,
  hideFeedVideos: false,
  feedCache: {},
  archived: new Map(),
  readerSavedUrls: {},
  downieSentUrls: {},
  listOrder: [],
  theme: 'system',
  searchQuery: '',
  readwiseApiKey: '',
};

const resolvedIdCache = new Map();
const durationCache = new Map();
let durationPersistTimer = null;
let feedPersistTimer = null;
let archivePersistTimer = null;
let toastTimer = null;
let toastUndo = null;
let settingsPopover = null;
let settingsPopoverExport = null;
let settingsPopoverImport = null;
let settingsPopoverReader = null;
let settingsPopoverAnchor = null;
const settingsThemeButtons = new Map();
const readerButtonResetTimers = new WeakMap();
const durationQueue = [];
let durationActive = 0;
const DURATION_CONCURRENCY = 4;

function isLikelyChannelId(id) {
  return typeof id === 'string' && id.startsWith('UC');
}

function toAbsoluteUrl(url) {
  if (!url) return '';
  try {
    return new URL(url, 'https://www.youtube.com').toString();
  } catch (error) {
    return '';
  }
}

function buildChannelUrl(channel) {
  if (channel.url) {
    const absolute = toAbsoluteUrl(channel.url);
    if (absolute) return absolute;
  }
  if (!channel.id) return '';
  if (channel.id.startsWith('UC')) {
    return `https://www.youtube.com/channel/${channel.id}`;
  }
  if (channel.id.startsWith('@')) {
    return `https://www.youtube.com/${channel.id}`;
  }
  return `https://www.youtube.com/@${channel.id}`;
}

async function resolveChannelIdFromUrl(url) {
  if (!url) return null;
  if (resolvedIdCache.has(url)) return resolvedIdCache.get(url);
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      resolvedIdCache.set(url, null);
      return null;
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const id = doc.querySelector('meta[itemprop="channelId"]')?.content
      || doc.querySelector('[data-channel-external-id]')?.getAttribute('data-channel-external-id')
      || null;
    resolvedIdCache.set(url, id);
    return id;
  } catch (error) {
    resolvedIdCache.set(url, null);
    return null;
  }
}

async function normalizeStoredChannels() {
  let updated = false;
  for (const list of state.lists) {
    if (!list.channels) continue;
    for (const channel of list.channels) {
      if (!channel || !channel.id || isLikelyChannelId(channel.id)) continue;
      const url = buildChannelUrl(channel);
      const resolvedId = await resolveChannelIdFromUrl(url);
      if (resolvedId && resolvedId !== channel.id) {
        channel.id = resolvedId;
        if (!channel.url) {
          channel.url = url;
        }
        updated = true;
      }
    }
  }
  if (updated) {
    await setStorage(STORAGE_KEY, state.lists);
  }
}

const elements = {
  listItems: document.getElementById('list-items'),
  feedGrid: document.getElementById('feed-grid'),
  feedFooter: document.getElementById('feed-footer'),
  currentListName: document.getElementById('current-list-name'),
  currentListSubtitle: document.getElementById('current-list-subtitle'),
  emptyNote: document.getElementById('empty-note'),
  lastUpdated: document.getElementById('last-updated'),
  createList: document.getElementById('create-list'),
  manageList: document.getElementById('manage-list'),
  refreshFeed: document.getElementById('refresh-feed'),
  toggleFeedVideos: document.getElementById('toggle-feed-videos'),
  toggleShorts: document.getElementById('toggle-shorts'),
  toggleArchived: document.getElementById('toggle-archived'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalActions: document.getElementById('modal-actions'),
  modalClose: document.getElementById('modal-close'),
  archiveToast: document.getElementById('archive-toast'),
  archiveToastText: document.getElementById('archive-toast-text'),
  archiveUndo: document.getElementById('archive-undo'),
  importFile: document.getElementById('import-file'),
  listSearch: document.getElementById('list-search'),
  listSearchClear: document.getElementById('list-search-clear'),
  listSearchEmpty: document.getElementById('list-search-empty'),
};

function getStorage(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (localResult) => {
      if (Object.prototype.hasOwnProperty.call(localResult, key)) {
        resolve(localResult[key]);
        return;
      }

      if (!SYNC_KEYS.has(key)) {
        resolve(fallback);
        return;
      }

      chrome.storage.sync.get([key], (syncResult) => {
        if (Object.prototype.hasOwnProperty.call(syncResult, key)) {
          const value = syncResult[key];
          chrome.storage.local.set({ [key]: value }, () => resolve(value));
          return;
        }
        resolve(fallback);
      });
    });
  });
}

function setStorage(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (!SYNC_KEYS.has(key)) {
        resolve();
        return;
      }
      chrome.storage.sync.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Sync save failed:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  });
}

async function loadDurationCacheFromStorage() {
  const stored = await getStorage(DURATION_CACHE_KEY, {});
  if (!stored || typeof stored !== 'object') return;
  Object.entries(stored).forEach(([videoId, seconds]) => {
    const parsed = Number.parseInt(seconds, 10);
    if (Number.isFinite(parsed)) {
      durationCache.set(videoId, parsed);
    }
  });
}

function scheduleDurationCachePersist() {
  if (durationPersistTimer) {
    clearTimeout(durationPersistTimer);
  }
  durationPersistTimer = window.setTimeout(() => {
    durationPersistTimer = null;
    const payload = {};
    durationCache.forEach((seconds, videoId) => {
      if (Number.isFinite(seconds)) {
        payload[videoId] = seconds;
      }
    });
    setStorage(DURATION_CACHE_KEY, payload);
  }, CACHE_PERSIST_DELAY);
}

function sanitizeFeedCache(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

async function loadFeedCacheFromStorage() {
  state.feedCache = sanitizeFeedCache(await getStorage(FEED_CACHE_KEY, {}));
}

function scheduleFeedCachePersist() {
  if (feedPersistTimer) {
    clearTimeout(feedPersistTimer);
  }
  feedPersistTimer = window.setTimeout(() => {
    feedPersistTimer = null;
    setStorage(FEED_CACHE_KEY, state.feedCache);
  }, CACHE_PERSIST_DELAY);
}

async function loadArchivedFromStorage() {
  const stored = await getStorage(ARCHIVE_KEY, {});
  state.archived = new Map();
  if (!stored || typeof stored !== 'object') return;
  Object.entries(stored).forEach(([videoId, archivedAt]) => {
    if (videoId) {
      const timestamp = Number.parseInt(archivedAt, 10);
      state.archived.set(videoId, Number.isFinite(timestamp) ? timestamp : Date.now());
    }
  });
}

function scheduleArchivePersist() {
  if (archivePersistTimer) {
    clearTimeout(archivePersistTimer);
  }
  archivePersistTimer = window.setTimeout(() => {
    archivePersistTimer = null;
    const payload = {};
    state.archived.forEach((archivedAt, videoId) => {
      payload[videoId] = archivedAt;
    });
    setStorage(ARCHIVE_KEY, payload);
  }, CACHE_PERSIST_DELAY);
}

function createId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatRelativeTime(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function extractVideoIdFromLink(link) {
  if (!link) return '';
  try {
    const url = new URL(link, 'https://www.youtube.com');
    const id = url.searchParams.get('v');
    if (id) return id;
    const match = url.pathname.match(/\/shorts\/([^/?]+)/);
    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
}

function normalizeVideoUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, 'https://www.youtube.com');
    if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
      const videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
      return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : url.toString();
    }
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname) && url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      }
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

function getSavedUrlKeys(value) {
  const normalized = normalizeVideoUrl(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  try {
    const url = new URL(normalized);
    url.hash = '';
    keys.add(url.toString());
  } catch (error) {
    // Keep the normalized key.
  }
  return Array.from(keys);
}

function isUrlMarked(savedUrls, url) {
  if (!savedUrls || typeof savedUrls !== 'object') return false;
  return getSavedUrlKeys(url).some((key) => Boolean(savedUrls[key]));
}

function isItemSavedToReader(item) {
  return isUrlMarked(state.readerSavedUrls, item?.link);
}

function isItemSentToDownie(item) {
  return isUrlMarked(state.downieSentUrls, item?.link);
}

function markLocalUrlState(key, url) {
  if (!url) return;
  const savedAt = Date.now();
  const target = key === READER_SAVED_URLS_KEY ? state.readerSavedUrls : state.downieSentUrls;
  getSavedUrlKeys(url).forEach((entry) => {
    target[entry] = savedAt;
  });
  setStorage(key, target);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve({
        response,
        error: chrome.runtime.lastError?.message || null,
      });
    });
  });
}

function extractChannelHandle(url) {
  if (!url) return '';
  try {
    const pathname = new URL(url, 'https://www.youtube.com').pathname;
    const match = pathname.match(/\/@([^/]+)/);
    return match ? `@${match[1]}` : '';
  } catch (error) {
    return '';
  }
}

function serializeFeedItems(items) {
  return (items || []).map((item) => ({
    ...item,
    published: item.published instanceof Date ? item.published.toISOString() : item.published,
  }));
}

function hydrateFeedItems(items) {
  return (items || []).map((item) => ({
    ...item,
    published: new Date(item.published || 0),
  }));
}

function applyCachedDuration(item) {
  if (!item || item.durationSeconds) return item;
  if (!item.videoId || !durationCache.has(item.videoId)) return item;
  const cached = durationCache.get(item.videoId);
  if (Number.isFinite(cached)) {
    item.durationSeconds = cached;
  }
  return item;
}

function isItemArchived(item) {
  if (!item || !item.videoId) return false;
  return state.archived.has(item.videoId);
}

function setArchived(videoId, shouldArchive) {
  if (!videoId) return;
  if (shouldArchive) {
    state.archived.set(videoId, Date.now());
  } else {
    state.archived.delete(videoId);
  }
  scheduleArchivePersist();
}

function updateArchiveState(videoId, shouldArchive) {
  setArchived(videoId, shouldArchive);
  state.items.forEach((item) => {
    if (item.videoId === videoId) {
      item.isArchived = shouldArchive;
    }
  });
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
}

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastUndo = null;
  if (elements.archiveUndo) {
    elements.archiveUndo.hidden = true;
    elements.archiveUndo.textContent = 'Undo';
  }
  if (elements.archiveToast) {
    elements.archiveToast.classList.add('hidden');
  }
}

function showToast(message, { actionLabel = '', onAction = null, duration = 4000 } = {}) {
  if (!elements.archiveToast || !elements.archiveToastText) return;
  elements.archiveToastText.textContent = message;
  elements.archiveToast.classList.remove('hidden');
  toastUndo = typeof onAction === 'function' ? onAction : null;

  if (elements.archiveUndo) {
    const hasAction = !!(toastUndo && actionLabel);
    elements.archiveUndo.hidden = !hasAction;
    elements.archiveUndo.textContent = hasAction ? actionLabel : 'Undo';
  }

  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    hideToast();
  }, duration);
}

function showArchiveToast(message, onUndo) {
  showToast(message, { actionLabel: 'Undo', onAction: onUndo });
}

function archiveAllVisibleItems(list) {
  if (!list) return;
  const channelIds = new Set((list.channels || []).map((channel) => channel?.id).filter(Boolean));
  const items = (state.items || []).filter((item) => !channelIds.size || channelIds.has(item.channelId));
  const toArchive = items.filter((item) => item && item.videoId && !state.archived.has(item.videoId));
  if (!toArchive.length) {
    showArchiveToast('Everything here is already hidden.');
    return;
  }

  const confirmed = window.confirm(`Hide ${toArchive.length} video${toArchive.length === 1 ? '' : 's'} from "${list.name}"?`);
  if (!confirmed) return;

  const archivedIds = new Set();
  toArchive.forEach((item) => {
    archivedIds.add(item.videoId);
    setArchived(item.videoId, true);
    item.isArchived = true;
  });

  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();

  showArchiveToast(`Hidden ${toArchive.length} video${toArchive.length === 1 ? '' : 's'}.`, () => {
    archivedIds.forEach((videoId) => {
      setArchived(videoId, false);
    });
    state.items.forEach((item) => {
      if (archivedIds.has(item.videoId)) {
        item.isArchived = false;
      }
    });
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  });
}

function mergeChannelItems(channel, freshItems, cachedItems) {
  const map = new Map();

  const ingest = (item) => {
    if (!item) return;
    const videoId = item.videoId || extractVideoIdFromLink(item.link || '');
    if (!videoId) return;

    const published = item.published instanceof Date ? item.published : new Date(item.published || 0);
    const merged = {
      ...(map.get(videoId) || {}),
      ...item,
      videoId,
      published,
      channelId: channel.id,
      channelTitle: item.channelTitle || channel.name || 'Unknown channel',
      channelAvatar: item.channelAvatar || channel.avatarUrl || '',
    };

    applyCachedDuration(merged);
    map.set(videoId, merged);
  };

  (cachedItems || []).forEach(ingest);
  (freshItems || []).forEach(ingest);

  const mergedItems = Array.from(map.values());
  mergedItems.sort((a, b) => b.published.getTime() - a.published.getTime());
  return mergedItems.slice(0, MAX_CACHED_PER_CHANNEL);
}

function updateDurationBadge(element, seconds) {
  if (!element) return;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    element.style.display = 'none';
    element.textContent = '';
    return;
  }
  element.textContent = formatDuration(seconds);
  element.style.display = 'block';
}

async function fetchDurationFromWatch(videoId) {
  if (!videoId) return null;
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'include' });
    if (!response.ok) return null;
    const text = await response.text();
    const match = text.match(/\"lengthSeconds\":\"(\d+)\"/);
    if (match) return Number.parseInt(match[1], 10);
    const altMatch = text.match(/\"approxDurationMs\":\"(\d+)\"/);
    if (altMatch) return Math.round(Number.parseInt(altMatch[1], 10) / 1000);
    return null;
  } catch (error) {
    return null;
  }
}

function processDurationQueue() {
  while (durationActive < DURATION_CONCURRENCY && durationQueue.length > 0) {
    const { videoId, resolve } = durationQueue.shift();
    durationActive += 1;
    fetchDurationFromWatch(videoId)
      .then((seconds) => {
        durationCache.set(videoId, seconds);
        if (Number.isFinite(seconds)) {
          scheduleDurationCachePersist();
        }
        resolve(seconds);
      })
      .finally(() => {
        durationActive -= 1;
        processDurationQueue();
      });
  }
}

function ensureDuration(videoId) {
  if (!videoId) return Promise.resolve(null);
  if (durationCache.has(videoId)) {
    return Promise.resolve(durationCache.get(videoId));
  }
  return new Promise((resolve) => {
    durationQueue.push({ videoId, resolve });
    processDurationQueue();
  });
}

function updateHeader(channelCount, itemCount) {
  const list = state.selectedListId === SMART_READER_SAVED_ID
    ? { name: 'Saved to Reader' }
    : state.selectedListId === 'all'
    ? { name: 'All lists' }
    : state.lists.find((entry) => entry.id === state.selectedListId);

  elements.currentListName.textContent = list ? list.name : 'All lists';
  elements.currentListSubtitle.textContent = `${channelCount} channel${channelCount === 1 ? '' : 's'} - ${itemCount} video${itemCount === 1 ? '' : 's'}`;

  if (state.lastUpdated) {
    elements.lastUpdated.textContent = `Updated ${formatRelativeTime(state.lastUpdated)}`;
  } else {
    elements.lastUpdated.textContent = '';
  }
}

function setEmptyNote(message) {
  if (!elements.emptyNote) return;
  if (!message) {
    elements.emptyNote.textContent = '';
    elements.emptyNote.hidden = true;
    return;
  }
  elements.emptyNote.textContent = message;
  elements.emptyNote.hidden = false;
}

function hideFeedGrid() {
  elements.feedGrid.style.display = 'none';
}

function showFeedGrid() {
  elements.feedGrid.style.display = '';
}

function buildExportPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    lists: state.lists,
    listOrder: state.listOrder,
    settings: {
      selectedListId: state.selectedListId,
      hideShorts: state.hideShorts,
      hideArchived: state.hideArchived,
      hideFeedVideos: state.hideFeedVideos,
      theme: state.theme,
    },
    archived: Object.fromEntries(state.archived),
  };
}

function sanitizeImportedLists(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((list) => list && typeof list.id === 'string' && typeof list.name === 'string')
    .map((list) => ({
      id: list.id,
      name: list.name,
      channels: Array.isArray(list.channels) ? list.channels : [],
    }));
}

async function applyImport(payload) {
  state.lists = sanitizeImportedLists(payload.lists);
  state.listOrder = Array.isArray(payload.listOrder) ? payload.listOrder.filter(Boolean) : [];
  state.selectedListId = payload.settings?.selectedListId || 'all';
  state.hideShorts = payload.settings?.hideShorts ?? true;
  state.hideArchived = payload.settings?.hideArchived ?? true;
  state.hideFeedVideos = payload.settings?.hideFeedVideos ?? false;
  state.theme = normalizeTheme(payload.settings?.theme);

  state.archived = new Map();
  if (payload.archived && typeof payload.archived === 'object') {
    Object.entries(payload.archived).forEach(([videoId, archivedAt]) => {
      if (!videoId) return;
      const timestamp = Number.parseInt(archivedAt, 10);
      state.archived.set(videoId, Number.isFinite(timestamp) ? timestamp : Date.now());
    });
  }

  syncListOrder();
  if (state.selectedListId !== 'all' && state.selectedListId !== SMART_READER_SAVED_ID && !state.lists.find((entry) => entry.id === state.selectedListId)) {
    state.selectedListId = 'all';
  }

  await setStorage(STORAGE_KEY, state.lists);
  await setStorage(LIST_ORDER_KEY, state.listOrder);
  await setStorage(SELECTED_KEY, state.selectedListId);
  await setStorage(HIDE_SHORTS_KEY, state.hideShorts);
  await setStorage(HIDE_ARCHIVED_KEY, state.hideArchived);
  await setStorage(HIDE_FEED_VIDEOS_KEY, state.hideFeedVideos);
  await setStorage(THEME_KEY, state.theme);
  await setStorage(ARCHIVE_KEY, Object.fromEntries(state.archived));

  renderLists();
  updateShortsToggle();
  updateArchivedToggle();
  updateFeedVideosToggle();
  applyTheme(state.theme);
  updateThemeButtons();
  await loadFeed();
}

function normalizeTheme(value) {
  if (value === 'dark' || value === 'light' || value === 'system') {
    return value;
  }
  return 'system';
}

function applyTheme(theme = state.theme) {
  const normalized = normalizeTheme(theme);
  state.theme = normalized;
  if (normalized === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', normalized);
  }
}

async function setTheme(theme) {
  state.theme = normalizeTheme(theme);
  applyTheme(state.theme);
  updateThemeButtons();
  await setStorage(THEME_KEY, state.theme);
}

function updateThemeButtons() {
  if (!settingsThemeButtons.size) return;
  settingsThemeButtons.forEach((button, theme) => {
    const active = state.theme === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function getReadwiseApiKey() {
  return (state.readwiseApiKey || '').trim();
}

function hasReadwiseApiKey() {
  return !!getReadwiseApiKey();
}

function updateReaderSettingsButton() {
  if (!settingsPopoverReader) return;
  settingsPopoverReader.textContent = hasReadwiseApiKey() ? 'Reader connected' : 'Set up Reader';
}

async function validateReadwiseApiKey(apiKey) {
  try {
    const response = await fetch(READWISE_AUTH_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    if (response.status === 204) {
      return { ok: true };
    }

    if (response.status === 401) {
      return { ok: false, message: 'Readwise rejected that API key.' };
    }

    return { ok: false, message: `Readwise validation failed (${response.status}).` };
  } catch (error) {
    return { ok: false, message: 'Could not reach Readwise to validate the API key.' };
  }
}

function openReadwiseSettingsModal() {
  let input;
  let status;
  let saveButton;
  let clearButton;

  const setStatus = (message, tone = 'muted') => {
    if (!status) return;
    status.textContent = message;
    status.className = `status-message${tone === 'success' ? ' success' : tone === 'error' ? ' error' : ''}`;
  };

  openModal({
    title: 'Reader settings',
    bodyBuilder: () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'reader-settings-panel';

      const intro = document.createElement('p');
      intro.className = 'modal-note';
      intro.textContent = 'Save videos directly to Reader from each card. The API key stays in this browser profile.';

      const connection = document.createElement('div');
      connection.className = 'settings-status';

      const chip = document.createElement('span');
      chip.className = `status-chip${hasReadwiseApiKey() ? ' connected' : ''}`;
      chip.textContent = hasReadwiseApiKey() ? 'Connected' : 'Not connected';

      const summary = document.createElement('span');
      summary.textContent = hasReadwiseApiKey()
        ? 'A Readwise API key is already saved.'
        : 'Add your Readwise API key to enable Save to Reader.';

      connection.append(chip, summary);

      const label = document.createElement('label');
      label.textContent = 'Readwise API key';
      label.className = 'section-title';

      input = document.createElement('input');
      input.className = 'input';
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'Paste API key';
      input.value = getReadwiseApiKey();
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (saveButton) {
            saveButton.click();
          }
        }
      });

      const hint = document.createElement('p');
      hint.className = 'modal-note';
      hint.innerHTML = 'Find your key in <a class="text-link" href="https://readwise.io/access_token" target="_blank" rel="noreferrer">Readwise access tokens</a>.';

      status = document.createElement('div');
      setStatus(hasReadwiseApiKey() ? 'Key saved. Save will validate any replacement before updating it.' : 'Paste a key, then click Save.');

      wrapper.append(intro, connection, label, input, hint, status);

      window.setTimeout(() => {
        input.focus();
        if (input.value) {
          input.select();
        }
      }, 0);

      return wrapper;
    },
    actionsBuilder: () => {
      const actions = document.createElement('div');

      const cancel = document.createElement('button');
      cancel.className = 'ghost';
      cancel.textContent = 'Close';
      cancel.type = 'button';
      cancel.addEventListener('click', closeModal);

      clearButton = document.createElement('button');
      clearButton.className = 'ghost';
      clearButton.textContent = 'Clear key';
      clearButton.type = 'button';
      clearButton.disabled = !hasReadwiseApiKey();
      clearButton.addEventListener('click', async () => {
        state.readwiseApiKey = '';
        await setStorage(READWISE_API_KEY_KEY, '');
        updateReaderSettingsButton();
        closeModal();
        showToast('Readwise API key removed.');
      });

      saveButton = document.createElement('button');
      saveButton.className = 'primary';
      saveButton.textContent = 'Save';
      saveButton.type = 'button';
      saveButton.addEventListener('click', async () => {
        const nextKey = (input?.value || '').trim();
        if (!nextKey) {
          setStatus('Paste an API key or clear the saved one.', 'error');
          return;
        }

        saveButton.disabled = true;
        clearButton.disabled = true;
        setStatus('Validating with Readwise...');

        const validation = await validateReadwiseApiKey(nextKey);
        saveButton.disabled = false;
        clearButton.disabled = !hasReadwiseApiKey();

        if (!validation.ok) {
          setStatus(validation.message, 'error');
          return;
        }

        state.readwiseApiKey = nextKey;
        await setStorage(READWISE_API_KEY_KEY, nextKey);
        updateReaderSettingsButton();
        closeModal();
        showToast('Readwise is connected.');
      });

      actions.append(cancel, clearButton, saveButton);
      return actions;
    },
  });
}

function triggerExport() {
  const payload = buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `yt-lists-backup-${date}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function triggerImportSelect() {
  if (!elements.importFile) return;
  elements.importFile.value = '';
  elements.importFile.click();
}

async function handleImportFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    window.alert('Invalid JSON file.');
    return;
  }

  if (!payload || !Array.isArray(payload.lists)) {
    window.alert('Invalid backup file.');
    return;
  }

  const confirmed = window.confirm('Import will replace your current lists and settings. Continue?');
  if (!confirmed) return;

  await applyImport(payload);
}

function ensureSettingsPopover() {
  if (settingsPopover) return;

  const popover = document.createElement('div');
  popover.className = 'settings-popover hidden';
  popover.id = 'settings-popover';
  popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', 'List tools');

  const title = document.createElement('div');
  title.className = 'settings-popover-title';
  title.textContent = 'List tools';

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'settings-popover-item';
  helpBtn.textContent = 'How it works';
  helpBtn.setAttribute('role', 'menuitem');
  helpBtn.addEventListener('click', () => {
    openHelpModal();
    closeSettingsPopover();
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'settings-popover-item';
  exportBtn.textContent = 'Export lists';
  exportBtn.setAttribute('role', 'menuitem');
  exportBtn.addEventListener('click', () => {
    triggerExport();
    closeSettingsPopover();
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'settings-popover-item';
  importBtn.textContent = 'Import lists';
  importBtn.setAttribute('role', 'menuitem');
  importBtn.addEventListener('click', () => {
    triggerImportSelect();
    closeSettingsPopover();
  });

  const readerTitle = document.createElement('div');
  readerTitle.className = 'settings-popover-title';
  readerTitle.textContent = 'Reader';

  const readerBtn = document.createElement('button');
  readerBtn.type = 'button';
  readerBtn.className = 'settings-popover-item';
  readerBtn.setAttribute('role', 'menuitem');
  readerBtn.addEventListener('click', () => {
    openReadwiseSettingsModal();
    closeSettingsPopover();
  });

  const appearanceTitle = document.createElement('div');
  appearanceTitle.className = 'settings-popover-title';
  appearanceTitle.textContent = 'Appearance';

  const themeGroup = document.createElement('div');
  themeGroup.className = 'settings-popover-group';
  themeGroup.setAttribute('role', 'group');

  const themes = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  themes.forEach(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-theme-option';
    button.dataset.theme = id;
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      setTheme(id);
    });
    themeGroup.appendChild(button);
    settingsThemeButtons.set(id, button);
  });

  popover.append(title, helpBtn, exportBtn, importBtn, readerTitle, readerBtn, appearanceTitle, themeGroup);
  popover.addEventListener('click', (event) => event.stopPropagation());

  document.body.appendChild(popover);
  settingsPopover = popover;
  settingsPopoverExport = exportBtn;
  settingsPopoverImport = importBtn;
  settingsPopoverReader = readerBtn;
  updateReaderSettingsButton();
  updateThemeButtons();
}

function positionSettingsPopover(anchor) {
  if (!settingsPopover || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const popoverRect = settingsPopover.getBoundingClientRect();
  const padding = 12;
  const gap = 8;
  let left = rect.right - popoverRect.width;
  let top = rect.bottom + gap;

  if (left < padding) left = padding;
  if (left + popoverRect.width > window.innerWidth - padding) {
    left = window.innerWidth - padding - popoverRect.width;
  }

  if (top + popoverRect.height > window.innerHeight - padding) {
    top = rect.top - popoverRect.height - gap;
  }

  if (top < padding) top = padding;

  settingsPopover.style.left = `${left + window.scrollX}px`;
  settingsPopover.style.top = `${top + window.scrollY}px`;
}

function openSettingsPopover(anchor) {
  if (!anchor) return;
  ensureSettingsPopover();
  settingsPopoverAnchor = anchor;
  settingsPopover.classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true');
  updateThemeButtons();
  positionSettingsPopover(anchor);
}

function closeSettingsPopover() {
  if (!settingsPopover || settingsPopover.classList.contains('hidden')) return;
  settingsPopover.classList.add('hidden');
  if (settingsPopoverAnchor) {
    settingsPopoverAnchor.setAttribute('aria-expanded', 'false');
  }
  settingsPopoverAnchor = null;
}

function toggleSettingsPopover(anchor) {
  if (settingsPopoverAnchor === anchor && settingsPopover && !settingsPopover.classList.contains('hidden')) {
    closeSettingsPopover();
    return;
  }
  openSettingsPopover(anchor);
}

function getFilteredItems() {
  const query = state.searchQuery.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.selectedListId === SMART_READER_SAVED_ID && !isItemSavedToReader(item)) return false;
    if (state.hideShorts && item.isShort) return false;
    if (state.hideArchived && isItemArchived(item)) return false;
    if (query) {
      const title = (item.title || '').toLowerCase();
      const channel = (item.channelTitle || '').toLowerCase();
      if (!title.includes(query) && !channel.includes(query)) {
        return false;
      }
    }
    return true;
  });
}

function countSavedReaderItems() {
  return (state.items || []).filter((item) => isItemSavedToReader(item)).length;
}

function listMatchesQuery(list, query) {
  if (!query) return true;
  const normalized = query.toLowerCase();
  if ((list.name || '').toLowerCase().includes(normalized)) return true;
  const channels = list.channels || [];
  return channels.some((channel) => {
    if (!channel) return false;
    const name = (channel.name || channel.title || '').toLowerCase();
    const handle = (channel.handle || channel.id || '').toLowerCase();
    return name.includes(normalized) || handle.includes(normalized);
  });
}

function updateSearchUi() {
  if (!elements.listSearchClear) return;
  const hasQuery = state.searchQuery.trim().length > 0;
  elements.listSearchClear.hidden = !hasQuery;
}

function updateListSearchEmpty(hasMatches) {
  if (!elements.listSearchEmpty) return;
  const hasQuery = state.searchQuery.trim().length > 0;
  elements.listSearchEmpty.hidden = !hasQuery || hasMatches;
}

function updateShortsToggle() {
  if (!elements.toggleShorts) return;
  elements.toggleShorts.textContent = state.hideShorts ? 'Show Shorts' : 'Hide Shorts';
}

function updateArchivedToggle() {
  if (!elements.toggleArchived) return;
  elements.toggleArchived.textContent = state.hideArchived ? 'Show Hidden' : 'Hide Hidden';
}

function updateFeedVideosToggle() {
  if (!elements.toggleFeedVideos) return;
  const enabled = !!state.hideFeedVideos;
  elements.toggleFeedVideos.textContent = enabled ? 'Focus mode: on' : 'Focus mode: off';
  elements.toggleFeedVideos.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

function uniqueChannelsFromLists(lists) {
  const map = new Map();
  lists.forEach((list) => {
    (list.channels || []).forEach((channel) => {
      if (channel && channel.id && !map.has(channel.id)) {
        map.set(channel.id, channel);
      }
    });
  });
  return Array.from(map.values());
}

function getChannelsForSelection() {
  if (state.selectedListId === 'all' || state.selectedListId === SMART_READER_SAVED_ID) {
    return uniqueChannelsFromLists(state.lists);
  }
  const list = state.lists.find((entry) => entry.id === state.selectedListId);
  return list ? list.channels || [] : [];
}

function syncListOrder() {
  const knownIds = new Set(state.lists.map((list) => list.id));
  const prevOrder = [...state.listOrder];
  const nextOrder = [];

  state.listOrder.forEach((id) => {
    if (id === 'all' || knownIds.has(id)) {
      nextOrder.push(id);
      knownIds.delete(id);
    }
  });

  if (knownIds.size) {
    const remaining = Array.from(knownIds);
    const allIndex = nextOrder.indexOf('all');
    if (allIndex >= 0) {
      nextOrder.splice(allIndex, 0, ...remaining);
    } else {
      nextOrder.push(...remaining);
    }
  }

  if (!nextOrder.includes('all')) {
    nextOrder.push('all');
  }

  state.listOrder = nextOrder;

  if (JSON.stringify(prevOrder) !== JSON.stringify(nextOrder)) {
    setStorage(LIST_ORDER_KEY, state.listOrder);
  }
}

function insertListOrder(id) {
  if (!id || state.listOrder.includes(id)) return;
  const allIndex = state.listOrder.indexOf('all');
  if (allIndex >= 0) {
    state.listOrder.splice(allIndex, 0, id);
  } else {
    state.listOrder.push(id);
  }
  setStorage(LIST_ORDER_KEY, state.listOrder);
}

function removeListOrder(id) {
  if (!id) return;
  state.listOrder = state.listOrder.filter((entry) => entry !== id);
  setStorage(LIST_ORDER_KEY, state.listOrder);
}

function renderLists() {
  closeSettingsPopover();
  elements.listItems.innerHTML = '';

  const listMap = new Map(state.lists.map((list) => [list.id, list]));
  const ordered = [];
  const query = state.searchQuery.trim();
  const normalizedQuery = query.toLowerCase();
  const matchesAnyList = query
    ? state.lists.some((list) => listMatchesQuery(list, query))
    : true;

  if (!query || 'saved to reader'.includes(normalizedQuery) || 'reader'.includes(normalizedQuery)) {
    ordered.push({ id: SMART_READER_SAVED_ID, name: 'Saved to Reader', count: countSavedReaderItems() });
  }

  state.listOrder.forEach((id) => {
    if (id === 'all') {
      if (matchesAnyList || query.toLowerCase().includes('all')) {
        ordered.push({ id: 'all', name: 'All lists', count: uniqueChannelsFromLists(state.lists).length });
      }
      return;
    }
    const list = listMap.get(id);
    if (list && listMatchesQuery(list, query)) {
      ordered.push({ id: list.id, name: list.name, count: (list.channels || []).length });
      listMap.delete(id);
    }
  });

  if (listMap.size) {
    Array.from(listMap.values()).forEach((list) => {
      if (listMatchesQuery(list, query)) {
        ordered.push({ id: list.id, name: list.name, count: (list.channels || []).length });
      }
    });
  }

  if (!state.listOrder.includes('all') && (matchesAnyList || query.toLowerCase().includes('all'))) {
    ordered.push({ id: 'all', name: 'All lists', count: uniqueChannelsFromLists(state.lists).length });
  }

  ordered.forEach((entry) => {
    const button = buildListButton(entry);
    elements.listItems.appendChild(button);
  });

  updateListSearchEmpty(ordered.length > 0);
}

function buildListButton({ id, name, count }) {
  const button = document.createElement('div');
  button.className = `list-item${state.selectedListId === id ? ' active' : ''}`;
  button.dataset.listId = id;
  button.draggable = id !== SMART_READER_SAVED_ID;
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-pressed', state.selectedListId === id ? 'true' : 'false');

  const handle = document.createElement('span');
  handle.className = 'list-drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  button.appendChild(handle);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'list-name';
  nameSpan.textContent = name;
  button.append(nameSpan);

  button.addEventListener('click', () => {
    if (state.selectedListId !== id) {
      selectList(id);
    }
  });

  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (state.selectedListId !== id) {
        selectList(id);
      }
    }
  });

  if (id !== 'all' && id !== SMART_READER_SAVED_ID) {
    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'list-rename';
    renameButton.setAttribute('aria-label', 'Rename list');
    renameButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 17.25V21h3.75l11-11-3.75-3.75-11 11Zm14.71-9.04a1 1 0 0 0 0-1.41L15.2 4.29a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.99-1.66Z"></path>
      </svg>
    `;
    renameButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRenameListModal(id);
    });
    renameButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    renameButton.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.append(renameButton);
  }

  if (id === 'all') {
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'list-settings';
    settingsButton.setAttribute('aria-label', 'List tools');
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsButton.setAttribute('aria-controls', 'settings-popover');
    settingsButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.95l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.06 7.06 0 0 0-1.64-.95l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.64.95l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.07.63-.07.95s.02.64.07.94L2.82 14.53a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.41 1.06.73 1.64.95l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.22 1.14-.54 1.64-.95l2.39.96c.24.1.51.01.64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.59ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"></path>
      </svg>
    `;
    settingsButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSettingsPopover(settingsButton);
    });
    settingsButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    settingsButton.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.append(settingsButton);
  }

  return button;
}

function setupListDrag() {
  if (!elements.listItems || elements.listItems.dataset.dragReady === 'true') return;
  elements.listItems.dataset.dragReady = 'true';

  let draggedId = null;

  const getAxis = () => {
    const style = getComputedStyle(elements.listItems);
    return style.flexDirection === 'row' ? 'x' : 'y';
  };

  const getListItem = (target) => {
    const item = target?.closest?.('.list-item');
    if (!item) return null;
    return item;
  };

  elements.listItems.addEventListener('dragstart', (event) => {
    const item = getListItem(event.target);
    if (!item) return;
    draggedId = item.dataset.listId;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedId);
  });

  elements.listItems.addEventListener('dragend', (event) => {
    const item = event.target?.closest?.('.list-item');
    if (item) item.classList.remove('dragging');
    draggedId = null;
  });

  elements.listItems.addEventListener('dragover', (event) => {
    event.preventDefault();
    const draggingEl = elements.listItems.querySelector('.list-item.dragging');
    if (!draggingEl) return;

    const target = getListItem(event.target);
    if (!target || target === draggingEl) return;

    const rect = target.getBoundingClientRect();
    const axis = getAxis();
    const shouldInsertAfter = axis === 'x'
      ? event.clientX > rect.left + rect.width / 2
      : event.clientY > rect.top + rect.height / 2;

    const reference = shouldInsertAfter ? target.nextSibling : target;
    if (reference !== draggingEl) {
      elements.listItems.insertBefore(draggingEl, reference);
    }
  });

  elements.listItems.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (!draggedId) return;

    const orderedIds = Array.from(elements.listItems.querySelectorAll('.list-item'))
      .map((item) => item.dataset.listId)
      .filter((id) => id);

    state.listOrder = orderedIds;

    const map = new Map(state.lists.map((list) => [list.id, list]));
    state.lists = orderedIds
      .filter((id) => id !== 'all')
      .map((id) => map.get(id))
      .filter(Boolean);

    await setStorage(STORAGE_KEY, state.lists);
    await setStorage(LIST_ORDER_KEY, state.listOrder);
    renderLists();
  });
}

async function selectList(id) {
  state.selectedListId = id;
  await setStorage(SELECTED_KEY, id);
  renderLists();
  await loadFeed({ clearBefore: false });
}

async function fetchChannelFeed(channel) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load feed for ${channel.id}`);
  }

  const xmlText = await response.text();
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const entries = Array.from(doc.querySelectorAll('entry')).slice(0, MAX_PER_CHANNEL);

  const getEntryText = (entry, selector, tagName) => {
    const el = selector ? entry.querySelector(selector) : null;
    if (el?.textContent) return el.textContent;
    if (tagName) {
      const tag = entry.getElementsByTagName(tagName)[0];
      if (tag?.textContent) return tag.textContent;
    }
    return '';
  };

  const getEntryAttribute = (entry, selector, tagName, attribute) => {
    const el = selector ? entry.querySelector(selector) : null;
    if (el?.getAttribute(attribute)) return el.getAttribute(attribute);
    if (tagName) {
      const tag = entry.getElementsByTagName(tagName)[0];
      if (tag?.getAttribute(attribute)) return tag.getAttribute(attribute);
    }
    return '';
  };

  const items = entries.map((entry) => {
    let videoId = getEntryText(entry, 'yt\\:videoId', 'yt:videoId');
    const title = getEntryText(entry, 'title', 'title').trim() || 'Untitled video';
    const link = getEntryAttribute(entry, 'link', 'link', 'href')
      || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    if (!videoId) {
      videoId = extractVideoIdFromLink(link);
    }
    const publishedText = getEntryText(entry, 'published', 'published');
    const thumbnail = getEntryAttribute(entry, 'media\\:thumbnail', 'media:thumbnail', 'url')
      || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
    const durationRaw = getEntryAttribute(entry, 'yt\\:duration', 'yt:duration', 'seconds');
    const durationTag = entry.getElementsByTagNameNS('*', 'duration')[0];
    const durationFallback = durationTag?.getAttribute('seconds')
      || getEntryAttribute(entry, 'media\\:content', 'media:content', 'duration');
    const durationSeconds = durationRaw || durationFallback
      ? Number.parseInt(durationRaw || durationFallback, 10)
      : null;
    if (Number.isFinite(durationSeconds) && videoId) {
      durationCache.set(videoId, durationSeconds);
      scheduleDurationCachePersist();
    }
    const cachedDuration = !Number.isFinite(durationSeconds) && videoId && durationCache.has(videoId)
      ? durationCache.get(videoId)
      : durationSeconds;
    const normalizedDuration = Number.isFinite(cachedDuration) ? cachedDuration : null;
    const isShort = link.includes('/shorts/')
      || (Number.isFinite(normalizedDuration) && normalizedDuration <= 60);
    const channelTitle = getEntryText(entry, 'author > name', 'name').trim() || channel.name || 'Unknown channel';

    return {
      videoId,
      title,
      link,
      published: publishedText ? new Date(publishedText) : new Date(0),
      thumbnail,
      channelId: channel.id,
      channelTitle,
      channelAvatar: channel.avatarUrl || '',
      durationSeconds: normalizedDuration,
      isShort,
    };
  });

  return items;
}

async function loadFeed(options = {}) {
  const { clearBefore = true } = options;
  state.isLoading = true;
  state.renderedCount = 0;
  state.visibleCount = INITIAL_COUNT;
  if (clearBefore) {
    elements.feedGrid.innerHTML = '';
    hideFeedGrid();
    setEmptyNote('Loading latest videos...');
    elements.feedFooter.style.display = 'none';
    elements.feedFooter.textContent = '';
  } else {
    elements.feedFooter.style.display = '';
    elements.feedFooter.textContent = 'Loading latest videos...';
  }

  state.lists = (await getStorage(STORAGE_KEY, [])) || [];
  if (state.selectedListId !== 'all' && state.selectedListId !== SMART_READER_SAVED_ID && !state.lists.find((entry) => entry.id === state.selectedListId)) {
    state.selectedListId = 'all';
    await setStorage(SELECTED_KEY, 'all');
  }

  await normalizeStoredChannels();
  const channels = getChannelsForSelection();
  elements.manageList.disabled = state.selectedListId === 'all' || state.selectedListId === SMART_READER_SAVED_ID;
  updateHeader(channels.length, 0);

  if (!channels.length) {
    state.items = [];
    hideFeedGrid();
    elements.feedGrid.innerHTML = '';
    setEmptyNote('Add channels to a list to see their latest uploads.');
    elements.feedFooter.style.display = 'none';
    elements.feedFooter.textContent = '';
    state.isLoading = false;
    return;
  }

  const results = await Promise.all(channels.map(async (channel) => {
    const cached = state.feedCache[channel.id]?.items
      ? hydrateFeedItems(state.feedCache[channel.id].items)
      : [];
    try {
      const freshItems = await fetchChannelFeed(channel);
      const merged = mergeChannelItems(channel, freshItems, cached);
      state.feedCache[channel.id] = {
        items: serializeFeedItems(merged),
        updatedAt: Date.now(),
      };
      return merged;
    } catch (error) {
      const merged = mergeChannelItems(channel, [], cached);
      state.feedCache[channel.id] = {
        items: serializeFeedItems(merged),
        updatedAt: Date.now(),
      };
      return merged;
    }
  }));

  const items = results.flat();
  items.sort((a, b) => b.published.getTime() - a.published.getTime());

  items.forEach((item) => {
    item.isArchived = isItemArchived(item);
    item.isSavedToReader = isItemSavedToReader(item);
    item.isSentToDownie = isItemSentToDownie(item);
  });

  state.items = items;
  state.lastUpdated = new Date();
  scheduleFeedCachePersist();
  renderLists();
  updateHeader(channels.length, getFilteredItems().length);
  setEmptyNote('');
  showFeedGrid();
  renderFeed();
  state.isLoading = false;
}

function renderFeed({ append = false } = {}) {
  if (!append) {
    elements.feedGrid.innerHTML = '';
    state.renderedCount = 0;
  }

  const items = getFilteredItems();
  const nextItems = items.slice(state.renderedCount, state.visibleCount);
  if (!nextItems.length && !items.length) {
    elements.feedGrid.innerHTML = '';
    hideFeedGrid();
    if (state.searchQuery.trim()) {
      setEmptyNote('No videos match your search.');
    } else {
      setEmptyNote('No videos found yet. Try refreshing in a bit.');
    }
    elements.feedFooter.style.display = 'none';
    elements.feedFooter.textContent = '';
    return;
  }

  nextItems.forEach((item) => {
    elements.feedGrid.appendChild(buildVideoCard(item));
  });
  showFeedGrid();

  state.renderedCount += nextItems.length;

  if (state.renderedCount < items.length) {
    elements.feedFooter.style.display = '';
    elements.feedFooter.textContent = `Showing ${state.renderedCount} of ${items.length} videos`; 
  } else if (items.length) {
    elements.feedFooter.style.display = '';
    elements.feedFooter.textContent = 'You are all caught up.';
  } else {
    elements.feedFooter.style.display = 'none';
    elements.feedFooter.textContent = '';
  }
}

function getReaderButtonLabel(stateName) {
  switch (stateName) {
    case 'saving':
      return 'Saving...';
    case 'saved':
      return 'Saved';
    case 'exists':
      return 'Already saved';
    case 'needs-key':
      return 'Set API key';
    case 'invalid-key':
      return 'Invalid key';
    case 'error':
      return 'Try again';
    default:
      return 'Save to Reader';
  }
}

function setReaderButtonState(button, stateName = 'idle') {
  if (!button) return;
  const timer = readerButtonResetTimers.get(button);
  if (timer) {
    clearTimeout(timer);
    readerButtonResetTimers.delete(button);
  }
  button.dataset.state = stateName;
  const label = getReaderButtonLabel(stateName);
  if (button.classList.contains('thumb-icon-action')) {
    button.title = label;
    button.setAttribute('aria-label', label);
  } else {
    button.textContent = label;
  }
  button.disabled = stateName === 'saving';
}

function scheduleReaderButtonReset(button) {
  if (!button) return;
  const timer = window.setTimeout(() => {
    setReaderButtonState(button, 'idle');
  }, 2200);
  readerButtonResetTimers.set(button, timer);
}

async function parseReadwiseError(response) {
  const fallback = `Readwise returned ${response.status}.`;
  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.detail === 'string' && parsed.detail) return parsed.detail;
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    } catch (error) {
      // Fall through to raw text.
    }
    return text;
  } catch (error) {
    return fallback;
  }
}

async function saveToReadwise(item) {
  const { response, error } = await sendRuntimeMessage({
    type: 'save-to-reader',
    pageUrl: normalizeVideoUrl(item.link),
    title: item.title || undefined,
    author: item.channelTitle || undefined,
  });

  if (error) {
    return { status: 'error', message: error };
  }

  if (response?.ok && !response.alreadyExists) {
    markLocalUrlState(READER_SAVED_URLS_KEY, item.link);
    markLocalUrlState(READER_SAVED_URLS_KEY, response.url);
    return { status: 'saved' };
  }

  if (response?.ok && response.alreadyExists) {
    markLocalUrlState(READER_SAVED_URLS_KEY, item.link);
    markLocalUrlState(READER_SAVED_URLS_KEY, response.url);
    return { status: 'exists' };
  }

  if (response?.code === 'missing_token') {
    return { status: 'needs-key' };
  }

  if (response?.status === 401) {
    return { status: 'invalid-key' };
  }

  return {
    status: 'error',
    message: response?.code === 'invalid_url' ? 'Reader can only save YouTube videos.' : 'Readwise save failed.',
  };
}

async function handleSaveToReadwise(item, button) {
  if (!button || !item?.link) return;

  if (!hasReadwiseApiKey()) {
    setReaderButtonState(button, 'needs-key');
    scheduleReaderButtonReset(button);
    showToast('Add your Reader token before saving videos.', {
      actionLabel: 'Open settings',
      onAction: () => {
        hideToast();
        openReadwiseSettingsModal();
      },
      duration: 7000,
    });
    return;
  }

  setReaderButtonState(button, 'saving');

  try {
    const result = await saveToReadwise(item);
    if (result.status === 'needs-key') {
      setReaderButtonState(button, 'needs-key');
      showToast('Add your Reader token in extension options first.', {
        actionLabel: 'Open options',
        onAction: () => {
          hideToast();
          chrome.runtime.openOptionsPage();
        },
        duration: 7000,
      });
      scheduleReaderButtonReset(button);
      return;
    }

    if (result.status === 'saved') {
      setReaderButtonState(button, 'saved');
      showToast(`Saved "${item.title}" to Reader.`);
      item.isSavedToReader = true;
      scheduleReaderButtonReset(button);
      renderLists();
      return;
    }

    if (result.status === 'exists') {
      setReaderButtonState(button, 'exists');
      showToast('This video is already in Reader.');
      item.isSavedToReader = true;
      scheduleReaderButtonReset(button);
      renderLists();
      return;
    }

    if (result.status === 'invalid-key') {
      state.readwiseApiKey = '';
      await setStorage(READWISE_API_KEY_KEY, '');
      updateReaderSettingsButton();
      setReaderButtonState(button, 'invalid-key');
      showToast('Readwise rejected that API key. Update it in All Lists settings.', {
        actionLabel: 'Open settings',
        onAction: () => {
          hideToast();
          openReadwiseSettingsModal();
        },
        duration: 7000,
      });
      scheduleReaderButtonReset(button);
      return;
    }

    setReaderButtonState(button, 'error');
    showToast(result.message || 'Readwise save failed.');
    scheduleReaderButtonReset(button);
  } catch (error) {
    setReaderButtonState(button, 'error');
    showToast('Could not reach Readwise right now.');
    scheduleReaderButtonReset(button);
  }
}

async function handleSendToDownie(item, button) {
  if (!button || !item?.link) return;
  setReaderButtonState(button, 'saving');

  const { response, error } = await sendRuntimeMessage({
    type: 'open-in-downie',
    pageUrl: normalizeVideoUrl(item.link),
  });

  if (response?.ok && !error) {
    markLocalUrlState(DOWNIE_SENT_URLS_KEY, response.url || item.link);
    button.dataset.state = 'saved';
    button.setAttribute('aria-label', 'Sent to Downie');
    button.title = 'Sent to Downie';
    showToast(`Sent "${item.title}" to Downie.`);
    window.setTimeout(() => {
      button.dataset.state = isItemSentToDownie(item) ? 'saved' : 'idle';
    }, 1400);
    return;
  }

  button.dataset.state = 'error';
  showToast('Downie failed.');
  window.setTimeout(() => {
    button.dataset.state = isItemSentToDownie(item) ? 'saved' : 'idle';
  }, 1400);
}

function buildVideoCard(item) {
  const card = document.createElement('div');
  card.className = 'video-card';
  if (item.isArchived) {
    card.classList.add('archived');
  }

  const thumbLink = document.createElement('a');
  thumbLink.href = item.link;
  thumbLink.target = '_blank';
  thumbLink.rel = 'noreferrer';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const thumbImg = document.createElement('img');
  thumbImg.src = item.thumbnail || '';
  thumbImg.alt = item.title;
  thumb.appendChild(thumbImg);

  const duration = document.createElement('div');
  duration.className = 'duration';
  thumb.appendChild(duration);
  applyCachedDuration(item);
  updateDurationBadge(duration, item.durationSeconds);

  const thumbActions = document.createElement('div');
  thumbActions.className = 'thumb-actions';

  const archiveAction = document.createElement('button');
  archiveAction.className = 'thumb-icon-action archive-action';
  archiveAction.type = 'button';
  archiveAction.title = item.isArchived ? 'Restore video' : 'Hide video';
  archiveAction.setAttribute('aria-label', item.isArchived ? 'Restore video' : 'Hide video');
  archiveAction.innerHTML = item.isArchived
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"></path><path d="M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8"></path><path d="M9.5 5.3A8.7 8.7 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.1 3.1"></path><path d="M6.6 6.6C4.3 8.1 3 12 3 12s3.5 7 9 7a8.9 8.9 0 0 0 4.1-1"></path></svg>';
  archiveAction.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextArchived = !item.isArchived;
    updateArchiveState(item.videoId, nextArchived);
    showArchiveToast(
      nextArchived ? 'Video hidden.' : 'Video restored.',
      () => updateArchiveState(item.videoId, !nextArchived)
    );
  });

  thumbActions.appendChild(archiveAction);
  thumb.appendChild(thumbActions);

  const readerActions = document.createElement('div');
  readerActions.className = 'thumb-actions left';

  const readerAction = document.createElement('button');
  readerAction.className = 'thumb-icon-action reader-action';
  readerAction.type = 'button';
  readerAction.title = isItemSavedToReader(item) ? 'Saved in Reader' : 'Save to Reader';
  readerAction.setAttribute('aria-label', readerAction.title);
  readerAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5h8A1.5 1.5 0 0 1 17.5 6v13l-5.5-3.25L6.5 19V6A1.5 1.5 0 0 1 8 4.5Z"></path></svg>';
  setReaderButtonState(readerAction, isItemSavedToReader(item) ? 'saved' : 'idle');
  readerAction.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await handleSaveToReadwise(item, readerAction);
  });

  const downieAction = document.createElement('button');
  downieAction.className = 'thumb-icon-action downie-action';
  downieAction.type = 'button';
  downieAction.title = isItemSentToDownie(item) ? 'Sent to Downie' : 'Send to Downie';
  downieAction.setAttribute('aria-label', downieAction.title);
  downieAction.dataset.state = isItemSentToDownie(item) ? 'saved' : 'idle';
  downieAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v9"></path><path d="m8.5 10.5 3.5 3.5 3.5-3.5"></path><path d="M5 18h14"></path></svg>';
  downieAction.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await handleSendToDownie(item, downieAction);
  });

  readerActions.append(readerAction, downieAction);
  thumb.appendChild(readerActions);

  if (!item.durationSeconds && item.videoId) {
    ensureDuration(item.videoId).then((seconds) => {
      if (!seconds) return;
      item.durationSeconds = seconds;
      updateDurationBadge(duration, seconds);
    });
  }
  thumbLink.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'card-body';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (item.channelAvatar) {
    const avatarImg = document.createElement('img');
    avatarImg.src = item.channelAvatar;
    avatarImg.alt = item.channelTitle;
    avatar.appendChild(avatarImg);
  } else {
    avatar.textContent = item.channelTitle.slice(0, 1).toUpperCase();
  }

  const text = document.createElement('div');

  const titleLink = document.createElement('a');
  titleLink.className = 'title';
  titleLink.href = item.link;
  titleLink.target = '_blank';
  titleLink.rel = 'noreferrer';
  titleLink.textContent = item.title;

  const meta = document.createElement('div');
  meta.className = 'meta';

  const channelLink = document.createElement('a');
  channelLink.href = `https://www.youtube.com/channel/${item.channelId}`;
  channelLink.target = '_blank';
  channelLink.rel = 'noreferrer';
  channelLink.textContent = item.channelTitle;

  const published = document.createElement('span');
  published.textContent = formatRelativeTime(item.published);

  meta.append(channelLink, published);
  text.append(titleLink, meta);
  body.append(avatar, text);

  card.append(thumbLink, body);
  return card;
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (!entry.isIntersecting || state.isLoading) return;
    const items = getFilteredItems();
    if (state.visibleCount >= items.length) return;

    state.visibleCount = Math.min(items.length, state.visibleCount + BATCH_SIZE);
    renderFeed({ append: true });
  }, { rootMargin: '200px' });

  observer.observe(elements.feedFooter);
}

function openModal({ title, bodyBuilder, actionsBuilder }) {
  elements.modalTitle.textContent = title;
  elements.modalBody.innerHTML = '';
  elements.modalActions.innerHTML = '';

  if (bodyBuilder) {
    elements.modalBody.appendChild(bodyBuilder());
  }

  if (actionsBuilder) {
    elements.modalActions.appendChild(actionsBuilder());
  }

  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  elements.modalBackdrop.classList.remove('hidden');
}

function closeModal() {
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  elements.modalBackdrop.classList.add('hidden');
}

function openRenameListModal(listId, { returnToManage = false } = {}) {
  const list = state.lists.find((entry) => entry.id === listId);
  if (!list) return;
  let input;
  let saveButton;

  openModal({
    title: `Rename ${list.name}`,
    bodyBuilder: () => {
      const wrapper = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = 'List name';
      label.className = 'section-title';

      input = document.createElement('input');
      input.className = 'input';
      input.type = 'text';
      input.value = list.name;

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (saveButton) {
            saveButton.click();
          }
        }
      });

      wrapper.append(label, input);
      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return wrapper;
    },
    actionsBuilder: () => {
      const actions = document.createElement('div');

      const cancel = document.createElement('button');
      cancel.className = 'ghost';
      cancel.textContent = 'Cancel';
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        closeModal();
        if (returnToManage) {
          handleManageList();
        }
      });

      const save = document.createElement('button');
      save.className = 'primary';
      save.textContent = 'Save';
      save.type = 'button';
      saveButton = save;
      save.addEventListener('click', async () => {
        const trimmed = (input.value || '').trim();
        if (!trimmed) return;
        list.name = trimmed;
        await setStorage(STORAGE_KEY, state.lists);
        renderLists();
        if (list.id === state.selectedListId) {
          updateHeader((list.channels || []).length, getFilteredItems().length);
        }
        closeModal();
        if (returnToManage) {
          handleManageList();
        }
      });

      actions.append(cancel, save);
      return actions;
    },
  });
}

function openHelpModal() {
  openModal({
    title: 'How YT Lists works',
    bodyBuilder: () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'help-panel';

      const intro = document.createElement('p');
      intro.className = 'help-intro';
      intro.textContent = 'A quick guide to organizing your YouTube subscriptions.';
      wrapper.appendChild(intro);

      const sections = [
        {
          title: 'Add channels',
          items: [
            'Open a channel page and click Add to list.',
            'Use the dropdown to add to an existing list or create a new one.',
          ],
        },
        {
          title: 'Your feed',
          items: [
            'Shows the latest uploads across channels in the selected list.',
            'Use Refresh to check for new videos.',
          ],
        },
        {
          title: 'Hide',
          items: [
            'Hover a card and click Hide to remove it from the active feed.',
            'Use Show Hidden to bring hidden videos back.',
            'Manage a list to hide all videos in one go.',
          ],
        },
        {
          title: 'Shorts',
          items: [
            'Toggle Show Shorts in the header.',
          ],
        },
        {
          title: 'Backup',
          items: [
            'Open the All lists cog to export or import backups.',
            'Export before clearing browser data or switching profiles.',
            'Lists are stored locally unless you export/import them.',
          ],
        },
        {
          title: 'Theme',
          items: [
            'Choose System, Light, or Dark from the same menu.',
          ],
        },
      ];

      sections.forEach((section) => {
        const block = document.createElement('div');
        block.className = 'help-section';

        const heading = document.createElement('h3');
        heading.textContent = section.title;

        const list = document.createElement('ul');
        list.className = 'help-list';
        section.items.forEach((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          list.appendChild(item);
        });

        block.append(heading, list);
        wrapper.appendChild(block);
      });

      return wrapper;
    },
    actionsBuilder: () => {
      const actions = document.createElement('div');
      const close = document.createElement('button');
      close.className = 'ghost';
      close.textContent = 'Close';
      close.type = 'button';
      close.addEventListener('click', closeModal);
      actions.appendChild(close);
      return actions;
    },
  });
}

async function handleCreateList() {
  let input;
  let createButton;

  openModal({
    title: 'Create a new list',
    bodyBuilder: () => {
      const wrapper = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = 'List name';
      label.className = 'section-title';

      input = document.createElement('input');
      input.className = 'input';
      input.type = 'text';
      input.placeholder = 'Fitness, Music, Design...';

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (createButton) {
            createButton.click();
          }
        }
      });

      window.setTimeout(() => {
        input.focus();
      }, 0);

      wrapper.append(label, input);
      return wrapper;
    },
    actionsBuilder: () => {
      const actions = document.createElement('div');

      const cancel = document.createElement('button');
      cancel.className = 'ghost';
      cancel.textContent = 'Cancel';
      cancel.type = 'button';
      cancel.addEventListener('click', closeModal);

      const create = document.createElement('button');
      create.className = 'primary';
      create.textContent = 'Create';
      create.type = 'button';
      createButton = create;
      create.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        const newList = { id: createId(), name, channels: [] };
        state.lists.push(newList);
        await setStorage(STORAGE_KEY, state.lists);
        insertListOrder(newList.id);
        await selectList(newList.id);
        closeModal();
      });

      actions.append(cancel, create);
      return actions;
    },
  });
}

async function handleManageList() {
  const list = state.lists.find((entry) => entry.id === state.selectedListId);
  if (!list) return;

  const renderManageContent = () => {
    elements.modalTitle.textContent = `Manage ${list.name}`;
    elements.modalBody.innerHTML = '';
    elements.modalActions.innerHTML = '';

    const wrapper = document.createElement('div');

    const rename = document.createElement('button');
    rename.className = 'ghost';
    rename.textContent = 'Rename list';
    rename.type = 'button';
    rename.addEventListener('click', () => {
      openRenameListModal(list.id, { returnToManage: true });
    });

    const removeList = document.createElement('button');
    removeList.className = 'danger';
    removeList.textContent = 'Delete list';
    removeList.type = 'button';
    removeList.addEventListener('click', async () => {
      const confirmed = window.confirm(`Delete "${list.name}"?`);
      if (!confirmed) return;
      state.lists = state.lists.filter((entry) => entry.id !== list.id);
      await setStorage(STORAGE_KEY, state.lists);
      removeListOrder(list.id);
      await selectList('all');
      closeModal();
    });

    const topRow = document.createElement('div');
    topRow.className = 'manage-header-row';
    topRow.append(rename, removeList);

    const archiveRow = document.createElement('div');
    archiveRow.className = 'manage-archive-row';

    const archiveAll = document.createElement('button');
    archiveAll.className = 'ghost';
    archiveAll.type = 'button';
    archiveAll.textContent = 'Hide all videos';
    archiveAll.addEventListener('click', () => {
      archiveAllVisibleItems(list);
    });

    const archiveHint = document.createElement('div');
    archiveHint.className = 'manage-hint';
    archiveHint.textContent = 'This hides all videos in the list. You can undo from the toast or show hidden later.';

    archiveRow.append(archiveAll, archiveHint);

    wrapper.append(topRow, archiveRow);

    const channelTitle = document.createElement('div');
    channelTitle.className = 'section-title';
    channelTitle.textContent = `Channels in this list (${(list.channels || []).length})`;
    wrapper.appendChild(channelTitle);

    if (!list.channels || list.channels.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No channels yet. Add some from YouTube.';
      empty.style.color = 'var(--text-muted)';
      wrapper.appendChild(empty);
    } else {
      list.channels.forEach((channel) => {
        const row = document.createElement('div');
        row.className = 'channel-row';

        const info = document.createElement('div');
        info.className = 'channel-info';

        const channelUrl = buildChannelUrl(channel);
        const handle = extractChannelHandle(channelUrl);

        const link = document.createElement('a');
        link.className = 'channel-link';
        link.href = channelUrl;
        link.target = '_blank';
        link.rel = 'noreferrer';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (channel.avatarUrl) {
          const img = document.createElement('img');
          img.src = channel.avatarUrl;
          img.alt = channel.name;
          avatar.appendChild(img);
        } else {
          avatar.textContent = channel.name.slice(0, 1).toUpperCase();
        }

        const textWrap = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'channel-name';
        name.textContent = channel.name;
        textWrap.appendChild(name);

        if (handle) {
          const handleEl = document.createElement('div');
          handleEl.className = 'channel-handle';
          handleEl.textContent = handle;
          textWrap.appendChild(handleEl);
        }

        link.append(avatar, textWrap);
        info.appendChild(link);

        const channelSnapshot = { ...channel };
        let isRemoved = false;

        const remove = document.createElement('button');
        remove.className = 'ghost';
        remove.type = 'button';
        remove.textContent = 'Remove';

        const updateRemoveButton = () => {
          remove.textContent = isRemoved ? 'Removed' : 'Remove';
        };

        remove.addEventListener('mouseenter', () => {
          if (isRemoved) {
            remove.textContent = 'Re-add';
          }
        });

        remove.addEventListener('mouseleave', () => {
          updateRemoveButton();
        });

        remove.addEventListener('click', async () => {
          const liveList = state.lists.find((entry) => entry.id === list.id);
          if (!liveList) return;

          const matchesChannel = (entry) => (
            entry.id === channelSnapshot.id
              || (entry.url && channelSnapshot.url && entry.url === channelSnapshot.url)
          );

          if (!isRemoved) {
            liveList.channels = (liveList.channels || []).filter((entry) => !matchesChannel(entry));
            await setStorage(STORAGE_KEY, state.lists);
            renderLists();
            await loadFeed();
            isRemoved = true;
            updateRemoveButton();
            return;
          }

          if (!(liveList.channels || []).some((entry) => matchesChannel(entry))) {
            liveList.channels = liveList.channels || [];
            liveList.channels.push(channelSnapshot);
            await setStorage(STORAGE_KEY, state.lists);
            renderLists();
            await loadFeed();
          }
          isRemoved = false;
          updateRemoveButton();
        });

        row.append(info, remove);
        wrapper.appendChild(row);
      });
    }

    elements.modalBody.appendChild(wrapper);

    const actions = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'ghost';
    close.textContent = 'Close';
    close.type = 'button';
    close.addEventListener('click', closeModal);
    actions.appendChild(close);
    elements.modalActions.appendChild(actions);
  };

  renderManageContent();
  elements.modalBackdrop.classList.remove('hidden');
}

async function init() {
  state.lists = (await getStorage(STORAGE_KEY, [])) || [];
  state.selectedListId = (await getStorage(SELECTED_KEY, 'all')) || 'all';
  state.hideShorts = (await getStorage(HIDE_SHORTS_KEY, true)) ?? true;
  state.hideArchived = (await getStorage(HIDE_ARCHIVED_KEY, true)) ?? true;
  state.hideFeedVideos = (await getStorage(HIDE_FEED_VIDEOS_KEY, false)) ?? false;
  state.listOrder = (await getStorage(LIST_ORDER_KEY, [])) || [];
  state.theme = normalizeTheme(await getStorage(THEME_KEY, 'system'));
  state.readwiseApiKey = (await getStorage(READWISE_API_KEY_KEY, '')) || '';
  state.readerSavedUrls = (await getStorage(READER_SAVED_URLS_KEY, {})) || {};
  state.downieSentUrls = (await getStorage(DOWNIE_SENT_URLS_KEY, {})) || {};
  await loadDurationCacheFromStorage();
  await loadFeedCacheFromStorage();
  await loadArchivedFromStorage();
  if (state.selectedListId !== 'all' && state.selectedListId !== SMART_READER_SAVED_ID && !state.lists.find((entry) => entry.id === state.selectedListId)) {
    state.selectedListId = 'all';
    await setStorage(SELECTED_KEY, 'all');
  }

  syncListOrder();
  applyTheme(state.theme);
  updateSearchUi();
  renderLists();
  updateReaderSettingsButton();
  updateFeedVideosToggle();
  updateShortsToggle();
  updateArchivedToggle();
  setupListDrag();
  setupInfiniteScroll();
  await loadFeed();
}

elements.createList.addEventListener('click', handleCreateList);
elements.manageList.addEventListener('click', handleManageList);
elements.refreshFeed.addEventListener('click', loadFeed);
elements.toggleFeedVideos.addEventListener('click', async () => {
  state.hideFeedVideos = !state.hideFeedVideos;
  await setStorage(HIDE_FEED_VIDEOS_KEY, state.hideFeedVideos);
  updateFeedVideosToggle();
});
elements.toggleShorts.addEventListener('click', async () => {
  state.hideShorts = !state.hideShorts;
  await setStorage(HIDE_SHORTS_KEY, state.hideShorts);
  updateShortsToggle();
  state.visibleCount = INITIAL_COUNT;
  state.renderedCount = 0;
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
});
elements.toggleArchived.addEventListener('click', async () => {
  state.hideArchived = !state.hideArchived;
  await setStorage(HIDE_ARCHIVED_KEY, state.hideArchived);
  updateArchivedToggle();
  state.visibleCount = INITIAL_COUNT;
  state.renderedCount = 0;
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
});
elements.modalClose.addEventListener('click', closeModal);
elements.modalBackdrop.addEventListener('click', (event) => {
  if (event.target === elements.modalBackdrop) {
    closeModal();
  }
});

if (elements.listSearch) {
  elements.listSearch.addEventListener('input', (event) => {
    state.searchQuery = event.target.value || '';
    updateSearchUi();
    renderLists();
    state.visibleCount = INITIAL_COUNT;
    state.renderedCount = 0;
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  });
}

if (elements.listSearchClear) {
  elements.listSearchClear.addEventListener('click', () => {
    if (elements.listSearch) {
      elements.listSearch.value = '';
      state.searchQuery = '';
      updateSearchUi();
      renderLists();
      state.visibleCount = INITIAL_COUNT;
      state.renderedCount = 0;
      updateHeader(getChannelsForSelection().length, getFilteredItems().length);
      renderFeed();
      elements.listSearch.focus();
    }
  });
}

if (elements.archiveUndo) {
  elements.archiveUndo.addEventListener('click', () => {
    if (typeof toastUndo === 'function') {
      toastUndo();
    }
    hideToast();
  });
}

if (elements.importFile) {
  elements.importFile.addEventListener('change', handleImportFileChange);
}

document.addEventListener('click', (event) => {
  if (!settingsPopover || settingsPopover.classList.contains('hidden')) return;
  if (settingsPopover.contains(event.target)) return;
  if (settingsPopoverAnchor && settingsPopoverAnchor.contains(event.target)) return;
  closeSettingsPopover();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSettingsPopover();
    if (!elements.modalBackdrop.classList.contains('hidden')) {
      closeModal();
    }
  }
});

window.addEventListener('resize', () => {
  if (settingsPopoverAnchor && settingsPopover && !settingsPopover.classList.contains('hidden')) {
    positionSettingsPopover(settingsPopoverAnchor);
  }
});

let reloadTimer = null;
function scheduleFeedReload(options = {}) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    if (!state.isLoading) {
      loadFeed({ clearBefore: false, ...options });
    }
  }, 250);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' && area !== 'sync') return;

  if (area === 'sync') {
    const mirror = {};
    SYNC_KEYS.forEach((key) => {
      if (changes[key]) {
        mirror[key] = changes[key].newValue;
      }
    });
    if (Object.keys(mirror).length) {
      chrome.storage.local.set(mirror);
    }
  }

  let shouldReload = false;

  if (changes[STORAGE_KEY]) {
    state.lists = changes[STORAGE_KEY].newValue || [];
    syncListOrder();
    renderLists();
    shouldReload = true;
  }

  if (changes[SELECTED_KEY]) {
    state.selectedListId = changes[SELECTED_KEY].newValue || 'all';
    renderLists();
    shouldReload = true;
  }

  if (changes[LIST_ORDER_KEY]) {
    state.listOrder = changes[LIST_ORDER_KEY].newValue || [];
    syncListOrder();
    renderLists();
  }

  if (changes[HIDE_SHORTS_KEY]) {
    state.hideShorts = changes[HIDE_SHORTS_KEY].newValue ?? true;
    updateShortsToggle();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  }

  if (changes[HIDE_ARCHIVED_KEY]) {
    state.hideArchived = changes[HIDE_ARCHIVED_KEY].newValue ?? true;
    updateArchivedToggle();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  }

  if (changes[HIDE_FEED_VIDEOS_KEY]) {
    state.hideFeedVideos = changes[HIDE_FEED_VIDEOS_KEY].newValue ?? false;
    updateFeedVideosToggle();
  }

  if (changes[THEME_KEY]) {
    state.theme = normalizeTheme(changes[THEME_KEY].newValue);
    applyTheme(state.theme);
    updateThemeButtons();
  }

  if (changes[READWISE_API_KEY_KEY]) {
    state.readwiseApiKey = changes[READWISE_API_KEY_KEY].newValue || '';
    updateReaderSettingsButton();
  }

  if (changes[READER_SAVED_URLS_KEY]) {
    state.readerSavedUrls = changes[READER_SAVED_URLS_KEY].newValue || {};
    state.items.forEach((item) => {
      item.isSavedToReader = isItemSavedToReader(item);
    });
    renderLists();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  }

  if (changes[DOWNIE_SENT_URLS_KEY]) {
    state.downieSentUrls = changes[DOWNIE_SENT_URLS_KEY].newValue || {};
    state.items.forEach((item) => {
      item.isSentToDownie = isItemSentToDownie(item);
    });
    renderFeed();
  }

  if (changes[ARCHIVE_KEY]) {
    state.archived = new Map();
    const next = changes[ARCHIVE_KEY].newValue || {};
    Object.entries(next).forEach(([videoId, archivedAt]) => {
      if (videoId) {
        const timestamp = Number.parseInt(archivedAt, 10);
        state.archived.set(videoId, Number.isFinite(timestamp) ? timestamp : Date.now());
      }
    });
    state.items.forEach((item) => {
      item.isArchived = isItemArchived(item);
    });
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  }

  if (shouldReload) {
    scheduleFeedReload({ clearBefore: false });
  }
});

document.addEventListener('DOMContentLoaded', init);
