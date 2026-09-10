// Runs only on X, in the page's world. Read the selected player's current props
// on demand; never intercept requests, read cookies, or cache timeline content.
(() => {
  if (window.__minimalXVideoPageInitialized) return;
  window.__minimalXVideoPageInitialized = true;

  const findVariants = (video) => {
    // The HTML video is managed imperatively, so its first React-owned ancestor
    // holds the player fiber. Walking parents (never siblings) keeps videos in
    // quoted posts and multi-video posts separate.
    for (let element = video, depth = 0; element && depth < 8; element = element.parentElement, depth++) {
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      if (!key) continue;
      let fiber = element[key];
      for (let index = 0; fiber && index < 40; index++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!Array.isArray(props?.variants)) continue;
        return props.variants.slice(0, 32).map((variant) => ({
          url: variant?.src || variant?.url,
          type: variant?.type || variant?.content_type || variant?.contentType,
          bitrate: variant?.bitrate ?? variant?.bit_rate
        }));
      }
      // Do not search a wider post/timeline if this player has no variants.
      return [];
    }
    return [];
  };

  document.addEventListener("mvs-x-video-request", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
    const requestId = video.getAttribute("data-mvs-x-request");
    if (!requestId || !/^[a-f0-9-]{36}$/.test(requestId)) return;
    let variants = [];
    try {
      variants = findVariants(video);
    } catch {
      // A changed X player should fail without interfering with playback.
    }
    video.dispatchEvent(new CustomEvent("mvs-x-video-response", {
      detail: JSON.stringify({ requestId, variants })
    }));
  });
})();
