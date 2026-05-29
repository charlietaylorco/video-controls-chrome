const STORAGE_KEY = 'ytLists';
const HIDE_FEED_VIDEOS_KEY = 'ytListsHideFeedVideos';
const BUTTON_ID = 'yt-lists-button';
const BUTTON_WRAPPER_ID = 'yt-lists-button-wrapper';
const PANEL_ID = 'yt-lists-panel';
const STYLE_ID = 'yt-lists-style';
const FEED_FOCUS_OVERLAY_ID = 'yt-lists-feed-focus';
const FEED_FOCUS_CLASS = 'ytl-hide-feed-videos';
const INLINE_CLASS = 'ytl-inline';
const FLOATING_CLASS = 'ytl-floating';
const FEED_REVEAL_DELAY_MS = 30000;
const FEED_REVEAL_DELAY_SECONDS = FEED_REVEAL_DELAY_MS / 1000;
const SYNC_KEYS = new Set([STORAGE_KEY, HIDE_FEED_VIDEOS_KEY]);
const OPEN_FEED_MESSAGE = 'ytListsOpenFeed';

let lastChannelId = null;
let lastUrl = '';
let initToken = 0;
let initTimer = null;
let currentChannel = null;
let hideFeedVideos = false;
let temporaryFeedReveal = false;
let feedRevealTimer = null;
let feedRevealCountdownTimer = null;
let feedRevealDeadline = 0;

function isExtensionContextInvalidated(error) {
  const message = typeof error === 'string'
    ? error
    : error?.message || '';
  return /Extension context invalidated/i.test(message);
}

function getRuntimeLastError() {
  try {
    return chrome?.runtime?.lastError || null;
  } catch (error) {
    return error;
  }
}

function getStorageArea(area) {
  try {
    return chrome?.storage?.[area] || null;
  } catch (error) {
    return null;
  }
}

function getExtensionUrl(path, fallback = '#') {
  try {
    return chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : fallback;
  } catch (error) {
    return fallback;
  }
}

async function openFeedPage() {
  try {
    await chrome.runtime.sendMessage({ type: OPEN_FEED_MESSAGE });
  } catch (error) {
    if (swallowInvalidatedContextError(error)) return;
    window.open(getExtensionUrl('feed.html'), '_blank', 'noopener');
  }
}

function swallowInvalidatedContextError(error) {
  return isExtensionContextInvalidated(error);
}

function runAsync(task) {
  Promise.resolve()
    .then(task)
    .catch((error) => {
      if (!swallowInvalidatedContextError(error)) {
        console.error(error);
      }
    });
}

function getStorage(key, fallback) {
  return new Promise((resolve) => {
    const localArea = getStorageArea('local');
    if (!localArea) {
      resolve(fallback);
      return;
    }

    try {
      localArea.get([key], (localResult = {}) => {
        const localError = getRuntimeLastError();
        if (localError) {
          resolve(fallback);
          return;
        }

        if (Object.prototype.hasOwnProperty.call(localResult, key)) {
          resolve(localResult[key]);
          return;
        }

        if (!SYNC_KEYS.has(key)) {
          resolve(fallback);
          return;
        }

        const syncArea = getStorageArea('sync');
        if (!syncArea) {
          resolve(fallback);
          return;
        }

        try {
          syncArea.get([key], (syncResult = {}) => {
            const syncError = getRuntimeLastError();
            if (syncError) {
              resolve(fallback);
              return;
            }

            if (Object.prototype.hasOwnProperty.call(syncResult, key)) {
              const value = syncResult[key];
              setStorage(key, value).then(() => resolve(value));
              return;
            }

            resolve(fallback);
          });
        } catch (error) {
          resolve(fallback);
        }
      });
    } catch (error) {
      resolve(fallback);
    }
  });
}

