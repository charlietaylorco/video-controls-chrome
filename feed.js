const STORAGE_KEY = 'ytLists';
const SELECTED_KEY = 'ytListsSelectedId';
const HIDE_SHORTS_KEY = 'ytListsHideShorts';
const HIDE_ARCHIVED_KEY = 'ytListsHideArchived';
const HIDE_FEED_VIDEOS_KEY = 'ytListsHideFeedVideos';
const HIDE_READER_SAVED_KEY = 'ytListsHideReaderSaved';
const HIDE_DOWNIE_SENT_KEY = 'ytListsHideDownieSent';
const FEED_CACHE_KEY = 'ytListsFeedCache';
const DURATION_CACHE_KEY = 'ytListsDurationCache';
const ARCHIVE_KEY = 'ytListsArchived';
const LIST_ORDER_KEY = 'ytListsOrder';
const HIDDEN_SMART_LISTS_KEY = 'ytListsHiddenSmartLists';
const THEME_KEY = 'ytListsTheme';
const READWISE_API_KEY_KEY = 'readerToken';
const READER_SAVED_URLS_KEY = 'readerSavedUrls';
const DOWNIE_SENT_URLS_KEY = 'downieSentUrls';
const READWISE_SAVE_ENDPOINT = 'https://readwise.io/api/v3/save/';
const READWISE_AUTH_ENDPOINT = 'https://readwise.io/api/v2/auth/';
const SMART_READER_SAVED_ID = 'reader-saved';
const SMART_DOWNIE_SENT_ID = 'downie-sent';
const SMART_LIST_IDS = new Set(['all', SMART_READER_SAVED_ID, SMART_DOWNIE_SENT_ID]);
const SMART_LISTS = [
  { id: 'all', name: 'All lists' },
  { id: SMART_READER_SAVED_ID, name: 'Saved to Reader' },
  { id: SMART_DOWNIE_SENT_ID, name: 'Sent to Downie' },
];
const SYNC_KEYS = new Set([
  LIST_ORDER_KEY,
  HIDDEN_SMART_LISTS_KEY,
  SELECTED_KEY,
  HIDE_SHORTS_KEY,
  HIDE_ARCHIVED_KEY,
  HIDE_FEED_VIDEOS_KEY,
  HIDE_READER_SAVED_KEY,
  HIDE_DOWNIE_SENT_KEY,
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
  hideReaderSaved: false,
  hideDownieSent: false,
  feedCache: {},
  archived: new Map(),
  readerSavedUrls: {},
  downieSentUrls: {},
  listOrder: [],
  hiddenSmartListIds: new Set(),
  theme: 'system',
  searchQuery: '',
  readwiseApiKey: '',
};

const resolvedIdCache = new Map();
const durationCache = new Map();
let durationPersistTimer = null;
let feedPersistTimer = null;
let archivePersistTimer = null;
let feedLoadGeneration = 0;
let settingsPopoverReader = null;
const settingsSmartListButtons = new Map();
const settingsThemeButtons = new Map();
const readerButtonResetTimers = new WeakMap();
const toastTimers = new Map();
const channelRemovalToasts = new WeakMap();
const durationQueue = [];
let durationActive = 0;
const DURATION_CONCURRENCY = 4;
const TOAST_DURATION = 10000;
let activeModalReturnFocus = null;
let activeDrawerReturnFocus = null;
let activeModalOnClose = null;
let modalClosesOnBackdrop = true;
let drawerListId = null;
let drawerRenameOriginal = '';
let drawerIsRenaming = false;

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

async function normalizeStoredChannels(lists = state.lists, shouldPersist = () => true) {
  let updated = false;
  for (const list of lists) {
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
  if (updated && shouldPersist()) {
    await setStorage(STORAGE_KEY, lists);
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
  toggleReaderSaved: document.getElementById('toggle-reader-saved'),
  toggleDownieSent: document.getElementById('toggle-downie-sent'),
  toggleFilters: document.getElementById('toggle-filters'),
  filterPanel: document.getElementById('filter-panel'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  modalDescription: document.getElementById('modal-description'),
  modalBody: document.getElementById('modal-body'),
  modalActions: document.getElementById('modal-actions'),
  modalClose: document.getElementById('modal-close'),
  listDrawerBackdrop: document.getElementById('list-drawer-backdrop'),
  listDrawer: document.getElementById('list-drawer'),
  listDrawerTitle: document.getElementById('list-drawer-title'),
  listDrawerTitleEdit: document.getElementById('list-drawer-title-edit'),
  listDrawerSubtitle: document.getElementById('list-drawer-subtitle'),
  listDrawerBody: document.getElementById('list-drawer-body'),
  listDrawerClose: document.getElementById('list-drawer-close'),
  listDrawerDone: document.getElementById('list-drawer-done'),
  toastStack: document.getElementById('toast-stack'),
  importFile: document.getElementById('import-file'),
  sidebarSettings: document.getElementById('sidebar-settings'),
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

function isSmartListId(id) {
  return SMART_LIST_IDS.has(id);
}

function isSmartListHideable(id) {
  return isSmartListId(id);
}

function isSmartListHidden(id) {
  return isSmartListHideable(id) && state.hiddenSmartListIds.has(id);
}

function sanitizeHiddenSmartListIds(value) {
  const ids = Array.isArray(value) ? value : [];
  return ids.filter((id) => isSmartListHideable(id));
}

async function setSmartListHidden(id, hidden) {
  if (!isSmartListHideable(id)) return;
  if (hidden) {
    state.hiddenSmartListIds.add(id);
    if (state.selectedListId === id) {
      state.selectedListId = getFallbackListId(id);
      await setStorage(SELECTED_KEY, state.selectedListId);
    }
  } else {
    state.hiddenSmartListIds.delete(id);
  }
  await setStorage(HIDDEN_SMART_LISTS_KEY, Array.from(state.hiddenSmartListIds));
  renderLists({ keepSettingsPopoverOpen: true });
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
}

function getFallbackListId(excludedId = '') {
  const visibleSmartList = SMART_LISTS.find((list) => list.id !== excludedId && !isSmartListHidden(list.id));
  if (visibleSmartList) return visibleSmartList.id;
  return state.lists[0]?.id || 'all';
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

function removeToast(toast) {
  if (!toast) return;
  const timer = toastTimers.get(toast);
  if (timer?.timeout) {
    clearTimeout(timer.timeout);
  }
  toastTimers.delete(toast);
  toast.remove();
}

function scheduleToastRemoval(toast, duration) {
  if (!toast?.isConnected) return;
  const timeoutDuration = Math.max(250, Number(duration) || TOAST_DURATION);
  const timer = toastTimers.get(toast) || {};
  if (timer.timeout) {
    clearTimeout(timer.timeout);
  }
  timer.remaining = timeoutDuration;
  timer.expiresAt = Date.now() + timeoutDuration;
  timer.timeout = window.setTimeout(() => removeToast(toast), timeoutDuration);
  toastTimers.set(toast, timer);
}

function showToast(message, { actionLabel = '', onAction = null, duration = TOAST_DURATION } = {}) {
  if (!elements.toastStack) return null;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');

  const copy = document.createElement('span');
  copy.className = 'toast-message';
  copy.textContent = message;
  toast.appendChild(copy);

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.className = 'toast-button';
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        await onAction();
      } finally {
        removeToast(toast);
      }
    });
    toast.appendChild(action);
  }

  elements.toastStack.appendChild(toast);
  scheduleToastRemoval(toast, duration);
  return toast;
}

function showArchiveToast(message, onUndo) {
  return showToast(message, { actionLabel: 'Undo', onAction: onUndo });
}

async function archiveAllVisibleItems(list) {
  if (!list) return;
  const channelIds = new Set((list.channels || []).map((channel) => channel?.id).filter(Boolean));
  const items = (state.items || []).filter((item) => !channelIds.size || channelIds.has(item.channelId));
  const toArchive = items.filter((item) => item && item.videoId && !state.archived.has(item.videoId));
  if (!toArchive.length) {
    showArchiveToast('Everything here is already hidden.');
    return;
  }

  const confirmed = await confirmAction({
    title: 'Hide all visible videos?',
    description: `This hides ${toArchive.length} video${toArchive.length === 1 ? '' : 's'} from "${list.name}". You can restore them using Show Hidden.`,
    confirmLabel: `Hide ${toArchive.length} video${toArchive.length === 1 ? '' : 's'}`,
  });
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
  const list = state.selectedListId === SMART_DOWNIE_SENT_ID
    ? { name: 'Sent to Downie' }
    : state.selectedListId === SMART_READER_SAVED_ID
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
      hideReaderSaved: state.hideReaderSaved,
      hideDownieSent: state.hideDownieSent,
      hiddenSmartListIds: Array.from(state.hiddenSmartListIds),
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
  state.hideReaderSaved = payload.settings?.hideReaderSaved ?? false;
  state.hideDownieSent = payload.settings?.hideDownieSent ?? false;
  state.hiddenSmartListIds = new Set(sanitizeHiddenSmartListIds(payload.settings?.hiddenSmartListIds));
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
  if (isSmartListHidden(state.selectedListId) || (!isSmartListId(state.selectedListId) && !state.lists.find((entry) => entry.id === state.selectedListId))) {
    state.selectedListId = getFallbackListId(state.selectedListId);
  }

  await setStorage(STORAGE_KEY, state.lists);
  await setStorage(LIST_ORDER_KEY, state.listOrder);
  await setStorage(SELECTED_KEY, state.selectedListId);
  await setStorage(HIDE_SHORTS_KEY, state.hideShorts);
  await setStorage(HIDE_ARCHIVED_KEY, state.hideArchived);
  await setStorage(HIDE_FEED_VIDEOS_KEY, state.hideFeedVideos);
  await setStorage(HIDE_READER_SAVED_KEY, state.hideReaderSaved);
  await setStorage(HIDE_DOWNIE_SENT_KEY, state.hideDownieSent);
  await setStorage(HIDDEN_SMART_LISTS_KEY, Array.from(state.hiddenSmartListIds));
  await setStorage(THEME_KEY, state.theme);
  await setStorage(ARCHIVE_KEY, Object.fromEntries(state.archived));

  renderLists();
  updateShortsToggle();
  updateArchivedToggle();
  updateFeedVideosToggle();
  updateReaderSavedToggle();
  updateDownieSentToggle();
  updateSmartListSettingsButtons();
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

function updateSmartListSettingsButtons() {
  settingsSmartListButtons.forEach((button, id) => {
    const hidden = isSmartListHidden(id);
    const name = SMART_LISTS.find((list) => list.id === id)?.name || 'Smart list';
    button.textContent = hidden ? `Show ${name}` : `Hide ${name}`;
    button.setAttribute('aria-pressed', hidden ? 'false' : 'true');
  });
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
    description: 'Connect Readwise to save videos directly from YT Lists.',
    variant: 'standard',
    returnFocus: elements.sidebarSettings,
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
    showToast('That file is not valid JSON.');
    return;
  }

  if (!payload || !Array.isArray(payload.lists)) {
    showToast('That file is not a valid YT Lists backup.');
    return;
  }

  const confirmed = await confirmAction({
    title: 'Replace your YT Lists data?',
    description: 'Importing this backup replaces your current lists and preferences. Export your current data first if you may need it later.',
    confirmLabel: 'Import and replace',
    tone: 'danger',
  });
  if (!confirmed) return;

  await applyImport(payload);
  showToast('YT Lists backup imported.');
}

function openSettingsModal(initialSection = 'reader') {
  settingsPopoverReader = null;
  settingsSmartListButtons.clear();
  settingsThemeButtons.clear();

  openModal({
    title: 'Settings',
    description: 'Manage integrations, smart views, appearance, backups, and help.',
    variant: 'wide',
    returnFocus: elements.sidebarSettings,
    bodyBuilder: () => {
      const layout = document.createElement('div');
      layout.className = 'settings-dialog';

      const nav = document.createElement('div');
      nav.className = 'settings-dialog-nav';
      nav.setAttribute('role', 'tablist');
      nav.setAttribute('aria-label', 'Settings sections');

      const pane = document.createElement('div');
      pane.className = 'settings-dialog-pane';

      const sections = [
        { id: 'reader', label: 'Reader' },
        { id: 'smart-views', label: 'Smart views' },
        { id: 'appearance', label: 'Appearance' },
        { id: 'data-help', label: 'Data & help' },
      ];
      const navButtons = new Map();

      const addSectionHeading = (title, description) => {
        const heading = document.createElement('div');
        heading.className = 'settings-section-heading';
        const titleEl = document.createElement('h3');
        titleEl.textContent = title;
        const copy = document.createElement('p');
        copy.textContent = description;
        heading.append(titleEl, copy);
        pane.appendChild(heading);
      };

      const renderSection = (sectionId) => {
        pane.innerHTML = '';
        navButtons.forEach((button, id) => {
          const selected = id === sectionId;
          button.classList.toggle('active', selected);
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });

        if (sectionId === 'reader') {
          addSectionHeading('Reader integration', 'Save videos from YT Lists directly to your Reader library.');
          const status = document.createElement('div');
          status.className = 'settings-status';
          const chip = document.createElement('span');
          chip.className = `status-chip${hasReadwiseApiKey() ? ' connected' : ''}`;
          chip.textContent = hasReadwiseApiKey() ? 'Connected' : 'Not connected';
          const copy = document.createElement('span');
          copy.textContent = hasReadwiseApiKey()
            ? 'Reader is ready in this browser profile.'
            : 'Add a Readwise token before saving videos.';
          status.append(chip, copy);

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'settings-action primary';
          button.addEventListener('click', openReadwiseSettingsModal);
          settingsPopoverReader = button;
          pane.append(status, button);
          updateReaderSettingsButton();
          return;
        }

        if (sectionId === 'smart-views') {
          addSectionHeading('Smart views', 'Choose which generated views appear in the list sidebar.');
          const group = document.createElement('div');
          group.className = 'settings-row-list';
          SMART_LISTS.filter((list) => isSmartListHideable(list.id)).forEach((list) => {
            const row = document.createElement('div');
            row.className = 'settings-row';
            const copy = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = list.name;
            const detail = document.createElement('span');
            detail.textContent = list.id === 'all'
              ? 'Channels across every list.'
              : list.id === SMART_READER_SAVED_ID
                ? 'Videos saved to Reader.'
                : 'Videos sent to Downie.';
            copy.append(name, detail);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'settings-row-action';
            button.addEventListener('click', async () => {
              await setSmartListHidden(list.id, !isSmartListHidden(list.id));
              updateSmartListSettingsButtons();
            });
            settingsSmartListButtons.set(list.id, button);
            row.append(copy, button);
            group.appendChild(row);
          });
          pane.appendChild(group);
          updateSmartListSettingsButtons();
          return;
        }

        if (sectionId === 'appearance') {
          addSectionHeading('Appearance', 'Choose how YT Lists follows your browser theme.');
          const themeGroup = document.createElement('div');
          themeGroup.className = 'settings-theme-group';
          [
            { id: 'system', label: 'System' },
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ].forEach(({ id, label }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'settings-theme-option';
            button.textContent = label;
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => setTheme(id));
            settingsThemeButtons.set(id, button);
            themeGroup.appendChild(button);
          });
          pane.appendChild(themeGroup);
          updateThemeButtons();
          return;
        }

        addSectionHeading('Data & help', 'Back up your lists or revisit how the extension works.');
        const actions = document.createElement('div');
        actions.className = 'settings-row-list';
        [
          {
            title: 'Export backup',
            detail: 'Download lists, order, archive state, and preferences.',
            label: 'Export',
            action: () => {
              triggerExport();
              showToast('YT Lists backup exported.');
            },
          },
          {
            title: 'Import backup',
            detail: 'Replace current data from a YT Lists backup file.',
            label: 'Import',
            action: () => {
              closeModal();
              triggerImportSelect();
            },
          },
          {
            title: 'How YT Lists works',
            detail: 'Read the short guide to lists, feeds, hiding, and backups.',
            label: 'Open guide',
            action: openHelpModal,
          },
        ].forEach((item) => {
          const row = document.createElement('div');
          row.className = 'settings-row';
          const copy = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = item.title;
          const detail = document.createElement('span');
          detail.textContent = item.detail;
          copy.append(title, detail);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'settings-row-action';
          button.textContent = item.label;
          button.addEventListener('click', item.action);
          row.append(copy, button);
          actions.appendChild(row);
        });
        pane.appendChild(actions);
      };

      sections.forEach((section) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-dialog-tab';
        button.setAttribute('role', 'tab');
        button.textContent = section.label;
        button.addEventListener('click', () => renderSection(section.id));
        navButtons.set(section.id, button);
        nav.appendChild(button);
      });

      layout.append(nav, pane);
      window.setTimeout(() => renderSection(initialSection), 0);
      return layout;
    },
    actionsBuilder: () => {
      const close = document.createElement('button');
      close.className = 'primary';
      close.type = 'button';
      close.textContent = 'Done';
      close.addEventListener('click', closeModal);
      return close;
    },
  });
}

