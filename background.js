const DOWNIE_PREFIX = "downie://XUOpenLink?url=";
const READER_SAVE_URL = "https://readwise.io/api/v3/save/";
const READER_SOURCE = "minimal-video-speed";

const isHttpUrl = (value) => /^https?:\/\//i.test(value || "");
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
const isYouTubeWatchUrl = (url) =>
  YOUTUBE_HOSTS.includes(url.hostname) && url.pathname === "/watch";
const isYouTubeChannelPageUrl = (value) => {
  if (!isHttpUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);

    if (!YOUTUBE_HOSTS.includes(url.hostname)) {
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
    return isYouTubeWatchUrl(url) || /^\/(shorts|live)\//.test(url.pathname);
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

    if (isYouTubeWatchUrl(url)) {
      return true;
    }

    return ["youtu.be", "www.youtu.be"].includes(url.hostname) || /^\/(shorts|live)\//.test(url.pathname);
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
        url.searchParams.set("v", videoId);
      }

      return url.toString();
    }

    return url.toString();
  } catch {
    return value;
  }
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
  if (message?.type === "open-in-downie") {
    const tabId = sender?.tab?.id;
    const targetUrl = pickTargetUrl(message, sender);

    if (!Number.isInteger(tabId) || !targetUrl) {
      sendResponse({ ok: false });
      return undefined;
    }

    chrome.tabs.update(tabId, { url: encodeDownieActionUrl(targetUrl) }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      sendResponse({ ok: true, url: targetUrl });
    });

    return true;
  }

  if (message?.type !== "save-to-reader") {
    if (message?.type === "open-options") {
      chrome.runtime.openOptionsPage();
    }

    return undefined;
  }

  const targetUrl = normalizeTargetUrl(message?.pageUrl || sender?.tab?.url);

  chrome.storage.local.get({ readerToken: "" }, async ({ readerToken }) => {
    if (!targetUrl || !isHttpUrl(targetUrl)) {
      sendResponse({ ok: false, code: "invalid_url" });
      return;
    }

    if (!readerToken) {
      sendResponse({ ok: false, code: "missing_token" });
      return;
    }

    try {
      const metadata = await enrichYouTubeMetadata(targetUrl, sender?.tab?.url, {
        title: message?.title || undefined,
        author: message?.author || undefined
      });

      const response = await fetch(READER_SAVE_URL, {
        method: "POST",
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

      sendResponse({
        ok: true,
        url: result?.url || targetUrl,
        alreadyExists: response.status === 200
      });
    } catch (error) {
      sendResponse({ ok: false, code: "network_error", error: String(error) });
    }
  });

  return true;
});