function setStorage(key, value) {
  return new Promise((resolve) => {
    const localArea = getStorageArea('local');
    if (!localArea) {
      resolve();
      return;
    }

    try {
      localArea.set({ [key]: value }, () => {
        const localError = getRuntimeLastError();
        if (localError) {
          resolve();
          return;
        }

        if (!SYNC_KEYS.has(key)) {
          resolve();
          return;
        }

        const syncArea = getStorageArea('sync');
        if (!syncArea) {
          resolve();
          return;
        }

        try {
          syncArea.set({ [key]: value }, () => {
            const syncError = getRuntimeLastError();
            if (syncError && !isExtensionContextInvalidated(syncError)) {
              console.warn('Sync save failed:', syncError.message);
            }
            resolve();
          });
        } catch (error) {
          resolve();
        }
      });
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) {
        console.warn('Local save failed:', error.message);
      }
      resolve();
    }
  });
}

function createId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  if (!document.documentElement) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID} {
      font-family: Roboto, Arial, sans-serif;
      white-space: nowrap;
      box-sizing: border-box;
      border: 0;
      cursor: pointer;
      text-decoration: none;
      -webkit-tap-highlight-color: transparent;
    }

    #${BUTTON_WRAPPER_ID} {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
    }

    #${BUTTON_ID}.${INLINE_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 0 16px;
      margin: 0 0 0 8px;
      flex: 0 0 auto;
      width: auto;
      min-width: auto;
      border-radius: 18px;
      background: rgba(0, 0, 0, 0.05);
      color: #0f0f0f;
      font-size: 14px;
      font-weight: 500;
      line-height: 36px;
    }

    #${BUTTON_ID}.${INLINE_CLASS}:hover {
      background: rgba(0, 0, 0, 0.1);
    }

    #${BUTTON_ID}.${INLINE_CLASS}:active {
      background: rgba(0, 0, 0, 0.14);
    }

    #${BUTTON_ID}.${INLINE_CLASS}:focus-visible {
      outline: 2px solid #065fd4;
      outline-offset: 2px;
    }

    html[dark] #${BUTTON_ID}.${INLINE_CLASS},
    [dark] #${BUTTON_ID}.${INLINE_CLASS} {
      background: rgba(255, 255, 255, 0.1);
      color: #f1f1f1;
    }

    html[dark] #${BUTTON_ID}.${INLINE_CLASS}:hover,
    [dark] #${BUTTON_ID}.${INLINE_CLASS}:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    #${BUTTON_ID}.${FLOATING_CLASS} {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99999;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid #d3d3d3;
      background: #ffffff;
      color: #0f0f0f;
      font-weight: 500;
      cursor: pointer;
      font-size: 13px;
    }

    #${BUTTON_ID}.${FLOATING_CLASS}:hover {
      background: #f2f2f2;
    }

    #${PANEL_ID} {
      position: fixed;
      width: 280px;
      border-radius: 12px;
      border: 1px solid #d3d3d3;
      background: #ffffff;
      padding: 12px;
      z-index: 99999;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      color: #0f0f0f;
      font-family: Roboto, Arial, sans-serif;
      font-size: 13px;
    }

    #${PANEL_ID} .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      margin-bottom: 8px;
    }

    #${PANEL_ID} .panel-close {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 16px;
      color: #606060;
    }

    #${PANEL_ID} .panel-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 10px;
      max-height: 220px;
      overflow: auto;
      padding-right: 2px;
    }

    #${PANEL_ID} .panel-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 0;
    }

    #${PANEL_ID} .panel-row span {
      flex: 1;
      min-width: 0;
    }

    #${PANEL_ID} .panel-action {
      border: 1px solid #d3d3d3;
      border-radius: 999px;
      padding: 4px 12px;
      background: #ffffff;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      height: 28px;
    }

    #${PANEL_ID} .panel-action[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #${PANEL_ID} .panel-action.remove {
      border-color: rgba(204, 0, 0, 0.3);
      color: #c00;
    }

    #${PANEL_ID} .panel-input {
      width: 100%;
      box-sizing: border-box;
      display: block;
      border: 1px solid #d3d3d3;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      margin-bottom: 6px;
    }

    html.${FEED_FOCUS_CLASS} ytd-browse[page-subtype="home"] #primary,
    html.${FEED_FOCUS_CLASS} ytd-browse[page-subtype="subscriptions"] #primary {
      display: none !important;
    }

    #${FEED_FOCUS_OVERLAY_ID} {
      position: fixed;
      top: 96px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2000;
      width: min(520px, calc(100vw - 32px));
      border-radius: 18px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: rgba(255, 255, 255, 0.96);
      color: #0f0f0f;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.18);
      padding: 18px 20px;
      font-family: Roboto, Arial, sans-serif;
      backdrop-filter: blur(12px);
    }

    #${FEED_FOCUS_OVERLAY_ID}[hidden] {
      display: none !important;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-kicker {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #606060;
      margin-bottom: 8px;
      font-weight: 700;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-title {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 6px;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-copy {
      font-size: 14px;
      line-height: 1.5;
      color: #303030;
      margin-bottom: 14px;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-status {
      font-size: 12px;
      line-height: 1.5;
      color: #606060;
      margin-bottom: 14px;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid #d3d3d3;
      background: #ffffff;
      color: #0f0f0f;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    #${FEED_FOCUS_OVERLAY_ID} .focus-action.primary {
      background: #0f0f0f;
      color: #ffffff;
      border-color: #0f0f0f;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function normalizePath(pathname = location.pathname || '') {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function isFeedFocusPage() {
  const path = normalizePath();
  return path === '/' || path === '/feed/subscriptions';
}

function getFeedFocusLabel() {
  return normalizePath() === '/feed/subscriptions' ? 'Subscriptions hidden' : 'Home hidden';
}

function getFeedFocusMessage() {
  return normalizePath() === '/feed/subscriptions'
    ? 'Your subscriptions feed is hidden for focused browsing. Use YT Lists when you want a deliberate pass through new uploads.'
    : 'YouTube recommendations are hidden for focused browsing. Use YT Lists when you want to choose what to watch on purpose.';
}

function getFeedFocusOverlay() {
  let overlay = document.getElementById(FEED_FOCUS_OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = FEED_FOCUS_OVERLAY_ID;
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="focus-kicker"></div>
    <div class="focus-title">Focus mode is on</div>
    <div class="focus-copy"></div>
    <div class="focus-status"></div>
    <div class="focus-actions">
      <button type="button" class="focus-action primary" data-action="reveal">Show videos on this page</button>
      <button type="button" class="focus-action" data-action="open-feed">Open YT Lists</button>
    </div>
  `;

  overlay.querySelector('[data-action="reveal"]')?.addEventListener('click', () => {
    if (feedRevealDeadline) {
      clearFeedRevealCountdown();
      applyFeedFocusMode();
      return;
    }
    startFeedRevealCountdown();
  });
  overlay.querySelector('[data-action="open-feed"]')?.addEventListener('click', () => {
    runAsync(openFeedPage);
  });

  (document.body || document.documentElement).appendChild(overlay);
  return overlay;
}

function removeFeedFocusOverlay() {
  const overlay = document.getElementById(FEED_FOCUS_OVERLAY_ID);
  if (overlay) overlay.remove();
}

function clearFeedRevealCountdown() {
  if (feedRevealTimer) {
    clearTimeout(feedRevealTimer);
    feedRevealTimer = null;
  }
  if (feedRevealCountdownTimer) {
    clearInterval(feedRevealCountdownTimer);
    feedRevealCountdownTimer = null;
  }
  feedRevealDeadline = 0;
}

function getFeedRevealSecondsRemaining() {
  if (!feedRevealDeadline) return 0;
  return Math.max(0, Math.ceil((feedRevealDeadline - Date.now()) / 1000));
}

function updateFeedFocusOverlayContent() {
  const overlay = getFeedFocusOverlay();
  const kicker = overlay.querySelector('.focus-kicker');
  const copy = overlay.querySelector('.focus-copy');
  const status = overlay.querySelector('.focus-status');
  const revealButton = overlay.querySelector('[data-action="reveal"]');
  const secondsRemaining = getFeedRevealSecondsRemaining();
  const isPendingReveal = feedRevealDeadline > 0;

  if (kicker) kicker.textContent = getFeedFocusLabel();
  if (copy) copy.textContent = getFeedFocusMessage();
  if (status) {
    status.textContent = isPendingReveal
      ? `Videos will appear in ${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'} unless you close the tab or cancel.`
      : `Showing videos takes ${FEED_REVEAL_DELAY_SECONDS} seconds, so you have a moment to change your mind.`;
  }
  if (revealButton) {
    revealButton.textContent = isPendingReveal
      ? `Cancel reveal (${secondsRemaining}s)`
      : 'Show videos on this page';
    revealButton.setAttribute('aria-pressed', isPendingReveal ? 'true' : 'false');
  }
}

function startFeedRevealCountdown() {
  clearFeedRevealCountdown();
  feedRevealDeadline = Date.now() + FEED_REVEAL_DELAY_MS;
  updateFeedFocusOverlayContent();
  feedRevealCountdownTimer = window.setInterval(() => {
    if (!feedRevealDeadline) return;
    if (Date.now() >= feedRevealDeadline) return;
    updateFeedFocusOverlayContent();
  }, 250);
  feedRevealTimer = window.setTimeout(() => {
    clearFeedRevealCountdown();
    temporaryFeedReveal = true;
    applyFeedFocusMode();
  }, FEED_REVEAL_DELAY_MS);
}

function applyFeedFocusMode() {
  const shouldHide = hideFeedVideos && isFeedFocusPage() && !temporaryFeedReveal;
  document.documentElement.classList.toggle(FEED_FOCUS_CLASS, shouldHide);

  if (!shouldHide) {
    removeFeedFocusOverlay();
    return;
  }

  const overlay = getFeedFocusOverlay();
  updateFeedFocusOverlayContent();
  overlay.hidden = false;
}

function primeFeedFocusMode() {
  injectStyles();
  if (!isFeedFocusPage()) return;
  getStorage(HIDE_FEED_VIDEOS_KEY, false).then((value) => {
    hideFeedVideos = value ?? false;
    applyFeedFocusMode();
  });
}

function extractChannelIdFromUrl(url) {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url, location.origin).pathname;
  } catch (error) {
    path = url;
  }
  const match = path.match(/^\/channel\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function getChannelBasePath(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0];
  if (first.startsWith('@')) return `/${first}`;
  if (first === 'channel' && parts[1]) return `/channel/${parts[1]}`;
  if (first === 'c' && parts[1]) return `/c/${parts[1]}`;
  if (first === 'user' && parts[1]) return `/user/${parts[1]}`;
  return `/${first}`;
}

function extractHandleFromPath(path) {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0];
  return first.startsWith('@') ? first : null;
}

function isLikelyChannelId(id) {
  return typeof id === 'string' && id.startsWith('UC');
}

function isChannelPath(path) {
  if (!path) return false;
  return path.startsWith('/channel/')
    || path.startsWith('/@')
    || path.startsWith('/c/')
    || path.startsWith('/user/');
}

function findChannelIdFromAnchors() {
  const anchors = document.querySelectorAll(
    '#page-header a[href*="/channel/"], ytd-tabbed-page-header a[href*="/channel/"], ytd-channel-name a[href*="/channel/"]'
  );
  for (const anchor of anchors) {
    const id = extractChannelIdFromUrl(anchor.getAttribute('href'));
    if (id) return id;
  }
  return null;
}

function findChannelNameFromHeader() {
  const nameEl = document.querySelector(
    '#page-header h1 span, #page-header h1, .yt-page-header-view-model__page-header-title span, ytd-channel-name #text'
  );
  return nameEl?.textContent?.trim() || null;
}

function findAvatarFromHeader() {
  const avatarEl = document.querySelector(
    '#page-header img.yt-spec-avatar-shape__image, #page-header img, ytd-channel-name img, #avatar img'
  );
  return avatarEl?.src || '';
}

function extractFromDoc(doc, selector, attribute) {
  const el = doc.querySelector(selector);
  if (!el) return null;
  return attribute ? el.getAttribute(attribute) : el.textContent;
}

function extractChannelIdFromDoc(doc) {
  return extractFromDoc(doc, 'meta[itemprop="channelId"]', 'content')
    || extractFromDoc(doc, 'meta[itemprop="identifier"]', 'content')
    || extractFromDoc(doc, '[data-channel-external-id]', 'data-channel-external-id')
    || null;
}

function extractChannelNameFromDoc(doc) {
  return extractFromDoc(doc, 'meta[property="og:title"]', 'content')
    || extractFromDoc(doc, 'meta[itemprop="name"]', 'content')
    || null;
}

function extractAvatarFromDoc(doc) {
  return extractFromDoc(doc, 'meta[property="og:image"]', 'content') || '';
}

async function resolveChannelFromUrl(url, fallbackName, fallbackAvatar) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const id = extractChannelIdFromDoc(doc);
    if (!id) return null;
    const name = fallbackName || extractChannelNameFromDoc(doc) || 'Unknown channel';
    const avatarUrl = fallbackAvatar || extractAvatarFromDoc(doc) || '';
    return { id, name, avatarUrl };
  } catch (error) {
    return null;
  }
}

