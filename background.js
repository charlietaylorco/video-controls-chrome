importScripts("x-video-download.js", "reader-core.js", "reader-watch-core.js", "reader-watch-store.js", "reader-service.js", "reader-watch-service.js", "reader-summary-service.js");

let readerPanelService, readerWatchStore, readerWatchService, watchRevision = 0, watchAuthRevision = 0;
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.readerToken) { watchAuthRevision++; void readerPanelService?.invalidateAuth(); }
});
const getReaderWatchStore = () => readerWatchStore ||= MVSReaderWatchStore.create({ storage: chrome.storage.local,
  notify: videoUrl => new Promise(resolve => chrome.storage.local.set({ readerWatchChanged: { videoUrl, at: Date.now(), revision: ++watchRevision } }, resolve)) });
const getReaderPanelService = () => readerPanelService ||= MVSReaderSummaryService.create({ storage: chrome.storage.local, alarms: chrome.alarms,
  reader: MVSReaderService.create({ storage: chrome.storage.local, fetch, history: getReaderWatchStore() }) });
chrome.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === 'reader-summary') void getReaderPanelService().resume(); });
if (chrome.alarms) void getReaderPanelService().resume();
const getReaderWatchService = () => readerWatchService ||= MVSReaderWatchService.create({ store: getReaderWatchStore(), reader: getReaderPanelService() });

const DOWNIE_PREFIX = "downie://XUOpenLink?url=";
const READER_SAVE_URL = "https://readwise.io/api/v3/save/";
const READER_SOURCE = "minimal-video-speed";
const RAINDROP_SAVED_URLS_KEY = "raindropSavedUrls";
const MAX_RAINDROP_SAVED_URLS = 2000;
const READER_SAVED_URLS_KEY = "readerSavedUrls";
const MAX_READER_SAVED_URLS = 2000;
const DOWNIE_SENT_URLS_KEY = "downieSentUrls";
const MAX_DOWNIE_SENT_URLS = 2000;
const FEED_URL = chrome.runtime.getURL("feed.html");
const WATCH_URL = chrome.runtime.getURL("watch.html");
const openingRecentSaves = new Map();
const openRecentSaves = (sourceTab) => {
  const privateContext = Boolean(sourceTab?.incognito);
  if (openingRecentSaves.has(privateContext)) return openingRecentSaves.get(privateContext);
  const work = new Promise(resolve => {
    const finish = ok => resolve(ok ? { ok: true } : { ok: false, code: "runtime_error" });
    const create = () => {
      const options = { url: WATCH_URL };
      if (Number.isInteger(sourceTab?.windowId) && sourceTab.windowId >= 0) options.windowId = sourceTab.windowId;
      try { chrome.tabs.create(options, tab => finish(!chrome.runtime.lastError && Boolean(tab))); } catch { finish(false); }
    };
    const matches = tab => Number.isInteger(tab?.id) && tab.id >= 0 && tab.url === WATCH_URL && !tab.pendingUrl && Boolean(tab.incognito) === privateContext;
    try {
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) { create(); return; }
        const candidates = (tabs || []).filter(matches);
        const match = candidates.find(tab => tab.windowId === sourceTab?.windowId) || candidates.find(tab => tab.active) || candidates[0];
        if (!match) { create(); return; }
        chrome.tabs.get(match.id, current => {
          if (chrome.runtime.lastError || !matches(current)) { create(); return; }
          chrome.tabs.update(current.id, { active: true }, activated => {
            if (chrome.runtime.lastError || !activated) { create(); return; }
            if (Number.isInteger(activated.windowId) && chrome.windows?.update) {
              chrome.windows.update(activated.windowId, { focused: true }, () => { void chrome.runtime.lastError; finish(true); });
            } else finish(true);
          });
        });
      });
    } catch { create(); }
  });
  openingRecentSaves.set(privateContext, work);
  work.finally(() => openingRecentSaves.delete(privateContext));
  return work;
};

const isHttpUrl = (value) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
const isYouTubeHost = (url) =>
  url.protocol === "https:" && !url.port && YOUTUBE_HOSTS.includes(url.hostname);
