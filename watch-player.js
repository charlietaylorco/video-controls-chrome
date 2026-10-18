/* One explicit, cross-origin player. No credentials, remote parent scripts or messages. */
(() => {
  const create = ({ document = globalThis.document, window = globalThis.window, announce = () => {} } = {}) => {
    let active = null;
    const fits = host => {
      const bounds = host.getBoundingClientRect();
      return bounds.width >= 200 && bounds.height >= 200;
    };
    const clear = ({ focus = false } = {}) => {
      if (!active) return;
      const previous = active; active = null;
      previous.frame.remove(); previous.trigger.hidden = false; previous.close.hidden = true;
      if (focus && previous.trigger.isConnected) previous.trigger.focus();
    };
    const open = target => {
      const { videoUrl, title, host, trigger, close } = target;
      if (globalThis.MVSReaderCore.canonical(videoUrl) !== videoUrl || !host.isConnected || document.hidden) return false;
      clear();
      if (!fits(host)) { announce('The player needs more space. Open on YouTube instead.', true); return false; }
      const frame = document.createElement('iframe');
      frame.title = `YouTube player: ${title || 'saved video'}`;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.src = `https://www.youtube.com/embed/${encodeURIComponent(new URL(videoUrl).searchParams.get('v'))}?autoplay=0&playsinline=1`;
      active = { videoUrl, frame, host, trigger, close };
      trigger.hidden = true; close.hidden = false;
      frame.addEventListener('error', () => {
        if (active?.frame !== frame) return;
        clear({ focus: true }); announce('The player could not be loaded. Open on YouTube instead.', true);
      });
      host.append(frame); frame.focus();
      // A cross-origin load event cannot establish playback or detect YouTube error 153.
      announce('YouTube player opened.');
      return true;
    };
    const keep = urls => { if (active && !urls.includes(active.videoUrl)) clear(); };
    const hide = () => { if (document.hidden) clear(); };
    const resize = () => {
      if (!active || fits(active.host)) return;
      const focus = document.activeElement === active.frame || document.activeElement === active.close;
      clear({ focus }); announce('The player needs more space. Open on YouTube instead.', true);
    };
    const leave = () => clear();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave); window.addEventListener('resize', resize);
    return { open, clear, keep, currentUrl: () => active?.videoUrl || null,
      destroy() { clear(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave); window.removeEventListener('resize', resize); } };
  };
  globalThis.MVSWatchPlayer = { create };
})();