async function getChannelContext() {
  const path = location.pathname || '';
  if (!isChannelPath(path)) return null;

  const basePath = getChannelBasePath(path);
  const handleFromPath = extractHandleFromPath(basePath || path);

  const metaChannel = document.querySelector('meta[itemprop="channelId"]');
  const identifierChannel = document.querySelector('meta[itemprop="identifier"]');
  const dataChannel = document.querySelector('[data-channel-external-id]')?.getAttribute('data-channel-external-id');
  const channelUrl = new URL(basePath || path || location.href, location.origin).toString();

  const channelId = metaChannel?.content
    || identifierChannel?.content
    || dataChannel
    || findChannelIdFromAnchors()
    || extractChannelIdFromUrl(path)
    || extractChannelIdFromUrl(channelUrl)
    || handleFromPath
    || null;

  const channelName = findChannelNameFromHeader()
    || document.querySelector('meta[property="og:title"]')?.content
    || document.querySelector('meta[itemprop="name"]')?.content
    || null;

  const avatarUrl = findAvatarFromHeader()
    || document.querySelector('meta[property="og:image"]')?.content
    || '';

  if (channelUrl && (!channelId || !isLikelyChannelId(channelId))) {
    const resolved = await resolveChannelFromUrl(channelUrl, channelName, avatarUrl);
    return resolved ? { ...resolved, url: channelUrl } : null;
  }

  if (channelId && channelName) {
    return { id: channelId, name: channelName, avatarUrl, url: channelUrl };
  }

  return null;
}