function getFilteredItems() {
  return state.items.filter((item) => {
    if (state.selectedListId === SMART_READER_SAVED_ID && !isItemSavedToReader(item)) return false;
    if (state.selectedListId === SMART_DOWNIE_SENT_ID && !isItemSentToDownie(item)) return false;
    if (state.selectedListId !== SMART_READER_SAVED_ID && state.selectedListId !== SMART_DOWNIE_SENT_ID) {
      if (state.hideReaderSaved && isItemSavedToReader(item)) return false;
      if (state.hideDownieSent && isItemSentToDownie(item)) return false;
    }
    if (state.hideShorts && item.isShort) return false;
    if (state.hideArchived && isItemArchived(item)) return false;
    return true;
  });
}

function countSavedReaderItems() {
  return (state.items || []).filter((item) => isItemSavedToReader(item)).length;
}

function countSentDownieItems() {
  return (state.items || []).filter((item) => isItemSentToDownie(item)).length;
}

function getSmartListCount(id) {
  if (id === 'all') return uniqueChannelsFromLists(state.lists).length;
  if (id === SMART_READER_SAVED_ID) return countSavedReaderItems();
  if (id === SMART_DOWNIE_SENT_ID) return countSentDownieItems();
  return 0;
}

function smartListMatches(name, query) {
  if (!query) return true;
  return name.toLowerCase().includes(query);
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

function updateFilterSummary() {
  if (!elements.toggleFilters) return;
  const activeCount = [
    state.hideShorts,
    state.hideArchived,
    state.hideReaderSaved,
    state.hideDownieSent,
  ].filter(Boolean).length;
  elements.toggleFilters.textContent = activeCount ? `Filters · ${activeCount}` : 'Filters';
  elements.toggleFilters.classList.toggle('active', activeCount > 0);
}

function closeFilterPanel() {
  if (!elements.filterPanel || elements.filterPanel.classList.contains('hidden')) return;
  elements.filterPanel.classList.add('hidden');
  elements.toggleFilters?.setAttribute('aria-expanded', 'false');
}

function toggleFilterPanel() {
  if (!elements.filterPanel) return;
  const willOpen = elements.filterPanel.classList.contains('hidden');
  elements.filterPanel.classList.toggle('hidden', !willOpen);
  elements.toggleFilters?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function updateShortsToggle() {
  if (!elements.toggleShorts) return;
  elements.toggleShorts.textContent = state.hideShorts ? 'Show Shorts' : 'Hide Shorts';
  elements.toggleShorts.setAttribute('aria-pressed', state.hideShorts ? 'true' : 'false');
  updateFilterSummary();
}

function updateArchivedToggle() {
  if (!elements.toggleArchived) return;
  elements.toggleArchived.textContent = state.hideArchived ? 'Show Hidden' : 'Hide Hidden';
  elements.toggleArchived.setAttribute('aria-pressed', state.hideArchived ? 'true' : 'false');
  updateFilterSummary();
}

function updateReaderSavedToggle() {
  if (!elements.toggleReaderSaved) return;
  elements.toggleReaderSaved.textContent = state.hideReaderSaved ? 'Show Reader Saved' : 'Hide Reader Saved';
  elements.toggleReaderSaved.setAttribute('aria-pressed', state.hideReaderSaved ? 'true' : 'false');
  updateFilterSummary();
}

function updateDownieSentToggle() {
  if (!elements.toggleDownieSent) return;
  elements.toggleDownieSent.textContent = state.hideDownieSent ? 'Show Downie Sent' : 'Hide Downie Sent';
  elements.toggleDownieSent.setAttribute('aria-pressed', state.hideDownieSent ? 'true' : 'false');
  updateFilterSummary();
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
  if (isSmartListId(state.selectedListId)) {
    return uniqueChannelsFromLists(state.lists);
  }
  const list = state.lists.find((entry) => entry.id === state.selectedListId);
  return list ? list.channels || [] : [];
}

function syncListOrder() {
  const smartIds = SMART_LISTS.map((list) => list.id);
  const knownIds = new Set([...smartIds, ...state.lists.map((list) => list.id)]);
  const prevOrder = [...state.listOrder];
  let nextOrder = [];

  state.listOrder.forEach((id) => {
    if (knownIds.has(id) && !nextOrder.includes(id)) {
      nextOrder.push(id);
      knownIds.delete(id);
    }
  });

  smartIds.forEach((id, defaultIndex) => {
    if (nextOrder.includes(id)) return;
    const precedingSmartIds = smartIds.slice(0, defaultIndex);
    const insertAfter = Math.max(-1, ...precedingSmartIds.map((smartId) => nextOrder.indexOf(smartId)));
    nextOrder.splice(insertAfter + 1, 0, id);
    knownIds.delete(id);
  });

  const remainingUserIds = Array.from(knownIds).filter((id) => !isSmartListId(id));
  nextOrder.push(...remainingUserIds);

  state.listOrder = nextOrder;

  if (JSON.stringify(prevOrder) !== JSON.stringify(nextOrder)) {
    setStorage(LIST_ORDER_KEY, state.listOrder);
  }
}

function insertListOrder(id) {
  if (!id || state.listOrder.includes(id)) return;
  state.listOrder.push(id);
  setStorage(LIST_ORDER_KEY, state.listOrder);
}

function removeListOrder(id) {
  if (!id) return;
  state.listOrder = state.listOrder.filter((entry) => entry !== id);
  setStorage(LIST_ORDER_KEY, state.listOrder);
}

function mergeVisibleListOrder(previousOrder, visibleOrder) {
  const visibleIds = Array.from(new Set((visibleOrder || []).filter(Boolean)));
  const visibleSet = new Set(visibleIds);
  let visibleIndex = 0;
  const merged = [];

  (previousOrder || []).forEach((id) => {
    const nextId = visibleSet.has(id) ? visibleIds[visibleIndex++] : id;
    if (nextId && !merged.includes(nextId)) {
      merged.push(nextId);
    }
  });

  visibleIds.slice(visibleIndex).forEach((id) => {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  });

  return merged;
}

function renderLists() {
  elements.listItems.innerHTML = '';

  const listMap = new Map(state.lists.map((list) => [list.id, list]));
  const entryMap = new Map();
  const ordered = [];
  const query = state.searchQuery.trim();
  const normalizedQuery = query.toLowerCase();

  SMART_LISTS.forEach((list) => {
    if (!isSmartListHidden(list.id) && smartListMatches(list.name, normalizedQuery)) {
      entryMap.set(list.id, { ...list, count: getSmartListCount(list.id) });
    }
  });

  state.listOrder.forEach((id) => {
    if (entryMap.has(id)) {
      ordered.push(entryMap.get(id));
      entryMap.delete(id);
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

  if (entryMap.size) {
    ordered.push(...entryMap.values());
  }

  ordered.forEach((entry) => {
    const button = buildListButton(entry);
    elements.listItems.appendChild(button);
  });

  updateListSearchEmpty(ordered.length > 0);
}

function buildListButton({ id, name, count }) {
  const isSmartList = isSmartListId(id);
  const button = document.createElement('div');
  button.className = `list-item${state.selectedListId === id ? ' active' : ''}${isSmartList ? ' smart' : ''}`;
  button.dataset.listId = id;
  button.draggable = true;
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-pressed', state.selectedListId === id ? 'true' : 'false');

  const handle = document.createElement('span');
  handle.className = 'list-drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="9" cy="6" r="1.4"></circle>
      <circle cx="15" cy="6" r="1.4"></circle>
      <circle cx="9" cy="12" r="1.4"></circle>
      <circle cx="15" cy="12" r="1.4"></circle>
      <circle cx="9" cy="18" r="1.4"></circle>
      <circle cx="15" cy="18" r="1.4"></circle>
    </svg>
  `;
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

  if (!isSmartList) {
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

  if (isSmartListHideable(id)) {
    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'list-hide';
    hideButton.setAttribute('aria-label', `Hide ${name}`);
    hideButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m3 3 18 18"></path>
        <path d="M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8"></path>
        <path d="M9.5 5.3A8.7 8.7 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.1 3.1"></path>
        <path d="M6.6 6.6C4.3 8.1 3 12 3 12s3.5 7 9 7a8.9 8.9 0 0 0 4.1-1"></path>
      </svg>
    `;
    hideButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await setSmartListHidden(id, true);
    });
    hideButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    hideButton.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.append(hideButton);
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
    state.listOrder = mergeVisibleListOrder(state.listOrder, orderedIds);

    const map = new Map(state.lists.map((list) => [list.id, list]));
    state.lists = state.listOrder
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
  const loadGeneration = ++feedLoadGeneration;
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

  const storedLists = (await getStorage(STORAGE_KEY, [])) || [];
  if (loadGeneration !== feedLoadGeneration) return;
  state.lists = storedLists;

  if (isSmartListHidden(state.selectedListId) || (!isSmartListId(state.selectedListId) && !state.lists.find((entry) => entry.id === state.selectedListId))) {
    state.selectedListId = getFallbackListId(state.selectedListId);
    await setStorage(SELECTED_KEY, state.selectedListId);
    if (loadGeneration !== feedLoadGeneration) return;
  }

  await normalizeStoredChannels(storedLists, () => loadGeneration === feedLoadGeneration);
  if (loadGeneration !== feedLoadGeneration) return;

  const channels = getChannelsForSelection();
  elements.manageList.disabled = isSmartListId(state.selectedListId);
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

  if (loadGeneration !== feedLoadGeneration) return;

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

function setDownieButtonState(button, stateName = 'idle', saved = false) {
  if (!button) return;

  const labels = {
    sending: 'Sending to Downie',
    saved: 'Sent to Downie',
    error: 'Try sending to Downie again',
  };
  const effectiveState = stateName === 'idle' && saved ? 'saved' : stateName;
  const label = labels[effectiveState] || 'Send to Downie';

  button.dataset.state = effectiveState;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = effectiveState === 'sending';
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
  setDownieButtonState(button, 'sending');

  const { response, error } = await sendRuntimeMessage({
    type: 'open-in-downie',
    pageUrl: normalizeVideoUrl(item.link),
  });

  if (response?.ok && !error) {
    markLocalUrlState(DOWNIE_SENT_URLS_KEY, item.link);
    markLocalUrlState(DOWNIE_SENT_URLS_KEY, response.url);
    item.isSentToDownie = true;
    setDownieButtonState(button, 'saved');
    showToast(`Sent "${item.title}" to Downie.`);
    renderLists();
    return;
  }

  setDownieButtonState(button, 'error');
  showToast('Downie failed.');
  window.setTimeout(() => {
    setDownieButtonState(button, 'idle', isItemSentToDownie(item));
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
  setDownieButtonState(downieAction, 'idle', isItemSentToDownie(item));
  downieAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v9"></path><path d="m8.5 10.5 3.5 3.5 3.5-3.5"></path><path d="M5 18h14"></path></svg>';
  downieAction.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await handleSendToDownie(item, downieAction);
  });

  readerActions.append(downieAction, readerAction);
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

function isModalOpen() {
  return !!elements.modalBackdrop && !elements.modalBackdrop.classList.contains('hidden');
}

function isListDrawerOpen() {
  return !!elements.listDrawerBackdrop && !elements.listDrawerBackdrop.classList.contains('hidden');
}

function syncOverlayOpenState() {
  const modalOpen = isModalOpen();
  const drawerOpen = isListDrawerOpen();
  const open = modalOpen || drawerOpen;
  document.documentElement.classList.toggle('modal-open', open);
  document.body.classList.toggle('modal-open', open);
  const app = document.querySelector('.app');
  if (app) app.inert = open;
  if (elements.listDrawer) elements.listDrawer.inert = modalOpen;
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
  )).filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const focusable = getFocusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    container?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModal({
  title,
  description = '',
  variant = 'standard',
  tone = 'default',
  bodyBuilder,
  actionsBuilder,
  closeOnBackdrop = true,
  returnFocus = null,
  onClose = null,
}) {
  const wasOpen = isModalOpen();
  elements.modalTitle.textContent = title;
  elements.modalDescription.textContent = description;
  elements.modalDescription.hidden = !description;
  elements.modalBody.innerHTML = '';
  elements.modalActions.innerHTML = '';
  elements.modal.dataset.variant = variant;
  elements.modal.dataset.tone = tone;
  modalClosesOnBackdrop = closeOnBackdrop;
  activeModalOnClose = typeof onClose === 'function' ? onClose : null;
  if (!wasOpen) {
    activeModalReturnFocus = returnFocus || document.activeElement;
  } else if (returnFocus) {
    activeModalReturnFocus = returnFocus;
  }

  if (bodyBuilder) {
    elements.modalBody.appendChild(bodyBuilder());
  }

  if (actionsBuilder) {
    elements.modalActions.appendChild(actionsBuilder());
  }

  elements.modalBackdrop.classList.remove('hidden');
  syncOverlayOpenState();
  window.setTimeout(() => {
    const focusable = getFocusableElements(elements.modal);
    (focusable[0] || elements.modal)?.focus();
  }, 0);
}

function closeModal() {
  if (!isModalOpen()) return;
  const onClose = activeModalOnClose;
  activeModalOnClose = null;
  elements.modalBackdrop.classList.add('hidden');
  syncOverlayOpenState();
  const returnFocus = activeModalReturnFocus;
  activeModalReturnFocus = null;
  if (returnFocus?.isConnected) {
    returnFocus.focus();
  } else if (isListDrawerOpen()) {
    elements.listDrawer?.focus();
  }
  if (onClose) {
    onClose();
  }
}

function confirmAction({ title, description, confirmLabel = 'Continue', tone = 'default' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeModalOnClose = null;
      closeModal();
      resolve(value);
    };

    openModal({
      title,
      description,
      variant: 'compact',
      tone,
      closeOnBackdrop: true,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      actionsBuilder: () => {
        const actions = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.className = 'ghost';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => finish(false));
        const confirm = document.createElement('button');
        confirm.className = tone === 'danger' ? 'danger solid' : 'primary';
        confirm.type = 'button';
        confirm.textContent = confirmLabel;
        confirm.addEventListener('click', () => finish(true));
        actions.append(cancel, confirm);
        return actions;
      },
    });
  });
}

function openRenameListModal(listId, { returnToManage = false } = {}) {
  const list = state.lists.find((entry) => entry.id === listId);
  if (!list) return;
  let input;
  let saveButton;

  openModal({
    title: `Rename ${list.name}`,
    description: 'Choose a clear name you will recognize in the sidebar.',
    variant: 'compact',
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
    description: 'A short guide to deliberate feeds, list management, and backups.',
    variant: 'wide',
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
    description: 'Group channels into a feed you can browse deliberately.',
    variant: 'compact',
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

function updateListDrawerHeader(list) {
  if (!list || drawerIsRenaming) return;
  elements.listDrawerTitle.textContent = list.name;
  const channelCount = (list.channels || []).length;
  elements.listDrawerSubtitle.textContent = `${channelCount} channel${channelCount === 1 ? '' : 's'} · changes save automatically`;
  const channelCountBadge = elements.listDrawerBody.querySelector('.drawer-count');
  if (channelCountBadge) channelCountBadge.textContent = `${channelCount} total`;
}

function setDrawerRenaming(open) {
  const list = state.lists.find((entry) => entry.id === drawerListId);
  if (!list) return;
  if (open) {
    drawerRenameOriginal = list.name;
    drawerIsRenaming = true;
    elements.listDrawerTitle.contentEditable = 'true';
    elements.listDrawerTitle.classList.add('editing');
    elements.listDrawerTitleEdit.classList.add('editing');
    elements.listDrawerTitleEdit.textContent = '✓';
    elements.listDrawerTitleEdit.setAttribute('aria-label', 'Save list name');
    elements.listDrawerTitleEdit.setAttribute('aria-pressed', 'true');
    elements.listDrawerTitle.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(elements.listDrawerTitle);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  drawerIsRenaming = false;
  elements.listDrawerTitle.contentEditable = 'false';
  elements.listDrawerTitle.classList.remove('editing');
  elements.listDrawerTitleEdit.classList.remove('editing');
  elements.listDrawerTitleEdit.textContent = '✎';
  elements.listDrawerTitleEdit.setAttribute('aria-label', 'Edit list name');
  elements.listDrawerTitleEdit.setAttribute('aria-pressed', 'false');
}

async function saveDrawerListName() {
  const list = state.lists.find((entry) => entry.id === drawerListId);
  if (!list) return;
  const nextName = elements.listDrawerTitle.textContent.replace(/\s+/g, ' ').trim();
  list.name = nextName || drawerRenameOriginal;
  elements.listDrawerTitle.textContent = list.name;
  setDrawerRenaming(false);
  await setStorage(STORAGE_KEY, state.lists);
  renderLists();
  updateHeader((list.channels || []).length, getFilteredItems().length);
  updateListDrawerHeader(list);
  const deleteButton = elements.listDrawerBody.querySelector('[data-drawer-delete]');
  if (deleteButton) deleteButton.textContent = `Delete ${list.name}`;
}

function buildDrawerChannelRow(list, channel, originalIndex) {
  const snapshot = { ...channel };
  const row = document.createElement('div');
  row.className = 'drawer-channel-row';
  const link = document.createElement('a');
  link.className = 'channel-link';
  link.href = buildChannelUrl(channel);
  link.target = '_blank';
  link.rel = 'noreferrer';
  const avatar = document.createElement('div');
  avatar.className = 'avatar drawer-avatar';
  if (channel.avatarUrl) {
    const img = document.createElement('img');
    img.src = channel.avatarUrl;
    img.alt = channel.name;
    avatar.appendChild(img);
  } else {
    avatar.textContent = (channel.name || '?').slice(0, 1).toUpperCase();
  }
  const copy = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'channel-name';
  name.textContent = channel.name;
  copy.appendChild(name);
  const handle = extractChannelHandle(link.href);
  if (handle) {
    const handleElement = document.createElement('div');
    handleElement.className = 'channel-handle';
    handleElement.textContent = handle;
    copy.appendChild(handleElement);
  }
  link.append(avatar, copy);

  const action = document.createElement('button');
  action.className = 'drawer-channel-action';
  action.type = 'button';
  action.textContent = 'Remove';
  let removed = false;
  let removalToast = null;
  const matches = (entry) => entry.id === snapshot.id
    || (entry.url && snapshot.url && entry.url === snapshot.url);

  const restore = async () => {
    const liveList = state.lists.find((entry) => entry.id === list.id);
    if (!liveList) return;
    liveList.channels = liveList.channels || [];
    if (!liveList.channels.some(matches)) {
      liveList.channels.splice(Math.min(originalIndex, liveList.channels.length), 0, snapshot);
      await setStorage(STORAGE_KEY, state.lists);
      renderLists();
      await loadFeed({ clearBefore: false });
    }
    removed = false;
    row.classList.remove('removed');
    action.textContent = 'Remove';
    channelRemovalToasts.delete(row);
    updateListDrawerHeader(liveList);
  };

  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      if (removed) {
        if (removalToast) removeToast(removalToast);
        await restore();
        return;
      }
      const liveList = state.lists.find((entry) => entry.id === list.id);
      if (!liveList) return;
      liveList.channels = (liveList.channels || []).filter((entry) => !matches(entry));
      await setStorage(STORAGE_KEY, state.lists);
      renderLists();
      await loadFeed({ clearBefore: false });
      removed = true;
      row.classList.add('removed');
      action.textContent = 'Undo';
      updateListDrawerHeader(liveList);
      removalToast = showToast(`${channel.name} removed from ${liveList.name}.`, {
        actionLabel: 'Undo',
        onAction: restore,
      });
      channelRemovalToasts.set(row, removalToast);
    } finally {
      action.disabled = false;
    }
  });
  row.append(link, action);
  return row;
}

function renderListDrawerBody(list) {
  elements.listDrawerBody.innerHTML = `
    <section class="drawer-section">
      <div class="drawer-section-heading">
        <h3>Feed maintenance</h3>
        <p>Clear the current backlog without changing the channels in this list.</p>
      </div>
      <div class="drawer-callout">
        <div><strong>Hide every visible video</strong><span data-drawer-visible-count></span></div>
        <button class="ghost" type="button" data-drawer-hide-all>Hide all</button>
      </div>
    </section>
    <section class="drawer-section">
      <div class="drawer-section-heading split">
        <div><h3>Channels</h3><p>Removing a channel only affects this list.</p></div>
        <span class="drawer-count">${(list.channels || []).length} total</span>
      </div>
      <div data-drawer-channels></div>
    </section>
    <section class="drawer-section drawer-danger-zone">
      <h3>Delete list</h3>
      <p>Channels remain subscribed on YouTube and stay in any other YT Lists.</p>
      <button class="danger" type="button" data-drawer-delete></button>
    </section>
  `;
  const visibleCount = (state.items || []).filter((item) => !isItemArchived(item)).length;
  elements.listDrawerBody.querySelector('[data-drawer-visible-count]').textContent =
    `${visibleCount} video${visibleCount === 1 ? '' : 's'} can be restored later.`;
  elements.listDrawerBody.querySelector('[data-drawer-hide-all]').addEventListener('click', () => {
    const liveList = state.lists.find((entry) => entry.id === list.id);
    if (liveList) archiveAllVisibleItems(liveList);
  });
  const channels = elements.listDrawerBody.querySelector('[data-drawer-channels]');
  if (!(list.channels || []).length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.textContent = 'No channels yet. Add channels from their YouTube pages.';
    channels.appendChild(empty);
  } else {
    list.channels.forEach((channel, index) => channels.appendChild(buildDrawerChannelRow(list, channel, index)));
  }
  const deleteButton = elements.listDrawerBody.querySelector('[data-drawer-delete]');
  deleteButton.textContent = `Delete ${list.name}`;
  deleteButton.addEventListener('click', async () => {
    const liveList = state.lists.find((entry) => entry.id === list.id);
    if (!liveList) return;
    const confirmed = await confirmAction({
      title: `Delete ${liveList.name}?`,
      description: 'This removes the list, but never unsubscribes from its channels or removes them from other lists.',
      confirmLabel: 'Delete list',
      tone: 'danger',
    });
    if (!confirmed) return;
    state.lists = state.lists.filter((entry) => entry.id !== liveList.id);
    await setStorage(STORAGE_KEY, state.lists);
    removeListOrder(liveList.id);
    closeListDrawer();
    await selectList(getFallbackListId(liveList.id));
    showToast(`${liveList.name} deleted.`);
  });
}

function openListDrawer(list, returnFocus = null) {
  if (!list) return;
  closeFilterPanel();
  drawerListId = list.id;
  drawerIsRenaming = false;
  activeDrawerReturnFocus = returnFocus || document.activeElement;
  updateListDrawerHeader(list);
  renderListDrawerBody(list);
  elements.listDrawerBackdrop.classList.remove('hidden');
  syncOverlayOpenState();
  window.setTimeout(() => elements.listDrawer.focus(), 0);
}

function closeListDrawer() {
  if (!isListDrawerOpen()) return;
  const list = state.lists.find((entry) => entry.id === drawerListId);
  if (drawerIsRenaming && list) {
    elements.listDrawerTitle.textContent = list.name;
    setDrawerRenaming(false);
  }
  elements.listDrawerBackdrop.classList.add('hidden');
  drawerListId = null;
  syncOverlayOpenState();
  const returnFocus = activeDrawerReturnFocus;
  activeDrawerReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

async function handleManageList() {
  const list = state.lists.find((entry) => entry.id === state.selectedListId);
  if (list) openListDrawer(list, elements.manageList);
}

async function init() {
  state.lists = (await getStorage(STORAGE_KEY, [])) || [];
  state.selectedListId = (await getStorage(SELECTED_KEY, 'all')) || 'all';
  state.hideShorts = (await getStorage(HIDE_SHORTS_KEY, true)) ?? true;
  state.hideArchived = (await getStorage(HIDE_ARCHIVED_KEY, true)) ?? true;
  state.hideFeedVideos = (await getStorage(HIDE_FEED_VIDEOS_KEY, false)) ?? false;
  state.hideReaderSaved = (await getStorage(HIDE_READER_SAVED_KEY, false)) ?? false;
  state.hideDownieSent = (await getStorage(HIDE_DOWNIE_SENT_KEY, false)) ?? false;
  state.listOrder = (await getStorage(LIST_ORDER_KEY, [])) || [];
  state.hiddenSmartListIds = new Set(sanitizeHiddenSmartListIds(await getStorage(HIDDEN_SMART_LISTS_KEY, [])));
  state.theme = normalizeTheme(await getStorage(THEME_KEY, 'system'));
  state.readwiseApiKey = (await getStorage(READWISE_API_KEY_KEY, '')) || '';
  state.readerSavedUrls = (await getStorage(READER_SAVED_URLS_KEY, {})) || {};
  state.downieSentUrls = (await getStorage(DOWNIE_SENT_URLS_KEY, {})) || {};
  await loadDurationCacheFromStorage();
  await loadFeedCacheFromStorage();
  await loadArchivedFromStorage();
  if (isSmartListHidden(state.selectedListId) || (!isSmartListId(state.selectedListId) && !state.lists.find((entry) => entry.id === state.selectedListId))) {
    state.selectedListId = getFallbackListId(state.selectedListId);
    await setStorage(SELECTED_KEY, state.selectedListId);
  }

  syncListOrder();
  applyTheme(state.theme);
  updateSearchUi();
  renderLists();
  updateReaderSettingsButton();
  updateFeedVideosToggle();
  updateShortsToggle();
  updateArchivedToggle();
  updateReaderSavedToggle();
  updateDownieSentToggle();
  updateSmartListSettingsButtons();
  setupListDrag();
  setupInfiniteScroll();
  await loadFeed();
}

elements.createList.addEventListener('click', handleCreateList);
elements.manageList.addEventListener('click', handleManageList);
elements.refreshFeed.addEventListener('click', loadFeed);
if (elements.sidebarSettings) {
  elements.sidebarSettings.addEventListener('click', (event) => {
    event.preventDefault();
    openSettingsModal();
  });
}
elements.toggleFilters?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleFilterPanel();
});
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
elements.toggleReaderSaved.addEventListener('click', async () => {
  state.hideReaderSaved = !state.hideReaderSaved;
  await setStorage(HIDE_READER_SAVED_KEY, state.hideReaderSaved);
  updateReaderSavedToggle();
  state.visibleCount = INITIAL_COUNT;
  state.renderedCount = 0;
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
});
elements.toggleDownieSent.addEventListener('click', async () => {
  state.hideDownieSent = !state.hideDownieSent;
  await setStorage(HIDE_DOWNIE_SENT_KEY, state.hideDownieSent);
  updateDownieSentToggle();
  state.visibleCount = INITIAL_COUNT;
  state.renderedCount = 0;
  updateHeader(getChannelsForSelection().length, getFilteredItems().length);
  renderFeed();
});
elements.modalClose.addEventListener('click', closeModal);
elements.modalBackdrop.addEventListener('click', (event) => {
  if (event.target === elements.modalBackdrop && modalClosesOnBackdrop) {
    closeModal();
  }
});

elements.listDrawerTitleEdit?.addEventListener('click', () => {
  if (drawerIsRenaming) {
    saveDrawerListName();
  } else {
    setDrawerRenaming(true);
  }
});
elements.listDrawerTitle?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveDrawerListName();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    const list = state.lists.find((entry) => entry.id === drawerListId);
    if (list) elements.listDrawerTitle.textContent = list.name;
    setDrawerRenaming(false);
  }
});
elements.listDrawerClose?.addEventListener('click', closeListDrawer);
elements.listDrawerDone?.addEventListener('click', closeListDrawer);
elements.listDrawerBackdrop?.addEventListener('click', (event) => {
  if (event.target === elements.listDrawerBackdrop) closeListDrawer();
});

