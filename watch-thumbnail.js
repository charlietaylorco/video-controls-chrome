/* One lazy image request at a time; fall back only after failure/placeholder. */
(() => {
  const candidates = [
    ['maxresdefault', 640, 360], ['sddefault', 480, 270],
    ['hqdefault', 320, 180], ['mqdefault', 160, 90]
  ];
  const attach = (image, videoUrl, { onUnavailable = () => {} } = {}) => {
    const url = globalThis.MVSReaderCore.canonical(videoUrl);
    let index = -1, expected = '', finished = false;
    image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    image.width = 1280; image.height = 720; image.referrerPolicy = 'no-referrer';
    const destroy = () => { finished = true; image.removeEventListener('load', loaded); image.removeEventListener('error', failed); };
    const advance = () => {
      if (finished) return;
      if (!url || ++index >= candidates.length) { destroy(); image.hidden = true; onUnavailable(); return; }
      expected = `https://i.ytimg.com/vi/${encodeURIComponent(new URL(url).searchParams.get('v'))}/${candidates[index][0]}.jpg`;
      image.src = expected;
    };
    const current = () => !finished && (!image.currentSrc || image.currentSrc === expected);
    const loaded = () => {
      if (!current()) return;
      // Unavailable sizes can load successfully as a tiny generic image. Check
      // decoded dimensions; HTTP success by itself is not evidence of quality.
      const [, width, height] = candidates[index];
      if (image.naturalWidth < width || image.naturalHeight < height) advance();
      else destroy();
    };
    const failed = () => { if (current()) advance(); };
    image.addEventListener('load', loaded); image.addEventListener('error', failed); advance();
    return { destroy };
  };
  globalThis.MVSWatchThumbnail = { attach };
})();
