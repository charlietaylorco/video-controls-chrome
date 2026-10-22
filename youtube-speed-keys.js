/* Register before YouTube's page listeners. All state stays in the extension's
 * isolated world; content.js supplies the existing rate/hover-preview rules. */
(() => {
  if (window.MVSYouTubeSpeedKeys || window.top !== window) return;

  let stepRate = null;
  let navigating = false;
  const held = new Set();
  window.MVSYouTubeSpeedKeys = { setStepHandler(handler) { stepRate = handler; } };

  const directionFor = (event) => {
    if (event.key === '>' || event.key === '.') return 1;
    if (event.key === '<' || event.key === ',') return -1;
    // Legacy/automation events may omit key. Never reinterpret another layout's
    // explicitly reported character as US punctuation based only on its code.
    if (event.key && event.key !== 'Unidentified') return 0;
    if (event.code === 'Period' || event.keyCode === 190) return 1;
    if (event.code === 'Comma' || event.keyCode === 188) return -1;
    return 0;
  };

  const isEditing = (event) => {
    if (document.designMode === 'on') return true;
    return [...event.composedPath(), document.activeElement].some(node =>
      node instanceof Element && (node.isContentEditable || node.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
        '[role="textbox"], [role="searchbox"], [role="combobox"]'
      ))
    );
  };

  const currentVideo = () => {
    const url = new URL(window.location.href);
    if (navigating || url.protocol !== 'https:' ||
        !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) ||
        url.pathname !== '/watch' || !url.searchParams.get('v')) return null;
    const player = document.getElementById('movie_player');
    if (!player || player.closest('[hidden], [aria-hidden="true"]')) return null;
    const watch = player.closest('ytd-watch-flexy');
    const videoId = watch?.getAttribute('video-id');
    if (videoId && videoId !== url.searchParams.get('v')) return null;
    const fullscreen = document.fullscreenElement;
    if (fullscreen && !fullscreen.contains(player) && !player.contains(fullscreen)) return null;
    const video = player.querySelector('video.html5-main-video');
    return video instanceof HTMLVideoElement && video.isConnected &&
      !video.closest('[hidden], [aria-hidden="true"]') && video.getClientRects().length
      ? video : null;
  };

  const consume = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', event => {
    const direction = directionFor(event);
    if (!stepRate || !direction || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
        event.getModifierState?.('AltGraph') || event.isComposing || event.keyCode === 229 ||
        event.defaultPrevented || isEditing(event)) return;
    const video = currentVideo();
    if (!video) return;
    held.add(direction);
    consume(event);
    stepRate(video, direction * 0.25);
  }, true);

  // Some player versions also listen to keypress/keyup. Only suppress the rest
  // of a sequence whose keydown we handled, including releasing Shift first.
  for (const type of ['keypress', 'keyup']) {
    window.addEventListener(type, event => {
      const direction = directionFor(event);
      if (!held.has(direction)) return;
      if (type === 'keyup') held.delete(direction);
      consume(event);
    }, true);
  }
  window.addEventListener('blur', () => held.clear());
  document.addEventListener('yt-navigate-start', () => { navigating = true; held.clear(); }, true);
  document.addEventListener('yt-navigate-finish', () => { navigating = false; }, true);
})();
