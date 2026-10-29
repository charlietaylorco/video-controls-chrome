/* Capture only text already present on the exact current YouTube watch page. */
(() => {
  const capture = ({ videoUrl, document: doc = globalThis.document, location: current = globalThis.location } = {}) => {
    const C = globalThis.MVSReaderCore;
    const url = C?.canonical(videoUrl);
    if (!url || C.canonical(current?.href) !== url || !doc?.querySelector) return {};
    const id = new URL(url).searchParams.get('v');
    const watch = doc.querySelector('ytd-watch-flexy[video-id]');
    // Both the browser URL and mounted player identity must agree. YouTube SPA
    // navigation can change either before replacing the previous description.
    if (!watch || watch.getAttribute('video-id') !== id || watch.hasAttribute('hidden')) return {};
    const text = watch.querySelector('#description-inline-expander #attributed-description-text, #description-inline-expander > yt-attributed-string')?.textContent;
    if (typeof text !== 'string' || !text.trim()) return {};
    return { description: text.trim().slice(0, 20000), descriptionVideoUrl: url };
  };
  globalThis.MVSReaderDescription = { capture };
  if (typeof module !== 'undefined') module.exports = { capture };
})();
