(() => {
  if (window.__minimalVideoSpeedInitialized) {
    return;
  }

  window.__minimalVideoSpeedInitialized = true;

  const videoState = new WeakMap();
  const settings = {
    hoverSpeed: 1,
    adjustmentStep: 0.1,
    showDownie: true,
    showReader: true
  };
  let activeVideo = null;
  let activeTarget = null;
  let activeAnchor = null;
  let activeMetadataTarget = null;
  let activeMode = "player";
  let hoveredVideo = null;
  let hoveredTarget = null;
  let activePanel = false;
  let isApplyingRate = false;
  let hideTimer = 0;
  let previewVideo = null;
  const extensionApi =
    typeof chrome !== "undefined"
      ? chrome
      : typeof browser !== "undefined"
        ? browser
        : null;
  const runtimeApi = extensionApi?.runtime ?? null;
  const storageApi = extensionApi?.storage ?? null;
  const RATE_PRECISION = 2;
  const RATE_EPSILON = 0.005;

  const roundRate = (value) => {
    const factor = 10 ** RATE_PRECISION;
    return Math.round(value * factor) / factor;
  };

  const formatRate = (value) => {
    const rounded = roundRate(value);
    return rounded.toFixed(RATE_PRECISION).replace(/\.?0+$/, "");
  };

  const isInvalidatedContextError = (error) =>
    String(error?.message || error).includes("Extension context invalidated");

  const safeEventHandler = (handler) => (event) => {
    try {
      const result = handler(event);

      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (!isInvalidatedContextError(error)) {
            console.error(error);
          }
        });
      }
    } catch (error) {
      if (!isInvalidatedContextError(error)) {
        console.error(error);
      }
    }
  };

  const clampRate = (value) => {
    const rounded = roundRate(value);
    return Math.min(16, Math.max(0.01, rounded));
  };

  const normalizeAdjustmentStep = (value) => {
    if (!Number.isFinite(value)) {
      return settings.adjustmentStep;
    }

    const rounded = roundRate(value);
    return Math.min(16, Math.max(0.01, rounded));
  };

  const getState = (video) => {
    if (!(video instanceof HTMLVideoElement)) {
      return { closed: false };
    }

    let state = videoState.get(video);

    if (!state) {
      state = { closed: false };
      videoState.set(video, state);
    }

    return state;
  };

  const host = document.createElement("div");
  host.id = "minimal-video-speed-root";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none"
  });
  document.documentElement.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
      }

      .panel {
        position: fixed;
        top: 0;
        left: 0;
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        padding: 6px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 12px;
        background: rgba(12, 12, 12, 0.82);
        box-shadow:
          0 10px 26px rgba(0, 0, 0, 0.3),
          inset 0 1px 0 rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        color: #f5f1e8;
        font-family: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
        letter-spacing: 0.02em;
        pointer-events: none;
        visibility: hidden;
        opacity: 0;
        transform: translate3d(0, -6px, 0);
        transition:
          opacity 120ms ease,
          transform 120ms ease;
      }

      .panel[data-visible="true"] {
        pointer-events: auto;
        visibility: visible;
        opacity: 1;
        transform: translate3d(0, 0, 0);
      }

      .panel[data-mode="card"] {
        padding: 5px;
        border-radius: 11px;
      }

      .controls {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .drag-handle {
        width: 24px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.05);
        color: rgba(245, 241, 232, 0.64);
        font-size: 10px;
        letter-spacing: -0.08em;
        cursor: grab;
        user-select: none;
        touch-action: none;
      }

      .drag-handle:hover {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(245, 241, 232, 0.86);
        transform: none;
      }

      .drag-handle:active,
      .drag-handle[data-dragging="true"] {
        cursor: grabbing;
        background: rgba(255, 255, 255, 0.16);
        color: rgba(245, 241, 232, 0.94);
        transform: none;
      }

      .panel[data-mode="card"] .controls {
        gap: 5px;
      }

      .feedback {
        display: none;
        min-height: 18px;
        padding: 0 2px;
        font-size: 10px;
        line-height: 1.2;
        color: rgba(245, 241, 232, 0.72);
      }

      .feedback[data-visible="true"] {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .feedback[data-kind="success"] {
        color: #d5ffe4;
      }

      .feedback[data-kind="error"] {
        color: #ffd6d6;
      }

      .feedback-link {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .feedback-link:hover {
        opacity: 0.9;
      }

      .readout {
        min-width: 46px;
        height: 30px;
        padding: 0 8px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.05);
        color: rgba(245, 241, 232, 0.92);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        line-height: 1;
        box-sizing: border-box;
      }

      .icon-button svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      .icon-button[data-status="success"] {
        background: rgba(199, 255, 219, 0.2);
        color: #d5ffe4;
      }

      .icon-button[data-status="error"] {
        background: rgba(255, 148, 148, 0.18);
        color: #ffd6d6;
      }

      button {
        appearance: none;
        border: 0;
        margin: 0;
        padding: 0;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        line-height: 1;
        transition:
          background-color 120ms ease,
          color 120ms ease,
          transform 120ms ease;
      }

      button:hover {
        background: rgba(255, 255, 255, 0.16);
        transform: translateY(-1px);
      }

      button:active {
        transform: translateY(0);
      }

      button:disabled,
      button:disabled:hover,
      button:disabled:active {
        opacity: 0.42;
        cursor: default;
        transform: none;
        background: rgba(255, 255, 255, 0.05);
      }

      .preset[data-active="true"] {
        background: #f5f1e8;
        color: #0f0f0f;
      }

      .panel[data-mode="card"] .speed-control {
        display: none;
      }

      .panel[data-mode="card"] button {
        width: 28px;
        height: 28px;
      }

      .panel[data-mode="card"] .drag-handle {
        width: 24px;
      }

    </style>
    <div class="panel" data-visible="false" data-mode="player" aria-hidden="true">
      <div class="controls">
        <button class="drag-handle" type="button" aria-label="Drag controls" title="Drag controls">::</button>
        <button class="preset speed-control" data-rate="1" type="button">1x</button>
        <button class="preset speed-control" data-rate="2" type="button">2x</button>
        <button class="preset speed-control" data-rate="3" type="button">3x</button>
        <button class="adjust speed-control" data-action="decrease" type="button" aria-label="Decrease speed">-</button>
        <div class="readout speed-control" aria-live="polite">1.0x</div>
        <button class="adjust speed-control" data-action="increase" type="button" aria-label="Increase speed">+</button>
        <button class="icon-button" data-action="downie" type="button" aria-label="Open in Downie" title="Open in Downie">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v9"></path>
            <path d="m8.5 10.5 3.5 3.5 3.5-3.5"></path>
            <path d="M5 18h14"></path>
          </svg>
        </button>
        <button class="icon-button" data-action="reader" type="button" aria-label="Save page to Reader" title="Save page to Reader">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 4.5h8A1.5 1.5 0 0 1 17.5 6v13l-5.5-3.25L6.5 19V6A1.5 1.5 0 0 1 8 4.5Z"></path>
          </svg>
        </button>
      </div>
      <div class="feedback" aria-live="polite" data-visible="false">
        <span class="feedback-text"></span>
        <a class="feedback-link" href="" target="_blank" rel="noreferrer" hidden>Open</a>
      </div>
    </div>
  `;

  const panel = shadowRoot.querySelector(".panel");
  const presetButtons = Array.from(shadowRoot.querySelectorAll(".preset"));
  const readout = shadowRoot.querySelector(".readout");
  const feedback = shadowRoot.querySelector(".feedback");
  const feedbackText = shadowRoot.querySelector(".feedback-text");
  const feedbackLink = shadowRoot.querySelector(".feedback-link");
  const dragHandle = shadowRoot.querySelector(".drag-handle");
  const downieButton = shadowRoot.querySelector('[data-action="downie"]');
  const readerButton = shadowRoot.querySelector('[data-action="reader"]');
  let buttonStatusTimer = 0;
  let feedbackTimer = 0;
  let feedbackTarget = null;
  let dragState = null;
  let overlayPositionX = null;
  let overlayPositionY = null;
  const PANEL_MARGIN = 10;
  const VIEWPORT_MARGIN = 8;
  const MIN_MEDIA_WIDTH = 80;
  const MIN_MEDIA_HEIGHT = 45;

  const clearHideTimer = () => {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  };

  const getBaseRate = (video) => {
    const state = getState(video);
    return Number.isFinite(state.baseRate) ? state.baseRate : clampRate(video.playbackRate || 1);
  };

  const setPlaybackRate = (video, rate) => {
    isApplyingRate = true;
    video.playbackRate = rate;
    video.defaultPlaybackRate = rate;
    isApplyingRate = false;
  };

  const stopPreview = () => {
    if (!previewVideo || !previewVideo.isConnected) {
      previewVideo = null;
      return;
    }

    const video = previewVideo;
    const baseRate = getBaseRate(video);
    previewVideo = null;
    setPlaybackRate(video, baseRate);

    if (video === activeVideo) {
      updateUi(video);
    }
  };

  const startPreview = (video) => {
    if (!video || settings.hoverSpeed === 0) {
      stopPreview();
      return;
    }

    if (previewVideo && previewVideo !== video) {
      stopPreview();
    }

    const previewRate = clampRate(settings.hoverSpeed);
    const baseRate = getBaseRate(video);
    getState(video).baseRate = baseRate;

    previewVideo = video;

    if (Math.abs(video.playbackRate - previewRate) < RATE_EPSILON) {
      return;
    }

    setPlaybackRate(video, previewRate);
  };

  const hidePanel = () => {
    clearHideTimer();
    stopPreview();
    clearFeedback();
    dragState = null;
    overlayPositionX = null;
    overlayPositionY = null;
    delete dragHandle.dataset.dragging;
    panel.dataset.visible = "false";
    panel.dataset.mode = "player";
    panel.setAttribute("aria-hidden", "true");
    activeVideo = null;
    activeTarget = null;
    activeAnchor = null;
    activeMetadataTarget = null;
    activeMode = "player";
  };

  const getPanelBounds = () => {
    const panelRect = panel.getBoundingClientRect();
    return {
      width: panelRect.width || panel.offsetWidth || 0,
      height: panelRect.height || panel.offsetHeight || 0
    };
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const getRelativePanelOffset = (anchorRect) => {
    const { width: panelWidth, height: panelHeight } = getPanelBounds();
    const maxLeft = Math.max(0, anchorRect.width - panelWidth);
    const maxTop = Math.max(0, anchorRect.height - panelHeight);

    if (Number.isFinite(overlayPositionX) && Number.isFinite(overlayPositionY)) {
      return {
        left: clamp(overlayPositionX, 0, 1) * maxLeft,
        top: clamp(overlayPositionY, 0, 1) * maxTop
      };
    }

    return {
      left: Math.min(PANEL_MARGIN, maxLeft),
      top: Math.min(PANEL_MARGIN, maxTop)
    };
  };

  const positionPanelWithinAnchor = (anchorRect) => {
    const { width: panelWidth, height: panelHeight } = getPanelBounds();
    const { left: relativeLeft, top: relativeTop } = getRelativePanelOffset(anchorRect);
    const minLeft = Math.max(VIEWPORT_MARGIN, anchorRect.left);
    const minTop = Math.max(VIEWPORT_MARGIN, anchorRect.top);
    const maxLeft = Math.max(minLeft, Math.min(anchorRect.right - panelWidth, window.innerWidth - panelWidth - VIEWPORT_MARGIN));
    const maxTop = Math.max(minTop, Math.min(anchorRect.bottom - panelHeight, window.innerHeight - panelHeight - VIEWPORT_MARGIN));

    panel.style.left = `${clamp(anchorRect.left + relativeLeft, minLeft, maxLeft)}px`;
    panel.style.top = `${clamp(anchorRect.top + relativeTop, minTop, maxTop)}px`;
  };

  const syncPanelPosition = () => {
    const anchor = activeAnchor || activeTarget || activeVideo;

    if (!anchor || !anchor.isConnected) {
      hidePanel();
      return;
    }

    const rect = anchor.getBoundingClientRect();

    if (rect.width < 40 || rect.height < 40 || rect.bottom <= 0 || rect.right <= 0) {
      hidePanel();
      return;
    }

    positionPanelWithinAnchor(rect);
  };

  const updateUi = (video) => {
    if (!video) {
      return;
    }

    const currentRate = getBaseRate(video);
    readout.textContent = `${formatRate(currentRate)}x`;

    presetButtons.forEach((button) => {
      const presetRate = Number(button.dataset.rate);
      button.dataset.active = String(Math.abs(currentRate - presetRate) < RATE_EPSILON);
    });
  };

  const updateControlsAvailability = (video) => {
    const isInteractive = Boolean(video);

    for (const button of [...presetButtons, ...shadowRoot.querySelectorAll(".adjust")]) {
      button.disabled = !isInteractive;
    }

    readout.style.opacity = isInteractive ? "1" : "0.7";
  };

  const updateIntegrationVisibility = () => {
    downieButton.hidden = !settings.showDownie;
    readerButton.hidden = !settings.showReader;
  };

  const refreshVisiblePanelMode = () => {
    if (panel.dataset.visible !== "true") {
      return;
    }

    panel.dataset.mode = resolvePanelMode(activeMode);
    syncPanelPosition();
  };

  const resolvePanelMode = (mode) => {
    if (mode !== "card") {
      return "player";
    }

    return settings.showDownie || settings.showReader ? "card" : "player";
  };

  const getCurrentContextSource = () => activeMetadataTarget || activeTarget || activeVideo;

  const showPanelForContext = ({ video, target, anchor, metadataTarget, mode }) => {
    if (!target) {
      return;
    }

    if (video && getState(video).closed) {
      return;
    }

    clearHideTimer();
    activeVideo = video;
    activeTarget = target;
    activeAnchor = anchor || target || video;
    activeMetadataTarget = metadataTarget || target || video;
    activeMode = mode === "card" ? "card" : "player";
    panel.dataset.mode = resolvePanelMode(activeMode);
    updateControlsAvailability(video);

    if (video) {
      updateUi(video);
    } else {
      readout.textContent = "--";
      presetButtons.forEach((button) => {
        button.dataset.active = "false";
      });
    }

    syncPanelPosition();
    panel.dataset.visible = "true";
    panel.setAttribute("aria-hidden", "false");
  };

  const updateDragPosition = (clientX, clientY) => {
    if (!dragState) {
      return;
    }

    const anchor = activeAnchor || activeTarget || activeVideo;

    if (!anchor || !anchor.isConnected) {
      hidePanel();
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const { width: panelWidth, height: panelHeight } = getPanelBounds();
    const maxLeft = Math.max(0, anchorRect.width - panelWidth);
    const maxTop = Math.max(0, anchorRect.height - panelHeight);
    const relativeLeft = clamp(clientX - dragState.pointerOffsetX - anchorRect.left, 0, maxLeft);
    const relativeTop = clamp(clientY - dragState.pointerOffsetY - anchorRect.top, 0, maxTop);

    overlayPositionX = maxLeft > 0 ? relativeLeft / maxLeft : 0;
    overlayPositionY = maxTop > 0 ? relativeTop / maxTop : 0;
    positionPanelWithinAnchor(anchorRect);
  };

  const stopDragging = () => {
    if (!dragState) {
      return;
    }

    dragState = null;
    delete dragHandle.dataset.dragging;
    activePanel = panel.matches(":hover");

    if (!activePanel) {
      scheduleHide();
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      if (activePanel) {
        return;
      }

      if (
        activeTarget?.matches?.(":hover") ||
        activeAnchor?.matches?.(":hover") ||
        activeVideo?.matches?.(":hover")
      ) {
        return;
      }

      hidePanel();
    }, 80);
  };

  const applyRate = (video, nextRate) => {
    if (!video) {
      return;
    }

    const clampedRate = clampRate(nextRate);
    getState(video).baseRate = clampedRate;
    setPlaybackRate(video, clampedRate);
    updateUi(video);
  };

  const isPointInsideRect = (rect, clientX, clientY) =>
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;

  const getVideosFromNode = (node) => {
    if (!node) {
      return [];
    }

    if (node instanceof HTMLVideoElement) {
      return [node];
    }

    if (!(node instanceof Element)) {
      return [];
    }

    const videos = Array.from(node.querySelectorAll("video"));
    const shadowVideos = Array.from(node.shadowRoot?.querySelectorAll?.("video") || []);
    return [...videos, ...shadowVideos];
  };

  const CARD_CONTAINER_SELECTORS = [
    "ytd-rich-grid-media",
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytm-video-with-context-renderer",
    "ytm-rich-item-renderer"
  ].join(",");
  const THUMBNAIL_TARGET_SELECTORS = [
    "a#thumbnail",
    "ytd-thumbnail",
    "yt-thumbnail-view-model",
    "yt-image",
    "a[href*='/watch?']",
    "a[href*='/shorts/']",
    "a[href*='/live/']",
    "a[href*='youtu.be/']"
  ].join(",");
  const MEDIA_ANCHOR_SELECTORS = [
    "video",
    "img",
    "picture img",
    "canvas",
    "a#thumbnail",
    "ytd-thumbnail",
    "yt-thumbnail-view-model",
    '[class*="thumbnail"]',
    '[class*="Thumbnail"]',
    '[data-testid*="thumbnail"]'
  ].join(",");
  const VIDEO_URL_PATTERN = /(youtu\.be\/|\/watch(?:\?|$)|\/video\/|\/videos\/|\/shorts\/|\/live\/)/i;
  const CHANNEL_URL_PATTERN = /\/(@|channel\/|c\/|user\/)/i;
  const METADATA_CONTAINER_SELECTORS = [
    CARD_CONTAINER_SELECTORS,
    "article",
    "li",
    '[role="article"]',
    '[class*="card"]',
    '[class*="Card"]',
    '[class*="item"]',
    '[class*="Item"]',
    '[class*="video"]',
    '[class*="Video"]'
  ].join(",");

  const getAncestorElements = (node) => {
    const ancestors = [];
    let current = node instanceof Element ? node : null;

    while (current) {
      ancestors.push(current);

      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }

      const root = current.getRootNode?.();
      current = root instanceof ShadowRoot ? root.host : null;
    }

    return ancestors;
  };

  const isDailymotionPage = () => {
    try {
      const url = new URL(window.location.href);
      return ["dailymotion.com", "www.dailymotion.com"].includes(url.hostname);
    } catch {
      return false;
    }
  };

  const isCardHoverEnabledPage = () => isYouTubePage() || isDailymotionPage();

  const isRectVisible = (rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight;

  const getRectArea = (rect) => rect.width * rect.height;
  const getDistanceToRect = (rect, clientX, clientY) => {
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    return Math.hypot(dx, dy);
  };

  const getCardSourceCandidatesFromNode = (node) => {
    if (!isCardHoverEnabledPage() || !(node instanceof Element)) {
      return [];
    }

    const candidates = [];

    for (const ancestor of getAncestorElements(node).slice(0, 12)) {
      if (
        ancestor === document.body ||
        ancestor === document.documentElement ||
        ancestor === host
      ) {
        continue;
      }

      candidates.push(ancestor);
    }

    return candidates;
  };

  const getYouTubeCardCandidatesFromNode = (node) => {
    if (!isYouTubePage() || !(node instanceof Element)) {
      return [];
    }

    const candidates = [];

    for (const ancestor of getAncestorElements(node).slice(0, 12)) {
      if (ancestor === document.body || ancestor === document.documentElement || ancestor === host) {
        continue;
      }

      if (ancestor.matches?.(CARD_CONTAINER_SELECTORS)) {
        candidates.push({ source: ancestor, priority: 3 });
      }

      if (ancestor.matches?.(THUMBNAIL_TARGET_SELECTORS)) {
        candidates.push({ source: ancestor, priority: 2 });
      }

      if (ancestor.matches?.(VIDEO_PAGE_SELECTORS.join(","))) {
        candidates.push({ source: ancestor, priority: 1 });
      }
    }

    return candidates;
  };

  const pickClosestVideo = (videos, clientX, clientY) => {
    const containingVideos = videos
      .filter((video) => video.isConnected)
      .map((video) => ({ video, rect: video.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && isPointInsideRect(rect, clientX, clientY))
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

    return containingVideos[0]?.video || null;
  };

  const collectMediaAnchors = (source) => {
    if (!(source instanceof Element)) {
      return [];
    }

    const candidates = [];

    if (source instanceof HTMLVideoElement || source.matches?.(MEDIA_ANCHOR_SELECTORS)) {
      candidates.push(source);
    }

    for (const node of source.querySelectorAll(MEDIA_ANCHOR_SELECTORS)) {
      candidates.push(node);
    }

    for (const node of source.shadowRoot?.querySelectorAll?.(MEDIA_ANCHOR_SELECTORS) || []) {
      candidates.push(node);
    }

    return Array.from(new Set(candidates));
  };

  const getAssociatedAnchor = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    const anchors = [];

    if (source instanceof HTMLAnchorElement && source.href) {
      anchors.push(source);
    }

    for (const anchor of source.querySelectorAll("a[href]")) {
      anchors.push(anchor);
    }

    let bestAnchor = null;
    let bestScore = -Infinity;

    for (const anchor of anchors) {
      const absoluteUrl = resolveUrl(anchor.href);

      if (
        !absoluteUrl ||
        absoluteUrl.startsWith("javascript:") ||
        absoluteUrl.startsWith("mailto:") ||
        absoluteUrl.startsWith("tel:")
      ) {
        continue;
      }

      let score = 0;

      if (VIDEO_URL_PATTERN.test(absoluteUrl)) {
        score += 120;
      }

      if (CHANNEL_URL_PATTERN.test(absoluteUrl)) {
        score -= 60;
      }

      if (anchor.querySelector(MEDIA_ANCHOR_SELECTORS)) {
        score += 24;
      }

      const signalText = cleanText(
        anchor.getAttribute("title") ||
        anchor.getAttribute("aria-label") ||
        anchor.textContent
      );

      if (signalText) {
        score += 10;
      }

      const selectorSignal = `${anchor.id} ${anchor.className}`.toLowerCase();

      if (/(thumbnail|video-title|title)/.test(selectorSignal)) {
        score += 16;
      }

      if (score > bestScore) {
        bestScore = score;
        bestAnchor = anchor;
      }
    }

    return bestAnchor;
  };

  const getBestMediaAnchorForSource = (source, directVideo) => {
    if (!(source instanceof Element)) {
      return null;
    }

    const candidates = collectMediaAnchors(source)
      .filter((candidate) => candidate instanceof Element && source.contains(candidate))
      .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .filter(({ rect }) => isRectVisible(rect) && rect.width >= MIN_MEDIA_WIDTH && rect.height >= MIN_MEDIA_HEIGHT)
      .sort((a, b) => {
        const aIsVideo = a.candidate instanceof HTMLVideoElement;
        const bIsVideo = b.candidate instanceof HTMLVideoElement;

        if (aIsVideo !== bIsVideo) {
          return aIsVideo ? -1 : 1;
        }

        const areaDiff = getRectArea(b.rect) - getRectArea(a.rect);

        if (Math.abs(areaDiff) > 1) {
          return areaDiff;
        }

        return a.rect.top - b.rect.top;
      });

    if (
      directVideo instanceof HTMLVideoElement &&
      source.contains(directVideo) &&
      directVideo.isConnected
    ) {
      return directVideo;
    }

    return candidates[0]?.candidate || null;
  };

  const getVisibleMediaEntries = (source) =>
    collectMediaAnchors(source)
      .filter((candidate) => candidate instanceof Element && source.contains(candidate))
      .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .filter(({ rect }) => isRectVisible(rect) && rect.width >= MIN_MEDIA_WIDTH && rect.height >= MIN_MEDIA_HEIGHT);

  const getVideoLinkCount = (source) => {
    if (!(source instanceof Element)) {
      return 0;
    }

    let count = 0;

    for (const anchor of source.querySelectorAll("a[href]")) {
      const absoluteUrl = resolveUrl(anchor.href);

      if (absoluteUrl && VIDEO_URL_PATTERN.test(absoluteUrl)) {
        count += 1;
      }
    }

    return count;
  };

  const getMetadataContainerForSource = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    const directCardContainer = getVideoCardContainer(source);

    if (directCardContainer) {
      return directCardContainer;
    }

    const sourceArea = getRectArea(source.getBoundingClientRect());
    const viewportArea = window.innerWidth * window.innerHeight;

    for (const ancestor of getAncestorElements(source).slice(1, 10)) {
      if (
        ancestor === document.body ||
        ancestor === document.documentElement ||
        ancestor === host
      ) {
        continue;
      }

      if (!ancestor.matches?.(METADATA_CONTAINER_SELECTORS)) {
        continue;
      }

      const rect = ancestor.getBoundingClientRect();
      const area = getRectArea(rect);

      if (
        !isRectVisible(rect) ||
        area < sourceArea * 1.05 ||
        area > viewportArea * 0.45
      ) {
        continue;
      }

      return ancestor;
    }

    return null;
  };

  const getCardContextFromSource = (source, directVideo, clientX, clientY, options = {}) => {
    if (!(source instanceof Element)) {
      return null;
    }

    const sourceRect = source.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;

    if (
      !isPointInsideRect(sourceRect, clientX, clientY) ||
      !isRectVisible(sourceRect) ||
      sourceRect.width < MIN_MEDIA_WIDTH ||
      sourceRect.height < MIN_MEDIA_HEIGHT ||
      getRectArea(sourceRect) > viewportArea * 0.6
    ) {
      return null;
    }

    const anchor = getBestMediaAnchorForSource(source, directVideo);

    if (!(anchor instanceof Element)) {
      return null;
    }

    const anchorRect = anchor.getBoundingClientRect();

    if (
      !isRectVisible(anchorRect) ||
      anchorRect.width < MIN_MEDIA_WIDTH ||
      anchorRect.height < MIN_MEDIA_HEIGHT
    ) {
      return null;
    }

    const sourceArea = getRectArea(sourceRect);
    const anchorArea = getRectArea(anchorRect);
    const areaRatio = sourceArea / anchorArea;
    const metadataTarget = options.metadataTarget || getMetadataContainerForSource(source) || source;
    const metadataRect = metadataTarget.getBoundingClientRect();
    const metadataAreaRatio = getRectArea(metadataRect) / anchorArea;
    const isMediaOnlySource = source === anchor || areaRatio <= 1.05;
    const strictAreaRatio = options.strictAreaRatio ?? true;
    const priorityScore = options.priorityScore ?? 0;

    if (
      metadataAreaRatio <= 1.05 ||
      metadataAreaRatio > 8.5 ||
      (strictAreaRatio && areaRatio > 4.2 && metadataTarget === source)
    ) {
      return null;
    }

    const associatedAnchor = getAssociatedAnchor(metadataTarget) || getAssociatedAnchor(source);
    const associatedUrl = resolveUrl(associatedAnchor?.href);
    const hasVideoLikeLink = Boolean(associatedUrl && VIDEO_URL_PATTERN.test(associatedUrl));
    const previewVideo = directVideo instanceof HTMLVideoElement && source.contains(directVideo) ? directVideo : null;
    const maxLargeMediaCount = options.maxLargeMediaCount ?? (previewVideo ? 4 : 2);
    const maxVideoLinkCount = options.maxVideoLinkCount ?? (previewVideo ? 6 : 4);
    const mediaEntries = getVisibleMediaEntries(metadataTarget);
    const largeMediaCount = mediaEntries.filter(({ rect }) => getRectArea(rect) >= anchorArea * 0.33).length;
    const videoLinkCount = getVideoLinkCount(metadataTarget);
    const distanceToAnchor = getDistanceToRect(anchorRect, clientX, clientY);

    if (!previewVideo && !hasVideoLikeLink) {
      return null;
    }

    if (largeMediaCount > maxLargeMediaCount || videoLinkCount > maxVideoLinkCount) {
      return null;
    }

    if (isMediaOnlySource && metadataTarget === source && !previewVideo) {
      return null;
    }

    return {
      video: previewVideo,
      target: metadataTarget,
      anchor,
      metadataTarget,
      mode: "card",
      score:
        priorityScore +
        (previewVideo ? 160 : 0) +
        (hasVideoLikeLink ? 120 : 0) -
        metadataAreaRatio * 24 -
        largeMediaCount * 24 -
        videoLinkCount * 18 -
        (metadataTarget !== source ? 18 : 0) -
        distanceToAnchor * 0.12
    };
  };

  const getHoverContext = (event) => {
    const videoCandidates = new Set();
    const cardSourceCandidates = new Set();
    const youtubeCardCandidates = new Map();

    for (const node of event.composedPath()) {
      for (const video of getVideosFromNode(node)) {
        videoCandidates.add(video);
      }

      for (const candidate of getYouTubeCardCandidatesFromNode(node)) {
        const currentPriority = youtubeCardCandidates.get(candidate.source) || 0;
        youtubeCardCandidates.set(candidate.source, Math.max(currentPriority, candidate.priority));
      }

      for (const source of getCardSourceCandidatesFromNode(node)) {
        cardSourceCandidates.add(source);
      }
    }

    for (const node of document.elementsFromPoint(event.clientX, event.clientY)) {
      for (const video of getVideosFromNode(node)) {
        videoCandidates.add(video);
      }

      for (const candidate of getYouTubeCardCandidatesFromNode(node)) {
        const currentPriority = youtubeCardCandidates.get(candidate.source) || 0;
        youtubeCardCandidates.set(candidate.source, Math.max(currentPriority, candidate.priority));
      }

      for (const source of getCardSourceCandidatesFromNode(node)) {
        cardSourceCandidates.add(source);
      }
    }

    const video = pickClosestVideo(Array.from(videoCandidates), event.clientX, event.clientY);
    const youtubeCardContext = Array.from(youtubeCardCandidates.entries())
      .map(([source, priority]) =>
        getCardContextFromSource(source, video, event.clientX, event.clientY, {
          metadataTarget: getVideoCardContainer(source) || getMetadataContainerForSource(source) || source,
          strictAreaRatio: false,
          maxLargeMediaCount: 6,
          maxVideoLinkCount: 8,
          priorityScore: priority * 100
        })
      )
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        const aRect = a.target.getBoundingClientRect();
        const bRect = b.target.getBoundingClientRect();
        return getRectArea(aRect) - getRectArea(bRect);
      })[0];

    if (youtubeCardContext) {
      return youtubeCardContext;
    }

    const genericCardContext = Array.from(cardSourceCandidates)
      .map((source) => getCardContextFromSource(source, video, event.clientX, event.clientY))
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        const aRect = a.target.getBoundingClientRect();
        const bRect = b.target.getBoundingClientRect();
        return getRectArea(aRect) - getRectArea(bRect);
      })[0];

    if (genericCardContext) {
      return genericCardContext;
    }

    if (!video) {
      return null;
    }

    return {
      video,
      target: video,
      anchor: video,
      metadataTarget: video,
      mode: "player"
    };
  };

  const isCurrentPageVideoUrl = () => {
    try {
      const url = new URL(window.location.href);
      const isYoutubeHost = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(
        url.hostname
      );

      if (isYoutubeHost && (url.pathname === "/watch" || /^\/(shorts|live)\//.test(url.pathname))) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  const isYouTubePage = () => {
    try {
      const url = new URL(window.location.href);
      return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname);
    } catch {
      return false;
    }
  };

  const isYouTubeChannelPage = () => {
    try {
      const url = new URL(window.location.href);
      const isYoutubeHost = isYouTubePage();

      if (!isYoutubeHost) {
        return false;
      }

      return /^(\/@[^/]+|\/channel\/[^/]+|\/c\/[^/]+|\/user\/[^/]+)(\/.*)?$/.test(url.pathname);
    } catch {
      return false;
    }
  };

  const getMessageTimeout = (message) => {
    if (message?.type === "save-to-reader") {
      return 12000;
    }

    if (message?.type === "open-in-downie") {
      return 5000;
    }

    return 2000;
  };

  const sendRuntimeMessage = (message) =>
    new Promise((resolve) => {
      if (!runtimeApi?.sendMessage) {
        resolve({
          response: null,
          error: "runtime_unavailable"
        });
        return;
      }

      let settled = false;
      const finish = (payload) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(payload);
      };

      const timeoutId = window.setTimeout(() => {
        finish({
          response: null,
          error: "timeout"
        });
      }, getMessageTimeout(message));

      runtimeApi.sendMessage(message, (response) => {
        window.clearTimeout(timeoutId);
        finish({
          response,
          error: runtimeApi.lastError?.message || null
        });
      });
    });

  const setButtonStatus = (button, status) => {
    window.clearTimeout(buttonStatusTimer);
    button.dataset.status = status;
    buttonStatusTimer = window.setTimeout(() => {
      delete button.dataset.status;
    }, 1400);
  };

  const showFeedback = (kind, message, linkUrl = null, linkLabel = "Open") => {
    window.clearTimeout(feedbackTimer);
    feedbackTarget = getCurrentContextSource();
    feedbackText.textContent = message;
    feedback.dataset.kind = kind;
    feedback.dataset.visible = "true";

    if (linkUrl) {
      feedbackLink.href = linkUrl;
      feedbackLink.textContent = linkLabel;
      feedbackLink.hidden = false;
    } else {
      feedbackLink.hidden = true;
      feedbackLink.removeAttribute("href");
    }

    feedbackTimer = window.setTimeout(() => {
      clearFeedback();
    }, linkUrl ? 4000 : 1800);
  };

  const clearFeedback = () => {
    window.clearTimeout(feedbackTimer);
    feedbackTarget = null;
    feedback.dataset.visible = "false";
    feedbackText.textContent = "";
    feedbackLink.hidden = true;
    feedbackLink.removeAttribute("href");
    delete feedback.dataset.kind;
  };

  const getDownieFeedback = (response, error) => {
    if (response?.ok && !error) {
      return { kind: "success", message: "Sent to Downie" };
    }

    if (error === "runtime_unavailable") {
      return { kind: "error", message: "Extension API unavailable" };
    }

    return { kind: "error", message: "Downie failed" };
  };

  const getReaderFeedback = (response, error) => {
    if (response?.ok && !error) {
      if (response.alreadyExists) {
        return {
          kind: "success",
          message: "Already in Reader",
          linkUrl: response.url
        };
      }

      return {
        kind: "success",
        message: "Saved to Reader",
        linkUrl: response.url
      };
    }

    if (response?.code === "missing_token") {
      return { kind: "error", message: "Add Reader token in settings" };
    }

    if (error === "runtime_unavailable") {
      return { kind: "error", message: "Extension API unavailable" };
    }

    if (response?.code === "invalid_url") {
      return { kind: "error", message: "Page URL unavailable" };
    }

    if (response?.status === 401) {
      return { kind: "error", message: "Reader token rejected" };
    }

    return { kind: "error", message: "Reader save failed" };
  };

  const getDirectVideoUrl = (video) => {
    if (!video) {
      return null;
    }

    const candidate = video.currentSrc || video.src || "";
    return /^https?:\/\//i.test(candidate) ? candidate : null;
  };

  const VIDEO_PAGE_SELECTORS = [
    'a#thumbnail[href*="/watch?"]',
    'a#video-title-link[href*="/watch?"]',
    'a#video-title[href*="/watch?"]',
    'a[href*="/watch?"]',
    'a[href*="/shorts/"]',
    'a[href*="/live/"]',
    'a[href*="youtu.be/"]'
  ];

  const resolveUrl = (value) => {
    if (!value) {
      return null;
    }

    try {
      return new URL(value, window.location.href).toString();
    } catch {
      return null;
    }
  };

  const getVideoCardContainer = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    for (const ancestor of getAncestorElements(source)) {
      if (ancestor.matches?.(CARD_CONTAINER_SELECTORS)) {
        return ancestor;
      }
    }

    return null;
  };

  const getAssociatedPageUrl = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    if (isCurrentPageVideoUrl()) {
      return window.location.href;
    }

    const container = getVideoCardContainer(source);

    if (container) {
      for (const selector of VIDEO_PAGE_SELECTORS) {
        const anchor = container.querySelector(selector);

        if (anchor instanceof HTMLAnchorElement && anchor.href) {
          const absoluteUrl = resolveUrl(anchor.href);

          if (absoluteUrl) {
            return absoluteUrl;
          }
        }
      }

      const containerAnchor = getAssociatedAnchor(container);

      if (containerAnchor instanceof HTMLAnchorElement) {
        const absoluteUrl = resolveUrl(containerAnchor.href);

        if (absoluteUrl) {
          return absoluteUrl;
        }
      }
    }

    for (let node = source; node && node !== document.body; node = node.parentElement) {
      if (node instanceof HTMLAnchorElement && node.href) {
        const absoluteUrl = resolveUrl(node.href);

        if (absoluteUrl) {
          return absoluteUrl;
        }
      }

      for (const selector of VIDEO_PAGE_SELECTORS) {
        const anchor = node.querySelector?.(`:scope ${selector}`);

        if (anchor instanceof HTMLAnchorElement && anchor.href) {
          const absoluteUrl = resolveUrl(anchor.href);

          if (absoluteUrl) {
            return absoluteUrl;
          }
        }
      }

      const associatedAnchor = getAssociatedAnchor(node);

      if (associatedAnchor instanceof HTMLAnchorElement) {
        const absoluteUrl = resolveUrl(associatedAnchor.href);

        if (absoluteUrl) {
          return absoluteUrl;
        }
      }
    }

    const fallbackAnchor = source.closest("a[href]");
    return fallbackAnchor instanceof HTMLAnchorElement ? resolveUrl(fallbackAnchor.href) : null;
  };

  const cleanText = (value) => {
    if (!value) {
      return null;
    }

    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized || null;
  };

  const YOUTUBE_UI_TEXT = new Set([
    "share link",
    "share",
    "save",
    "clip",
    "download",
    "open app",
    "watch later",
    "more actions",
    "show more",
    "show less",
    "play all",
    "queue",
    "menu"
  ]);

  const cleanTitle = (value) => {
    const normalized = cleanText(value);

    if (!normalized) {
      return null;
    }

    const lower = normalized.toLowerCase();

    if (YOUTUBE_UI_TEXT.has(lower)) {
      return null;
    }

    return normalized;
  };

  const extractTitleFromLabel = (value) => {
    const normalized = cleanTitle(value);

    if (!normalized) {
      return null;
    }

    const byMatch = normalized.match(/^(.+?)\s+by\s+.+$/i);

    if (byMatch?.[1]) {
      return cleanTitle(byMatch[1]);
    }

    return normalized;
  };

  const cleanAuthor = (value) => {
    const normalized = cleanText(value);

    if (!normalized) {
      return null;
    }

    const withoutSuffix = normalized.replace(/\s+-\s+YouTube$/i, "").trim();
    return withoutSuffix.startsWith("@") ? withoutSuffix.slice(1).trim() || null : withoutSuffix;
  };

  const extractAuthorFromLabel = (value) => {
    const normalized = cleanText(value);

    if (!normalized) {
      return null;
    }

    const byMatch = normalized.match(/\bby\s+(.+?)(?:\s+\d[\d.,]*\s+(?:views?|watching)|\s+\d+\s+\w+\s+ago|$)/i);

    if (byMatch?.[1]) {
      return cleanAuthor(byMatch[1]);
    }

    return null;
  };

  const pickTextFromSelectors = (root, selectors, cleaner = cleanText) => {
    if (!root) {
      return null;
    }

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        const value =
          cleaner(node?.getAttribute?.("title")) ||
          cleaner(node?.getAttribute?.("content")) ||
          cleaner(node?.textContent) ||
          cleaner(node?.getAttribute?.("aria-label"));

        if (value) {
          return value;
        }
      }
    }

    return null;
  };

  const getAssociatedTitle = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    if (isCurrentPageVideoUrl()) {
      return pickTextFromSelectors(document, [
        "ytd-watch-metadata h1 yt-formatted-string",
        "h1.ytd-watch-metadata yt-formatted-string",
        "h1.title yt-formatted-string",
        "meta[property='og:title']"
      ], cleanTitle);
    }

    const container = getVideoCardContainer(source);

    if (container) {
      const primaryTitle = pickTextFromSelectors(container, [
        "#video-title",
        "#video-title-link",
        "a[href*='/watch?'][title]",
        "a#thumbnail[title]",
        "h3 a[href*='/watch?']",
        "h3",
        "h2"
      ], cleanTitle);

      if (primaryTitle) {
        return primaryTitle;
      }

      const labelTitle = pickTextFromSelectors(container, [
        "a[href*='/watch?'][aria-label]",
        "a#thumbnail[aria-label]",
        "a[aria-label*=' by ']"
      ], extractTitleFromLabel);

      if (labelTitle) {
        return labelTitle;
      }

      const containerTitle = pickTextFromSelectors(container, [
        "meta[property='og:title']",
        "a[title]",
        "img[alt]",
      ], cleanTitle);

      if (containerTitle) {
        return containerTitle;
      }
    }

    return pickTextFromSelectors(source, [
      "#video-title",
      "#video-title-link",
      "a[href*='/watch?'][title]",
      "a[href*='/watch?'][aria-label]",
      "a[title]",
      "img[alt]",
      "h3",
      "h2"
    ], (value) => extractTitleFromLabel(value) || cleanTitle(value));
  };

  const getAssociatedAuthor = (source) => {
    if (!(source instanceof Element)) {
      return null;
    }

    if (isCurrentPageVideoUrl()) {
      return pickTextFromSelectors(
        document,
        [
          "#channel-name a",
          "ytd-watch-metadata ytd-channel-name a",
          "ytd-watch-metadata #owner a",
          "link[itemprop='name']"
        ],
        cleanAuthor
      );
    }

    if (isYouTubeChannelPage()) {
      const pageAuthor = pickTextFromSelectors(
        document,
        [
          "#channel-name yt-formatted-string",
          "ytd-channel-name#channel-name yt-formatted-string",
          "#page-header #channel-name yt-formatted-string",
          "yt-page-header-view-model #channel-name",
          "meta[property='og:title']"
        ],
        cleanAuthor
      );

      if (pageAuthor) {
        return pageAuthor;
      }
    }

    const container = getVideoCardContainer(source);

    if (container) {
      const directAuthor = pickTextFromSelectors(
        container,
        [
          "ytd-video-meta-block ytd-channel-name a",
          "ytd-video-meta-block #channel-name a",
          "ytd-video-meta-block #byline-container a",
          "ytd-video-meta-block #byline a",
          "ytd-video-meta-block #avatar-link",
          "ytd-channel-name a",
          "#channel-name a",
          "#byline-container a",
          "#byline a",
          "#avatar-link",
          "#avatar-container a",
          "ytd-avatar a",
          "#channel-name #text",
          "#byline-container #text",
          "#byline #text",
          "yt-formatted-string#byline",
          "yt-formatted-string.ytd-channel-name",
          "#text.ytd-channel-name",
          "a[href^='/@']",
          "a[href^='/channel/']",
          "a[href^='/c/']",
          "a[href^='/user/']"
        ],
        cleanAuthor
      );

      if (directAuthor) {
        return directAuthor;
      }

      return pickTextFromSelectors(
        container,
        [
          "#video-title",
          "#video-title-link",
          "a[href*='/watch?'][aria-label]",
          "a#thumbnail[aria-label]"
        ],
        extractAuthorFromLabel
      );
    }

    return pickTextFromSelectors(
      source,
      [
        "[class*='channel']",
        "[class*='Channel']",
        "[class*='author']",
        "[class*='Author']",
        "[class*='byline']",
        "[class*='Byline']",
        "[data-testid*='channel']",
        "[data-testid*='author']",
        "a[rel='author']"
      ],
      cleanAuthor
    );
  };

  shadowRoot.addEventListener("click", safeEventHandler(async (event) => {
    const button = event.target.closest("button");

    if (!button) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!activeTarget) {
      return;
    }

    const { action, rate } = button.dataset;

    if (action === "decrease") {
      if (!activeVideo) {
        return;
      }

      applyRate(activeVideo, getBaseRate(activeVideo) - settings.adjustmentStep);
      return;
    }

    if (action === "increase") {
      if (!activeVideo) {
        return;
      }

      applyRate(activeVideo, getBaseRate(activeVideo) + settings.adjustmentStep);
      return;
    }

    if (action === "downie") {
      const source = getCurrentContextSource();
      const { response, error } = await sendRuntimeMessage({
        type: "open-in-downie",
        videoUrl: getDirectVideoUrl(activeVideo),
        pageUrl: getAssociatedPageUrl(source)
      });

      if (getCurrentContextSource() === source) {
        setButtonStatus(button, response?.ok && !error ? "success" : "error");
        const feedbackState = getDownieFeedback(response, error);
        showFeedback(feedbackState.kind, feedbackState.message);
      }

      return;
    }

    if (action === "reader") {
      const source = getCurrentContextSource();
      const pageUrl = getAssociatedPageUrl(source);
      const title = getAssociatedTitle(source);
      const author = getAssociatedAuthor(source);
      const { response, error } = await sendRuntimeMessage({
        type: "save-to-reader",
        pageUrl,
        title,
        author
      });

      if (response?.code === "missing_token") {
        void sendRuntimeMessage({ type: "open-options" });
      }

      if (getCurrentContextSource() === source) {
        setButtonStatus(button, response?.ok && !error ? "success" : "error");
        const feedbackState = getReaderFeedback(response, error);
        showFeedback(
          feedbackState.kind,
          feedbackState.message,
          feedbackState.linkUrl
        );
      }

      return;
    }

    if (rate) {
      if (!activeVideo) {
        return;
      }

      applyRate(activeVideo, Number(rate));
    }
  }));

  panel.addEventListener("pointerenter", () => {
    activePanel = true;
    clearHideTimer();
    stopPreview();
  });

  panel.addEventListener("pointerleave", () => {
    activePanel = false;
    scheduleHide();
  });

  dragHandle.addEventListener("pointerdown", safeEventHandler((event) => {
    if (!(activeAnchor || activeTarget)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const panelRect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      pointerOffsetX: event.clientX - panelRect.left,
      pointerOffsetY: event.clientY - panelRect.top
    };
    dragHandle.dataset.dragging = "true";
    activePanel = true;
    clearHideTimer();
  }));

  window.addEventListener("pointermove", safeEventHandler((event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    event.preventDefault();
    updateDragPosition(event.clientX, event.clientY);
  }), true);

  const handleDragStop = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    stopDragging();
  };

  window.addEventListener("pointerup", handleDragStop, true);
  window.addEventListener("pointercancel", () => {
    stopDragging();
  }, true);

  document.addEventListener(
    "pointermove",
    safeEventHandler((event) => {
      if (dragState) {
        activePanel = true;
        clearHideTimer();
        return;
      }

      const inPanel = event.composedPath().includes(panel);

      if (inPanel) {
        activePanel = true;
        clearHideTimer();
        return;
      }

      activePanel = false;

      const nextContext = getHoverContext(event);
      const nextVideo = nextContext?.video || null;
      const nextTarget = nextContext?.target || null;
      const nextSource = nextContext?.metadataTarget || nextTarget || nextVideo || null;

      if (activeTarget && nextTarget && activeTarget !== nextTarget) {
        overlayPositionX = null;
        overlayPositionY = null;
      }

      if (feedbackTarget && feedbackTarget !== nextSource) {
        clearFeedback();
      }

      if (hoveredVideo && hoveredVideo !== nextVideo) {
        getState(hoveredVideo).closed = false;
      }

      hoveredVideo = nextVideo;
      hoveredTarget = nextSource;

      if (!nextTarget) {
        stopPreview();
        scheduleHide();
        return;
      }

      if (nextVideo && getState(nextVideo).closed) {
        stopPreview();
        if (activeVideo === nextVideo) {
          hidePanel();
        }

        return;
      }

      showPanelForContext(nextContext);

      if (!activePanel) {
        if (nextVideo) {
          startPreview(nextVideo);
        } else {
          stopPreview();
        }
      }
    }),
    true
  );

  document.addEventListener(
    "pointerleave",
    () => {
      hoveredVideo = null;
      hoveredTarget = null;
      activePanel = false;
      stopPreview();
      scheduleHide();
    },
    true
  );

  document.addEventListener(
    "ratechange",
    (event) => {
      if (isApplyingRate || !(event.target instanceof HTMLVideoElement) || event.target === previewVideo) {
        return;
      }

      getState(event.target).baseRate = clampRate(event.target.playbackRate || 1);

      if (event.target === activeVideo) {
        updateUi(event.target);
      }
    },
    true
  );

  if (storageApi?.local) {
    storageApi.local.get(
      {
        hoverSpeed: settings.hoverSpeed,
        adjustmentStep: settings.adjustmentStep,
        showDownie: settings.showDownie,
        showReader: settings.showReader
      },
      (result) => {
        const nextValue = Number(result.hoverSpeed);
        settings.hoverSpeed = Number.isFinite(nextValue) && nextValue >= 0 ? nextValue : settings.hoverSpeed;
        settings.adjustmentStep = normalizeAdjustmentStep(Number(result.adjustmentStep));
        settings.showDownie = result.showDownie !== false;
        settings.showReader = result.showReader !== false;
        updateIntegrationVisibility();
        refreshVisiblePanelMode();
      }
    );

    storageApi.onChanged?.addListener((changes, areaName) => {
      if (
        areaName !== "local" ||
        (
          !changes.hoverSpeed &&
          !changes.adjustmentStep &&
          !changes.showDownie &&
          !changes.showReader
        )
      ) {
        return;
      }

      if (changes.hoverSpeed) {
        const nextValue = changes.hoverSpeed.newValue;
        settings.hoverSpeed = Number.isFinite(nextValue) && nextValue >= 0 ? nextValue : settings.hoverSpeed;
      }

      if (changes.adjustmentStep) {
        settings.adjustmentStep = normalizeAdjustmentStep(Number(changes.adjustmentStep.newValue));
      }

      if (changes.showDownie) {
        settings.showDownie = changes.showDownie.newValue !== false;
      }

      if (changes.showReader) {
        settings.showReader = changes.showReader.newValue !== false;
      }

      updateIntegrationVisibility();
      refreshVisiblePanelMode();

      if (settings.hoverSpeed === 0) {
        stopPreview();
      } else if (hoveredVideo && !activePanel) {
        startPreview(hoveredVideo);
      }
    });
  }

  window.addEventListener("scroll", syncPanelPosition, true);
  window.addEventListener("resize", syncPanelPosition);
  document.addEventListener("fullscreenchange", syncPanelPosition);
})();