function findMountTarget() {
  const existingButton = getButton();
  const actionRow = document.querySelector(
    [
      'yt-flexible-actions-view-model.ytFlexibleActionsViewModelHost',
      'yt-flexible-actions-view-model',
      '.ytFlexibleActionsViewModelHost',
      '.ytPageHeaderViewModelFlexibleActions',
      '.yt-page-header-view-model__page-header-flexible-actions .ytFlexibleActionsViewModelActionRow',
      '.yt-page-header-view-model__page-header-flexible-actions .yt-flexible-actions-view-model-wiz__action-row',
      '.ytFlexibleActionsViewModelActionRow',
      '.yt-flexible-actions-view-model-wiz__action-row'
    ].join(', ')
  );
  if (actionRow) return actionRow;

  const subscribeControl = Array.from(document.querySelectorAll(
    [
      'ytd-subscribe-button-renderer',
      '#subscribe-button',
      'button[aria-label*="Subscribe" i]',
      'button[aria-label*="Subscribed" i]',
      'button[title*="Subscribe" i]',
      'button[title*="Subscribed" i]'
    ].join(', ')
  )).find((element) => element !== existingButton && !element.contains(existingButton));

  const subscribeAction = subscribeControl?.closest(
    '.ytFlexibleActionsViewModelAction, .yt-flexible-actions-view-model-wiz__action, button-view-model, ytd-subscribe-button-renderer'
  );
  const subscribeRow = subscribeAction?.parentElement;
  if (subscribeRow && !subscribeRow.matches('body, html, ytd-app')) {
    if (subscribeRow.matches('yt-flexible-actions-view-model, .ytFlexibleActionsViewModelHost, .ytPageHeaderViewModelFlexibleActions')) {
      return subscribeRow;
    }
    if (subscribeRow.querySelector(':scope > .ytFlexibleActionsViewModelAction')) {
      return subscribeRow;
    }
  }

  const actions = document.querySelector(
    '.yt-page-header-view-model__page-header-flexible-actions, .ytPageHeaderViewModelFlexibleActions'
  );
  if (actions) return actions;

  const headerButtons = document.querySelector(
    '#buttons.ytd-c4-tabbed-header-renderer, #buttons.ytd-channel-header-renderer'
  );
  if (headerButtons) return headerButtons;

  const subscribeRenderer = document.querySelector('ytd-subscribe-button-renderer');
  if (subscribeRenderer?.parentElement) return subscribeRenderer.parentElement;
  if (subscribeRenderer) return subscribeRenderer;

  const subscribeButton = document.querySelector('#subscribe-button');
  if (subscribeButton?.parentElement) return subscribeButton.parentElement;
  if (subscribeButton) return subscribeButton;

  const ownerSubscribe = document.querySelector('#owner #subscribe-button');
  if (ownerSubscribe?.parentElement) return ownerSubscribe.parentElement;

  const ownerBlock = document.querySelector('#top-row #owner, #owner');
  if (ownerBlock) return ownerBlock;

  return null;
}

