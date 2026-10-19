/* One routine toast plus a persistent error; never changes document flow/focus. */
(() => {
  const create = ({ routine, error, live, now = Date.now, schedule = setTimeout, cancel = clearTimeout, page = document }) => {
    let timer, announcement, remaining = 6000, started = 0, hovered = false, focused = false, routineOrigin, errorOrigin;
    const text = box => box.querySelector('p');
    const speak = message => {
      cancel(announcement); live.textContent = '';
      announcement = schedule(() => { live.textContent = message; }, 30);
    };
    const pause = () => { if (timer) { cancel(timer); timer = null; remaining = Math.max(0, remaining - (now() - started)); } };
    const hideRoutine = () => { pause(); routine.hidden = true; text(routine).textContent = ''; };
    const resume = () => {
      if (routine.hidden || hovered || focused || page.hidden || timer) return;
      started = now(); timer = schedule(() => { timer = null; hideRoutine(); }, remaining);
    };
    const restore = (box, origin) => {
      if (box.contains(page.activeElement) && origin?.isConnected && !origin.disabled) origin.focus({ preventScroll: true });
    };
    routine.querySelector('button').addEventListener('click', () => { restore(routine, routineOrigin); hideRoutine(); });
    error.querySelector('button').addEventListener('click', () => { restore(error, errorOrigin); error.hidden = true; text(error).textContent = ''; });
    routine.addEventListener('pointerenter', () => { hovered = true; pause(); });
    routine.addEventListener('pointerleave', () => { hovered = false; resume(); });
    routine.addEventListener('focusin', () => { focused = true; pause(); });
    routine.addEventListener('focusout', event => { focused = routine.contains(event.relatedTarget); if (!focused) resume(); });
    page.addEventListener('visibilitychange', () => page.hidden ? pause() : resume());
    const show = (message, isError = false) => {
      if (!message) { hideRoutine(); return; }
      const box = isError ? error : routine;
      if (!box.contains(page.activeElement)) { if (isError) errorOrigin = page.activeElement; else routineOrigin = page.activeElement; }
      text(box).textContent = message; box.hidden = false; speak(message);
      if (!isError) { pause(); remaining = 6000; resume(); }
    };
    return { show };
  };
  globalThis.MVSWatchFeedback = { create };
})();
