// Runs only on X, in the page's world. Read the selected player's current props
// on demand; never intercept requests, read cookies, or cache timeline content.
(() => {
  if (window.__minimalXVideoPageInitialized) return;
  window.__minimalXVideoPageInitialized = true;

  const mediaId = (value) => typeof value === "string"
    ? value.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//)?.[1]
    : null;
  const boundedText = (value, length) => typeof value === "string" ? value.slice(0, length) : undefined;

  const metadataForTweet = (tweet, selectedMediaId, depth = 0) => {
    if (!tweet || typeof tweet !== "object" || depth > 3) return null;
    const legacy = tweet.legacy || tweet;
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];
    if (selectedMediaId && Array.isArray(media) && media.some((item) =>
      Array.isArray(item?.video_info?.variants) && item.video_info.variants.some((variant) => mediaId(variant?.url || variant?.src) === selectedMediaId))) {
      const user = tweet.core?.user_results?.result || tweet.user || legacy.user || {};
      return {
        handle: boundedText(user.core?.screen_name || user.legacy?.screen_name || user.screen_name, 16),
        displayName: boundedText(user.core?.name || user.legacy?.name || user.name, 500),
        tweetId: boundedText(tweet.rest_id || legacy.id_str, 25),
        text: boundedText(tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || legacy.text, 2000)
      };
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
        if (variants) {
          const selectedMediaId = variants.map((variant) => mediaId(variant.url)).find(Boolean);
          const metadata = metadataForTweet(props?.tweet, selectedMediaId);
          if (metadata) return { variants, metadata };
        }
      }
      // Do not search a wider post/timeline if this player has no variants.
      return { variants: variants || [], metadata: {} };
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
