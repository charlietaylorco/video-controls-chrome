/* Save-time YouTube runtime capture. Never uses a thumbnail preview clip's duration. */
(() => {
  const C = globalThis.MVSReaderCore;
  let bindings = new WeakMap();
  const pageIdentity = () => {
    const url = C.canonical(location.href), host = document.querySelector('ytd-watch-flexy[video-id]');
    return url && host?.getAttribute('video-id') === new URL(url).searchParams.get('v') ? url : null;
  };
  const player = () => document.querySelector('#movie_player');
  const livePage = () => document.querySelector('ytd-watch-flexy[is-live]') ||
    [...document.querySelectorAll('.ytp-live-badge')].some(node => node.getClientRects().length > 0);
  const bind = video => {
    bindings.delete(video);
    const url = pageIdentity(), currentPlayer = player();
    if (livePage() || currentPlayer?.classList.contains('ad-showing') || currentPlayer?.classList.contains('ad-interrupting')) return;
    if (!url || video?.closest?.('#movie_player') !== player() || !video.currentSrc || video.readyState < 1) return;
    bindings.set(video, { url, src: video.currentSrc });
  };
  document.addEventListener('loadedmetadata', event => bind(event.target), true);
  // A URL or page identity change cannot inherit an old player's duration.
  document.addEventListener('yt-navigate-start', () => { bindings = new WeakMap(); });
  window.addEventListener('popstate', () => { bindings = new WeakMap(); });
  for (const video of document.querySelectorAll('#movie_player video')) bind(video);
  const parse = text => {
    const parts = String(text || '').trim().split(':');
    if (parts.length < 2 || parts.length > 3 || !/^\d+$/.test(parts[0]) || parts.slice(1).some(part => !/^[0-5]\d$/.test(part))) return null;
    return C.durationSeconds(parts.reduce((seconds, part) => seconds * 60 + Number(part), 0));
  };
  const capture = ({ source, videoUrl, card = false }) => {
    const url = C.canonical(videoUrl);
    if (!url || !source?.isConnected) return {};
    const result = { durationVideoUrl: url };
    if (card) {
      const ids = new Set([...source.querySelectorAll('a[href]')].map(node => C.canonical(node.href)).filter(Boolean));
      if (ids.size !== 1 || !ids.has(url)) return {};
      const badges = [...source.querySelectorAll('ytd-thumbnail-overlay-time-status-renderer, .yt-badge-shape__text, .ytThumbnailOverlayBadgeViewModelBadgeText')];
      if (badges.some(node => ['LIVE', 'UPCOMING'].includes(node.getAttribute('overlay-style')) || /^(live|upcoming|premiere)$/i.test(node.textContent.trim())))
        return { ...result, durationIsLive: true };
      for (const badge of badges) { const seconds = parse(badge.textContent); if (seconds) return { ...result, durationSeconds: seconds }; }
      return result;
    }
    if (pageIdentity() !== url) return {};
    if (livePage()) return { ...result, durationIsLive: true };
    const currentPlayer = player();
    if (!currentPlayer || currentPlayer.classList.contains('ad-showing') || currentPlayer.classList.contains('ad-interrupting')) return result;
    for (const video of currentPlayer.querySelectorAll('video')) {
      const bound = bindings.get(video);
      if (bound?.url === url && bound.src === video.currentSrc && video.readyState >= 1) {
        const seconds = C.durationSeconds(video.duration);
        if (seconds) return { ...result, durationSeconds: seconds };
      }
    }
    return result;
  };
  globalThis.MVSReaderDuration = { capture, parse };
})();