function getButton() {
  return document.getElementById(BUTTON_ID);
}

function getButtonWrapper() {
  return document.getElementById(BUTTON_WRAPPER_ID);
}

function removePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
}

function removeButton() {
  const wrapper = getButtonWrapper();
  if (wrapper) {
    wrapper.remove();
    return;
  }
  const button = getButton();
  if (button) button.remove();
}

function mountButton(channel) {
  let button = getButton();
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Add to list';
    button.classList.add(
      'yt-spec-button-shape-next',
      'yt-spec-button-shape-next--tonal',
      'yt-spec-button-shape-next--mono',
      'yt-spec-button-shape-next--size-m'
    );
  }
  button.onclick = (event) => {
    event.stopPropagation();
    event.preventDefault();
    const context = currentChannel || channel;
    if (!context) return;
    togglePanel(context, button.getBoundingClientRect());
  };

  const target = findMountTarget();
  if (target) {
    button.classList.add(INLINE_CLASS);
    button.classList.remove(FLOATING_CLASS);
    const shouldWrap = target.matches(
      'yt-flexible-actions-view-model, .ytFlexibleActionsViewModelHost, .ytPageHeaderViewModelFlexibleActions'
    );
    const node = shouldWrap ? (getButtonWrapper() || document.createElement('div')) : button;

    if (shouldWrap) {
      node.id = BUTTON_WRAPPER_ID;
      node.className = 'ytFlexibleActionsViewModelAction';
      if (!node.contains(button)) {
        node.appendChild(button);
      }
    } else {
      const wrapper = getButtonWrapper();
      if (wrapper) wrapper.replaceWith(button);
    }

    if (!target.contains(node)) {
      target.appendChild(node);
    }
  } else {
    button.classList.remove(INLINE_CLASS);
    button.classList.add(FLOATING_CLASS);
    const wrapper = getButtonWrapper();
    if (wrapper) wrapper.replaceWith(button);
    if (!document.body.contains(button)) {
      document.body.appendChild(button);
    }
  }
}