if (elements.listSearch) {
  elements.listSearch.addEventListener('input', (event) => {
    state.searchQuery = event.target.value || '';
    updateSearchUi();
    renderLists();
  });
}

if (elements.listSearchClear) {
  elements.listSearchClear.addEventListener('click', () => {
    if (elements.listSearch) {
      elements.listSearch.value = '';
      state.searchQuery = '';
      updateSearchUi();
      renderLists();
      elements.listSearch.focus();
    }
  });
}

if (elements.importFile) {
  elements.importFile.addEventListener('change', handleImportFileChange);
}

document.addEventListener('click', (event) => {
  if (elements.filterPanel?.classList.contains('hidden')) return;
  if (elements.filterPanel.contains(event.target) || elements.toggleFilters?.contains(event.target)) return;
  closeFilterPanel();
});

document.addEventListener('keydown', (event) => {
  if (isModalOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    trapFocus(event, elements.modal);
    return;
  }

  if (isListDrawerOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (drawerIsRenaming) {
        const list = state.lists.find((entry) => entry.id === drawerListId);
        if (list) elements.listDrawerTitle.textContent = list.name;
        setDrawerRenaming(false);
      } else {
        closeListDrawer();
      }
      return;
    }
    trapFocus(event, elements.listDrawer);
    return;
  }

  if (event.key === 'Escape') {
    closeFilterPanel();
  }
});