const isYouTubeWatchUrl = (url) =>
  isYouTubeHost(url) &&
  url.pathname === "/watch" &&
  Boolean(url.searchParams.get("v"));
const isYouTubeEmbedUrl = (url) =>
  isYouTubeHost(url) && /^\/embed\/[^/]+/.test(url.pathname);
const isYouTubeChannelPageUrl = (value) => {
  if (!isHttpUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);

    if (!isYouTubeHost(url)) {
      return false;
    }

    return /^(\/@[^/]+|\/channel\/[^/]+|\/c\/[^/]+|\/user\/[^/]+)(\/.*)?$/.test(url.pathname);
  } catch {
    return false;
  }
};
const isYouTubeVideoPageUrl = (value) => {
  if (!isHttpUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      isYouTubeWatchUrl(url) ||
      isYouTubeEmbedUrl(url) ||
      (isYouTubeHost(url) && /^\/(shorts|live)\/[^/]+/.test(url.pathname))
    );
  } catch {
    return false;
  }
};
const isPreferredVideoPageUrl = (value) => {
  if (!isHttpUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);

    if (url.protocol === "https:" && !url.port &&
        ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname) &&
        /^\/i\/broadcasts\/[A-Za-z0-9]{1,32}\/?$/.test(url.pathname)) {
      return true;
    }

    if (isYouTubeWatchUrl(url)) {
      return true;
    }

    return (
      ["youtu.be", "www.youtu.be"].includes(url.hostname) ||
      isYouTubeEmbedUrl(url) ||
      (isYouTubeHost(url) && /^\/(shorts|live)\/[^/]+/.test(url.pathname))
    );
  } catch {
    return false;
  }
};

const encodeDownieActionUrl = (url) =>
  `${DOWNIE_PREFIX}${encodeURI(url).replaceAll("&", "%26").replaceAll("#", "%23")}`;

const decodeHtml = (value) =>
  String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const decodeJsonText = (value) =>
  String(value || "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u002f/g, "/");

const sanitizeAuthor = (value) => {
  const author = String(value || "").trim().replace(/\s+-\s+YouTube$/i, "");

  if (!author) {
    return undefined;
  }

  if (/^(https?:\/\/)?(www\.)?youtube\.com\/?$/i.test(author) || /^youtube\.com$/i.test(author)) {
    return undefined;
  }

  return author;
};

const extractYouTubeMetadata = (html) => {
  if (!html) {
    return {};
  }

  const authorPatterns = [
    /"ownerChannelName":"([^"]+)"/,
    /"channelName":"([^"]+)"/,
    /<span[^>]+itemprop="author"[\s\S]*?<link[^>]+itemprop="name"[^>]+content="([^"]+)"/i,
    /<link[^>]+itemprop="name"[^>]+content="([^"]+)"/i
  ];
  const titlePatterns = [
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<title>([^<]+)<\/title>/i
  ];

  let author = null;
  for (const pattern of authorPatterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      author = sanitizeAuthor(decodeHtml(decodeJsonText(match[1])));
      if (author) {
        break;
      }
    }
  }

  let title = null;
  for (const pattern of titlePatterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      title = decodeHtml(decodeJsonText(match[1])).replace(/\s+-\s+YouTube$/i, "").trim();
      if (title) {
        break;
      }
    }
  }

  return { author, title };
};

const extractYouTubeChannelAuthor = (html) => {
  if (!html) {
    return undefined;
  }

  const patterns = [
    /"channelMetadataRenderer":\{"title":"([^"]+)"/,
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<title>([^<]+)<\/title>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      const author = sanitizeAuthor(decodeHtml(decodeJsonText(match[1])));

      if (author) {
        return author;
      }
    }
  }

  return undefined;
};

const fetchHtml = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.text();
};