async function togglePanel(channel, anchorRect) {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const lists = (await getStorage(STORAGE_KEY, [])) || [];
  const panel = document.createElement('div');
  panel.id = PANEL_ID;

  const header = document.createElement('div');
  header.className = 'panel-header';

  const title = document.createElement('span');
  title.textContent = `Add ${channel.name}`;

  const close = document.createElement('button');
  close.className = 'panel-close';
  close.type = 'button';
  close.textContent = 'x';
  close.addEventListener('click', removePanel);

  header.append(title, close);
  panel.appendChild(header);

  const listWrapper = document.createElement('div');
  listWrapper.className = 'panel-list';

  if (!lists.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No lists yet. Create one below.';
    listWrapper.appendChild(empty);
  } else {
    lists.forEach((list) => {
      const row = document.createElement('div');
      row.className = 'panel-row';

      const name = document.createElement('span');
      name.textContent = list.name;

      const action = document.createElement('button');
      action.className = 'panel-action';
      action.type = 'button';

      let isInList = (list.channels || []).some((entry) => (
        entry.id === channel.id || (entry.url && channel.url && entry.url === channel.url)
      ));
      const updateActionState = () => {
        action.textContent = isInList ? 'Remove' : 'Add';
        action.classList.toggle('remove', isInList);
      };
      updateActionState();

      action.addEventListener('click', async () => {
        list.channels = list.channels || [];
        if (isInList) {
          list.channels = list.channels.filter((entry) => !(
            entry.id === channel.id || (entry.url && channel.url && entry.url === channel.url)
          ));
          await setStorage(STORAGE_KEY, lists);
          isInList = false;
          updateActionState();
          return;
        }

        list.channels.push(channel);
        await setStorage(STORAGE_KEY, lists);
        isInList = true;
        updateActionState();
      });

      row.append(name, action);
      listWrapper.appendChild(row);
    });
  }

  panel.appendChild(listWrapper);

  const input = document.createElement('input');
  input.className = 'panel-input';
  input.type = 'text';
  input.placeholder = 'New list name';

  const create = document.createElement('button');
  create.className = 'panel-action';
  create.type = 'button';
  create.textContent = 'Create & add';
  create.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    const newList = { id: createId(), name, channels: [channel] };
    lists.push(newList);
    await setStorage(STORAGE_KEY, lists);
    removePanel();
  });

  panel.append(input, create);
  document.body.appendChild(panel);

  const left = Math.min(anchorRect.left, window.innerWidth - 280);
  panel.style.top = `${Math.min(anchorRect.bottom + 8, window.innerHeight - 260)}px`;
  panel.style.left = `${Math.max(12, left)}px`;

  const handleOutside = (event) => {
    const button = getButton();
    if (!panel.contains(event.target) && !button.contains(event.target)) {
      removePanel();
      document.removeEventListener('click', handleOutside, true);
    }
  };

  document.addEventListener('click', handleOutside, true);
}