elements.toastStack?.addEventListener('pointerenter', () => {
  toastTimers.forEach((timer) => {
    clearTimeout(timer.timeout);
    timer.remaining = Math.max(0, timer.expiresAt - Date.now());
  });
});

elements.toastStack?.addEventListener('pointerleave', () => {
  toastTimers.forEach((timer, toast) => {
    scheduleToastRemoval(toast, Math.max(250, timer.remaining));
  });
});

let reloadTimer = null;
function scheduleFeedReload(options = {}) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    loadFeed({ clearBefore: false, ...options });
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
    if (isSmartListHidden(state.selectedListId)) {
      state.selectedListId = getFallbackListId(state.selectedListId);
      setStorage(SELECTED_KEY, state.selectedListId);
    }
    renderLists();
    shouldReload = true;
  }

  if (changes[LIST_ORDER_KEY]) {
    state.listOrder = changes[LIST_ORDER_KEY].newValue || [];
    syncListOrder();
    renderLists();
  }

  if (changes[HIDDEN_SMART_LISTS_KEY]) {
    state.hiddenSmartListIds = new Set(sanitizeHiddenSmartListIds(changes[HIDDEN_SMART_LISTS_KEY].newValue));
    if (isSmartListHidden(state.selectedListId)) {
      state.selectedListId = getFallbackListId(state.selectedListId);
      setStorage(SELECTED_KEY, state.selectedListId);
    }
    updateSmartListSettingsButtons();
    renderLists();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
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

  if (changes[HIDE_READER_SAVED_KEY]) {
    state.hideReaderSaved = changes[HIDE_READER_SAVED_KEY].newValue ?? false;
    updateReaderSavedToggle();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
  }

  if (changes[HIDE_DOWNIE_SENT_KEY]) {
    state.hideDownieSent = changes[HIDE_DOWNIE_SENT_KEY].newValue ?? false;
    updateDownieSentToggle();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
    renderFeed();
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
    renderLists();
    updateHeader(getChannelsForSelection().length, getFilteredItems().length);
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
