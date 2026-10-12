// Runs only on X, in the page's world. Read the selected player's current props
// on demand; never intercept requests, read cookies, or cache timeline content.
(() => {
  if (window.__minimalXVideoPageInitialized) return;
  window.__minimalXVideoPageInitialized = true;

  const mediaId = (value) => typeof value === "string"
    ? value.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//)?.[1]
    : null;
  const boundedText = (value, length) => typeof value === "string" ? value.slice(0, length) : undefined;

  const detailsForDownloadUrl = (props) => {
    // The logged-out Relay player supplies a single complete MP4 separately
    // from its HLS src. Never infer an MP4 URL from streaming fragments.
    if (typeof props?.downloadUrl !== "string" || props.downloadUrl.length > 4096) return null;
    const selectedMediaId = mediaId(props.downloadUrl);
    if (!selectedMediaId) return null;
    for (const source of [props.src, props.content?.mediaAssetUrl]) {
      const sourceMediaId = mediaId(source);
      if (sourceMediaId && sourceMediaId !== selectedMediaId) return null;
    }
    const content = props.content;
    const matchesContent = content?.contentId === selectedMediaId;
    if (content?.contentId && !matchesContent) return null;
    const metadata = matchesContent ? {
      tweetId: boundedText(content.tweetId, 25),
      displayName: boundedText(content.displayMetadata?.artist, 500)
    } : {};
    // Use this player's permalink, never the enclosing post/page (quotes may
    // have a different author). Only attribute it when the post IDs agree.
    if (matchesContent && typeof props.mediaPermalink === "string" && props.mediaPermalink.length <= 4096) {
      try {
        const url = new URL(props.mediaPermalink);
        const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/video\/\d+)?\/?$/);
        if (url.protocol === "https:" && ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname) &&
            !url.username && !url.password && !url.port && match?.[2] === metadata.tweetId) metadata.handle = match[1];
      } catch {}
    }
    return { variants: [{ url: props.downloadUrl, type: "video/mp4" }], metadata };
  };

  const metadataFromTweet = (tweet) => {
    const legacy = tweet.legacy || tweet;
    const result = tweet.core?.user_results?.result;
    const user = result?.user || result || tweet.user || legacy.user || {};
    return {
      handle: boundedText(user.core?.screen_name || user.legacy?.screen_name || user.screen_name, 16),
      displayName: boundedText(user.core?.name || user.legacy?.name || user.name, 500),
      tweetId: boundedText(tweet.rest_id || legacy.id_str, 25),
      text: boundedText(tweet.note_tweet?.note_tweet_results?.result?.text || tweet.details?.full_text || legacy.full_text || legacy.text, 2000)
    };
  };

  const metadataForRelayFiber = (fiber, tweetId) => {
    if (typeof tweetId !== "string" || !/^\d{1,25}$/.test(tweetId)) return null;
    // Relay props are fragment references. Its resolved post text is in a
    // hook snapshot on this player's ancestor chain. Read only matching post
    // data; never traverse the environment, store, or other timeline records.
    const visited = new Set();
    for (let hook = fiber.memoizedState; hook && !visited.has(hook) && visited.size < 64; hook = hook.next) {
      visited.add(hook);
      const tweet = hook.memoizedState?.snapshot?.data;
      if (tweet?.rest_id !== tweetId) continue;
      const metadata = metadataFromTweet(tweet);
      if (metadata.text !== undefined) return metadata;
    }
    return null;
  };

  const metadataForTweet = (tweet, selectedMediaId, depth = 0) => {
    if (!tweet || typeof tweet !== "object" || depth > 3) return null;
    const legacy = tweet.legacy || tweet;
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];
    if (selectedMediaId && Array.isArray(media) && media.some((item) =>
      Array.isArray(item?.video_info?.variants) && item.video_info.variants.some((variant) => mediaId(variant?.url || variant?.src) === selectedMediaId))) {
      return metadataFromTweet(tweet);
    }
    // Quoted and reposted videos belong to their own post. Never use the
    // enclosing tweet's author/text unless its own media matches this player.
    for (const nested of [tweet.tweet, tweet.result, tweet.quoted_status_result?.result,
      tweet.retweeted_status_result?.result, legacy.quoted_status, legacy.retweeted_status]) {
      const metadata = metadataForTweet(nested, selectedMediaId, depth + 1);
      if (metadata) return metadata;
    }
    return null;
  };

  const findVideoDetails = (video) => {
    // The HTML video is managed imperatively, so its first React-owned ancestor
    // holds the player fiber. Walking parents (never siblings) keeps videos in
    // quoted posts and multi-video posts separate.
    for (let element = video, depth = 0; element && depth < 8; element = element.parentElement, depth++) {
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      if (!key) continue;
      let fiber = element[key];
      let variants = null;
      let playerMetadata = {};
      const visited = new Set();
      // X's player can have over 90 ancestors before the tweet props. Follow
      // the parent chain to its root; protect against cycles and excessive depth.
      for (; fiber && !visited.has(fiber) && visited.size < 512; fiber = fiber.return) {
        visited.add(fiber);
        const props = fiber.memoizedProps;
        if (!variants && Array.isArray(props?.variants)) {
          variants = props.variants.slice(0, 32).map((variant) => ({
            url: variant?.src || variant?.url,
            type: variant?.type || variant?.content_type || variant?.contentType,
            bitrate: variant?.bitrate ?? variant?.bit_rate
          }));
        }
        if (!variants && props?.downloadUrl !== undefined) {
          const details = detailsForDownloadUrl(props);
          // An invalid/recycled player source must not fall through to a
          // wider ancestor that could belong to a different video.
          if (!details) return { variants: [], metadata: {} };
          variants = details.variants;
          playerMetadata = details.metadata;
        }
        if (variants) {
          const selectedMediaId = variants.map((variant) => mediaId(variant.url)).find(Boolean);
          const metadata = metadataForTweet(props?.tweet, selectedMediaId);
          if (metadata) return { variants, metadata };
          const relayMetadata = metadataForRelayFiber(fiber, playerMetadata.tweetId);
          if (relayMetadata) return {
            variants,
            metadata: { ...playerMetadata, ...Object.fromEntries(Object.entries(relayMetadata).filter(([, value]) => value !== undefined)) }
          };
        }
      }
      // Do not search a wider post/timeline if this player has no variants.
      return { variants: variants || [], metadata: playerMetadata };
    }
    return { variants: [], metadata: {} };
  };

  document.addEventListener("mvs-x-video-request", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
    const requestId = video.getAttribute("data-mvs-x-request");
    if (!requestId || !/^[a-f0-9-]{36}$/.test(requestId)) return;
    let details = { variants: [], metadata: {} };
    try {
      details = findVideoDetails(video);
    } catch {
      // A changed X player should fail without interfering with playback.
    }
    video.dispatchEvent(new CustomEvent("mvs-x-video-response", {
      detail: JSON.stringify({ requestId, ...details })
    }));
  });
})();