async function init() {
  injectStyles();
  hideFeedVideos = (await getStorage(HIDE_FEED_VIDEOS_KEY, false)) ?? false;
  applyFeedFocusMode();

  const token = ++initToken;
  const context = await getChannelContext();
  if (token !== initToken) return;
  if (!context) {
    removePanel();
    removeButton();
    lastChannelId = null;
    currentChannel = null;
    return;
  }

  if (context.id !== lastChannelId) {
    removePanel();
    lastChannelId = context.id;
  }

  currentChannel = context;
  mountButton(context);
}

function handleNavigation() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    clearFeedRevealCountdown();
    temporaryFeedReveal = false;
    runAsync(init);
    return;
  }
  if (!initTimer) {
    initTimer = window.setTimeout(() => {
      initTimer = null;
      runAsync(init);
    }, 250);
  }
}

window.addEventListener('yt-navigate-finish', () => {
  runAsync(init);
});
window.addEventListener('popstate', () => {
  runAsync(init);
});
window.addEventListener('load', () => {
  runAsync(init);
});

const observer = new MutationObserver(() => {
  handleNavigation();
});

observer.observe(document.documentElement, { childList: true, subtree: true });

primeFeedFocusMode();

window.addEventListener('unhandledrejection', (event) => {
  if (swallowInvalidatedContextError(event.reason)) {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  if (swallowInvalidatedContextError(event.error || event.message)) {
    event.preventDefault();
  }
});

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
      const localArea = getStorageArea('local');
      if (localArea) {
        try {
          localArea.set(mirror);
        } catch (error) {
          if (!isExtensionContextInvalidated(error)) {
            console.warn('Sync mirror failed:', error.message);
          }
        }
      }
    }
  }

  if (changes[HIDE_FEED_VIDEOS_KEY]) {
    hideFeedVideos = changes[HIDE_FEED_VIDEOS_KEY].newValue ?? false;
    if (!hideFeedVideos) {
      clearFeedRevealCountdown();
    }
    if (hideFeedVideos) {
      temporaryFeedReveal = false;
    }
    applyFeedFocusMode();
  }
});

runAsync(init);