const enrichYouTubeMetadata = async (targetUrl, pageUrl, metadata) => {
  const normalizedMetadata = {
    title: metadata?.title || undefined,
    author: sanitizeAuthor(metadata?.author)
  };

  if (!isYouTubeVideoPageUrl(targetUrl) || (normalizedMetadata.author && normalizedMetadata.title)) {
    return normalizedMetadata;
  }

  try {
    let author = normalizedMetadata.author;

    if (!author && isYouTubeChannelPageUrl(pageUrl)) {
      const channelHtml = await fetchHtml(pageUrl);
      author = extractYouTubeChannelAuthor(await channelHtml);
    }

    const html = await fetchHtml(targetUrl);

    if (!html) {
      return {
        title: normalizedMetadata.title,
        author
      };
    }

    const extracted = extractYouTubeMetadata(await html);

    return {
      title: normalizedMetadata.title || extracted.title || undefined,
      author: author || sanitizeAuthor(extracted.author) || undefined
    };
  } catch {
    return normalizedMetadata;
  }
};

const normalizeTargetUrl = (value) => {
  if (!isHttpUrl(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (["youtu.be", "www.youtu.be"].includes(url.hostname)) {
      const videoId = url.pathname.replace(/^\/+/, "").split("/")[0];

      if (videoId) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      }
    }

    if (isYouTubeWatchUrl(url)) {
      const videoId = url.searchParams.get("v");

      if (videoId) {
        url.search = "";
        url.hash = "";
        url.searchParams.set("v", videoId);
      }

      return url.toString();
    }

    if (isYouTubeEmbedUrl(url)) {
      const videoId = url.pathname.split("/")[2];

      if (videoId) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      }
    }

    return url.toString();
  } catch {
    return value;
  }
};

const getSavedUrlKeys = (value) => {
  const normalized = normalizeTargetUrl(value);

  if (!isHttpUrl(normalized)) {
    return [];
  }

  const keys = new Set([normalized]);

  try {
    const url = new URL(normalized);
    url.hash = "";
    keys.add(url.toString());
  } catch {
    // Keep the normalized value above.
  }

  return Array.from(keys);
};

const getReaderSavedUrls = () =>
  new Promise((resolve) => {
    chrome.storage.local.get({ [READER_SAVED_URLS_KEY]: {} }, (result) => {
      const savedUrls = result[READER_SAVED_URLS_KEY];
      resolve(savedUrls && typeof savedUrls === "object" && !Array.isArray(savedUrls) ? savedUrls : {});
    });
  });

const setReaderSavedUrls = (savedUrls) =>
  new Promise((resolve) => {
    chrome.storage.local.set({ [READER_SAVED_URLS_KEY]: savedUrls }, resolve);
  });

const pruneReaderSavedUrls = (savedUrls) => {
  const entries = Object.entries(savedUrls)
    .filter(([url, savedAt]) => isHttpUrl(url) && Number.isFinite(Number(savedAt)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return Object.fromEntries(entries.slice(0, MAX_READER_SAVED_URLS));
};

const markReaderUrlSaved = async (targetUrl, extraUrl = null) => {
  const keys = [...getSavedUrlKeys(targetUrl), ...getSavedUrlKeys(extraUrl)];

  if (keys.length === 0) {
    return;
  }

  const savedUrls = await getReaderSavedUrls();
  const savedAt = Date.now();

  for (const key of keys) {
    savedUrls[key] = savedAt;
  }

  await setReaderSavedUrls(pruneReaderSavedUrls(savedUrls));
};

const isReaderUrlSaved = async (targetUrl) => {
  const keys = getSavedUrlKeys(targetUrl);

  if (keys.length === 0) {
    return false;
  }

  const savedUrls = await getReaderSavedUrls();
  return keys.some((key) => Boolean(savedUrls[key]));
};

const getRaindropSavedUrls = () =>
  new Promise((resolve) => {
    chrome.storage.local.get({ [RAINDROP_SAVED_URLS_KEY]: {} }, (result) => {
      const savedUrls = result[RAINDROP_SAVED_URLS_KEY];
      resolve(savedUrls && typeof savedUrls === "object" && !Array.isArray(savedUrls) ? savedUrls : {});
    });
  });

const setRaindropSavedUrls = (savedUrls) =>
  new Promise((resolve) => {
    chrome.storage.local.set({ [RAINDROP_SAVED_URLS_KEY]: savedUrls }, resolve);
  });

const pruneRaindropSavedUrls = (savedUrls) => {
  const entries = Object.entries(savedUrls)
    .filter(([url, savedAt]) => isHttpUrl(url) && Number.isFinite(Number(savedAt)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return Object.fromEntries(entries.slice(0, MAX_RAINDROP_SAVED_URLS));
};

const markRaindropUrlSaved = async (targetUrl, extraUrl = null) => {
  const keys = [...getSavedUrlKeys(targetUrl), ...getSavedUrlKeys(extraUrl)];

  if (keys.length === 0) {
    return;
  }

  const savedUrls = await getRaindropSavedUrls();
  const savedAt = Date.now();

  for (const key of keys) {
    savedUrls[key] = savedAt;
  }

  await setRaindropSavedUrls(pruneRaindropSavedUrls(savedUrls));
};

const isRaindropUrlSaved = async (targetUrl) => {
  const keys = getSavedUrlKeys(targetUrl);

  if (keys.length === 0) {
    return false;
  }

  const savedUrls = await getRaindropSavedUrls();
  return keys.some((key) => Boolean(savedUrls[key]));
};

const getDownieSentUrls = () =>
  new Promise((resolve) => {
    chrome.storage.local.get({ [DOWNIE_SENT_URLS_KEY]: {} }, (result) => {
      const sentUrls = result[DOWNIE_SENT_URLS_KEY];
      resolve(sentUrls && typeof sentUrls === "object" && !Array.isArray(sentUrls) ? sentUrls : {});
    });
  });

const setDownieSentUrls = (sentUrls) =>
  new Promise((resolve) => {
    chrome.storage.local.set({ [DOWNIE_SENT_URLS_KEY]: sentUrls }, resolve);
  });

const pruneDownieSentUrls = (sentUrls) => {
  const entries = Object.entries(sentUrls)
    .filter(([url, sentAt]) => isHttpUrl(url) && Number.isFinite(Number(sentAt)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return Object.fromEntries(entries.slice(0, MAX_DOWNIE_SENT_URLS));
};

const markDownieUrlSent = async (targetUrl) => {
  const keys = getSavedUrlKeys(targetUrl);

  if (keys.length === 0) {
    return;
  }

  const sentUrls = await getDownieSentUrls();
  const sentAt = Date.now();

  for (const key of keys) {
    sentUrls[key] = sentAt;
  }

  await setDownieSentUrls(pruneDownieSentUrls(sentUrls));
};

const isDownieUrlSent = async (targetUrl) => {
  const keys = getSavedUrlKeys(targetUrl);

  if (keys.length === 0) {
    return false;
  }

  const sentUrls = await getDownieSentUrls();
  return keys.some((key) => Boolean(sentUrls[key]));
};

const pickTargetUrl = (message, sender) => {
  const pageUrl = message?.pageUrl;
  if (isPreferredVideoPageUrl(pageUrl)) {
    return normalizeTargetUrl(pageUrl);
  }

  const directVideoUrl = message?.videoUrl;
  if (isHttpUrl(directVideoUrl)) {
    return normalizeTargetUrl(directVideoUrl);
  }

  if (isHttpUrl(pageUrl)) {
    return normalizeTargetUrl(pageUrl);
  }

  if (isHttpUrl(sender?.url)) {
    return normalizeTargetUrl(sender.url);
  }

  if (isHttpUrl(sender?.tab?.url)) {
    return normalizeTargetUrl(sender.tab.url);
  }

  return null;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const recentCardAction = message?.type === "watch-card-action";
  if (recentCardAction) {
    const target = MVSReaderCore.canonical(message.pageUrl);
    if (sender.id !== chrome.runtime.id || sender.url !== WATCH_URL ||
        (sender.frameId !== undefined && sender.frameId !== 0) ||
        (sender.documentLifecycle && sender.documentLifecycle !== "active") ||
        !target || !["raindrop", "downie"].includes(message.action)) {
      sendResponse({ ok: false, code: "invalid_request" }); return undefined;
    }
    // Reuse the established transports; the extension page never reads tokens.
    message = { type: message.action === "raindrop" ? "save-to-raindrop" : "open-in-downie", pageUrl: target };
  }
  if (message?.type === "open-watch-list") {
    if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false, code: "invalid_sender" }); return undefined; }
    openRecentSaves(sender.tab).then(sendResponse); return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("watch-list-")) {
    const trusted = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("watch.html") &&
      (sender.frameId === undefined || sender.frameId === 0) && (!sender.documentLifecycle || sender.documentLifecycle === "active");
    if (!trusted) { sendResponse({ ok: false, code: "invalid_sender" }); return undefined; }
    const authRevision = watchAuthRevision;
    const scope = `${sender.documentId || String(sender.tab?.id ?? "watch-page")}:${authRevision}`;
    const isCurrent = () => authRevision !== watchAuthRevision ? Promise.resolve(false) : !Number.isInteger(sender.tab?.id) ? Promise.resolve(trusted) : new Promise(resolve => {
      try { chrome.tabs.get(sender.tab.id, tab => resolve(!chrome.runtime.lastError && tab?.url === chrome.runtime.getURL("watch.html") && !tab.pendingUrl)); }
      catch { resolve(false); }
    });
    getReaderWatchService().handle(message, { scope, isCurrent }).then(sendResponse);
    return true;
  }
  if (["reader-card-get", "reader-card-delete"].includes(message?.type)) {
    const origin = MVSReaderCore.youtubeOrigin(sender.url);
    const page = MVSReaderCore.pageKey(message.pageUrl), target = MVSReaderCore.canonical(message.targetUrl);
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !origin ||
        !page || !target || typeof message.lease !== "string" || !/^[\w-]{1,100}$/.test(message.lease) ||
        (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
      sendResponse({ ok: false, code: "invalid_sender" }); return undefined;
    }
    // Card targets deliberately differ from the active watch URL. A dedicated
    // isolated-world challenge binds the request to a still-live, unchanged card.
    const isCurrent = () => new Promise(resolve => {
      try {
        chrome.tabs.get(sender.tab.id, tab => {
          if (chrome.runtime.lastError || tab?.id !== sender.tab.id || MVSReaderCore.youtubeOrigin(tab.url) !== origin ||
              MVSReaderCore.pageKey(tab.url) !== page || (tab.pendingUrl && MVSReaderCore.pageKey(tab.pendingUrl) !== page)) {
            resolve(false); return;
          }
          const options = sender.documentId ? { documentId: sender.documentId } : { frameId: 0 };
          chrome.tabs.sendMessage(sender.tab.id, { type: "reader-card-validate", lease: message.lease, pageUrl: page, targetUrl: target }, options,
            reply => resolve(!chrome.runtime.lastError && reply?.ok === true && reply.lease === message.lease && reply.pageUrl === page && reply.targetUrl === target));
        });
      } catch { resolve(false); }
    });
    getReaderPanelService().handle(message, { isCurrent, scope: [sender.tab.id, sender.documentId || "", message.lease] }).then(sendResponse);
    return true;
  }
  if (["reader-panel-get", "reader-panel-save-note", "reader-panel-delete", "reader-panel-move"].includes(message?.type)) {
    const origin = MVSReaderCore.youtubeOrigin(sender.url);
    const target = MVSReaderCore.canonical(message.pageUrl);
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
        !origin || !target || (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
      sendResponse({ ok: false, code: "invalid_sender" });
      return undefined;
    }
    // A content-script context can retain its original URL through YouTube SPA
    // navigation (including Home -> video). Use current browser-owned tab data,
    // not sender.url or the sender.tab snapshot, for video identity. Recheck at
    // each API request, including after queued work and before note/delete writes.
    const isCurrent = () => new Promise(resolve => {
      try {
        chrome.tabs.get(sender.tab.id, tab => resolve(!chrome.runtime.lastError && tab?.id === sender.tab.id &&
          MVSReaderCore.youtubeOrigin(tab.url) === origin && MVSReaderCore.canonical(tab.url) === target &&
          (!tab.pendingUrl || MVSReaderCore.canonical(tab.pendingUrl) === target)));
      } catch { resolve(false); }
    });
    getReaderPanelService().handle(message, { isCurrent, scope: [sender.tab.id, sender.documentId || ""] }).then(sendResponse);
    return true;
  }

  if (message?.type === "download-x-video") {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
        !XVideoDownload.isXPage(sender.url)) {
      sendResponse({ ok: false, code: "invalid_sender" });
      return undefined;
    }
    XVideoDownload.start(message.variants, message.metadata).then(sendResponse, (error) => {
      const codes = ["no_mp4", "ambiguous_video", "invalid_mp4", "fragmented_mp4", "encrypted_mp4",
        "no_video", "no_audio", "access_denied", "range_failed", "changed_file", "metadata_too_large",
        "verification_timeout", "network_failed", "save_failed"];
      sendResponse({ ok: false, code: codes.includes(error?.message) ? error.message : "download_failed" });
    });
    return true;
  }

  if (message?.type === "open-yt-lists" || message?.type === "ytListsOpenFeed") {
    chrome.tabs.create({ url: FEED_URL }, () => {
      sendResponse({ ok: !chrome.runtime.lastError });
    });
    return true;
  }

  if (message?.type === "open-reader-url") {
    const targetUrl = normalizeTargetUrl(message?.url);

    if (!isHttpUrl(targetUrl)) {
      sendResponse({ ok: false, code: "invalid_url" });
      return undefined;
    }

    chrome.tabs.create({ url: targetUrl }, () => {
      sendResponse({
        ok: !chrome.runtime.lastError,
        error: chrome.runtime.lastError?.message
      });
    });

    return true;
  }

  if (message?.type === "get-raindrop-save-state") {
    const targetUrl = normalizeTargetUrl(message?.pageUrl);
    isRaindropUrlSaved(targetUrl).then((saved) => sendResponse({ ok: true, saved, url: targetUrl }));
    return true;
  }

  if (message?.type === "save-to-raindrop") {
    const targetUrl = normalizeTargetUrl(message?.pageUrl);
    if (!isYouTubeVideoPageUrl(targetUrl)) {
      sendResponse({ ok: false, code: "invalid_url" });
      return undefined;
    }
    chrome.storage.local.get({ raindropToken: "" }, async ({ raindropToken }) => {
      if (typeof raindropToken !== "string" || !raindropToken.trim()) {
        sendResponse({ ok: false, code: "missing_token" });
        return;
      }
      try {
        const response = await fetch("https://api.raindrop.io/rest/v1/raindrop", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          redirect: "error",
          headers: { Authorization: `Bearer ${raindropToken.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ link: targetUrl, collection: { $id: -1 }, pleaseParse: {} })
        });
        if (!response.ok) {
          sendResponse({ ok: false, code: [401, 403].includes(response.status) ? "unauthorized" : "save_failed" });
          return;
        }
        const data = await response.json();
        if (data.result === true) await markRaindropUrlSaved(targetUrl);
        sendResponse({ ok: data.result === true, url: targetUrl });
      } catch {
        sendResponse({ ok: false, code: "save_failed" });
      }
    });
    return true;
  }

  if (message?.type === "open-in-downie") {
    const tabId = sender?.tab?.id;
    const targetUrl = pickTargetUrl(message, sender);

    if (recentCardAction) {
      // A protocol handoff must not replace the Recent saves grid. A successful
      // tabs callback confirms handoff only, not app installation/download.
      const options = { url: encodeDownieActionUrl(targetUrl), active: false };
      if (Number.isInteger(tabId)) options.openerTabId = tabId;
      if (Number.isInteger(sender.tab?.windowId)) options.windowId = sender.tab.windowId;
      try {
        chrome.tabs.create(options, async tab => {
          if (chrome.runtime.lastError || !tab) { sendResponse({ ok: false, code: "launch_failed" }); return; }
          try { await markDownieUrlSent(targetUrl); sendResponse({ ok: true, url: targetUrl }); }
          catch { sendResponse({ ok: true, url: targetUrl, stateWarning: true }); }
        });
      } catch { sendResponse({ ok: false, code: "launch_failed" }); }
      return true;
    }

    if (!Number.isInteger(tabId) || !targetUrl) {
      sendResponse({ ok: false });
      return undefined;
    }

    chrome.tabs.update(tabId, { url: encodeDownieActionUrl(targetUrl) }, async () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      await markDownieUrlSent(targetUrl);
      sendResponse({ ok: true, url: targetUrl });
    });

    return true;
  }

  if (message?.type !== "save-to-reader") {
    if (message?.type === "get-reader-save-state") {
      const targetUrl = normalizeTargetUrl(message?.pageUrl || sender?.tab?.url);

      getReaderPanelService().savedState(targetUrl).then(state => sendResponse({ ok: true, ...state }),
        () => sendResponse({ ok: false, code: "storage_error" }));

      return true;
    }

    if (message?.type === "get-downie-sent-state") {
      const targetUrl = pickTargetUrl(message, sender);

      isDownieUrlSent(targetUrl).then((sent) => {
        sendResponse({
          ok: true,
          sent,
          url: targetUrl
        });
      });

      return true;
    }

    if (message?.type === "open-options") {
      chrome.runtime.openOptionsPage();
    }

    return undefined;
  }

  const targetUrl = normalizeTargetUrl(message?.pageUrl || sender?.tab?.url);

  chrome.storage.local.get({ readerToken: "" }, async ({ readerToken }) => {
    if (!targetUrl || !isHttpUrl(targetUrl) || !isYouTubeVideoPageUrl(targetUrl)) {
      sendResponse({ ok: false, code: "invalid_url" });
      return;
    }

    if (!readerToken) {
      sendResponse({ ok: false, code: "missing_token" });
      return;
    }

    try {
      // Migrate retained local flags before this save changes their timestamps.
      // History failure must not retry or invalidate a successful remote save.
      try { await getReaderWatchStore().ready(); } catch { /* surfaced after Reader succeeds */ }
      const metadata = await enrichYouTubeMetadata(targetUrl, sender?.tab?.url, {
        title: message?.title || undefined,
        author: message?.author || undefined
      });

      const response = await fetch(READER_SAVE_URL, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        redirect: "error",
        headers: {
          Authorization: `Token ${readerToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: targetUrl,
          saved_using: READER_SOURCE,
          title: metadata.title,
          author: metadata.author
        })
      });

      if (!response.ok) {
        sendResponse({ ok: false, code: "reader_error", status: response.status });
        return;
      }

      let result = null;

      try {
        const rawBody = await response.text();
        result = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        result = null;
      }

      // Publish the delay before saved flags can provoke an open surface's read.
      let existingSummary = false;
      try { existingSummary = Boolean(await getReaderWatchStore().cachedSummary(MVSReaderCore.canonical(targetUrl), result?.id)); } catch { /* optional cache */ }
      try { await getReaderPanelService().recordSave(targetUrl, result?.id, { alreadyExists: response.status === 200, existingSummary }); } catch { /* optional summary refresh */ }
      // Serialize flags with panel deletion invalidation. Saving stays successful
      // if the optional document index is unavailable.
      try { await getReaderPanelService().remember(targetUrl, result?.id, () => markReaderUrlSaved(targetUrl, result?.url)); }
      catch { await markReaderUrlSaved(targetUrl, result?.url); }
      let historyWarning = false;
      try { await getReaderWatchStore().recordSave(MVSReaderCore.canonical(targetUrl), result?.id, metadata, { openExisting: message.openExisting === true }); }
      catch { historyWarning = true; }

      sendResponse({
        ok: true,
        url: result?.url || targetUrl,
        alreadyExists: response.status === 200,
        historyWarning
      });
    } catch (error) {
      sendResponse({ ok: false, code: "network_error", error: String(error) });
    }
  });

  return true;
});

chrome.action?.onClicked?.addListener(tab => {
  void openRecentSaves(tab);
});
