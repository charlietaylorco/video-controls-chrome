/* Debounced local criteria. Changes invalidate old results before any delay. */
(() => {
  const create = ({ input, clear, chip, tagChip, onChange, schedule = setTimeout, cancel = clearTimeout }) => {
    let query = '', channel = '', tag = '', timer, composing = false;
    const paint = () => {
      clear.disabled = !query && !channel && !tag;
      chip.hidden = !channel; chip.textContent = channel ? `Channel: ${channel} ×` : '';
      chip.setAttribute('aria-label', `Clear exact channel filter: ${channel}`);
      tagChip.hidden = !tag; tagChip.textContent = tag ? `Tag: ${tag} ×` : '';
      tagChip.setAttribute('aria-label', `Clear exact tag filter: ${tag}`);
    };
    const change = (immediate = false) => {
      cancel(timer); paint();
      // onChange returns the generation-bound loader. A later input must never
      // allow an old response to render, including during IME composition.
      const load = onChange({ query, channel, tag });
      if (!composing) { if (immediate) load(); else timer = schedule(load, 180); }
    };
    input.addEventListener('input', () => { query = input.value; change(); });
    input.addEventListener('compositionstart', () => { composing = true; cancel(timer); });
    input.addEventListener('compositionend', () => { composing = false; query = input.value; change(); });
    input.addEventListener('keydown', event => { if (event.key === 'Escape' && query && !composing && !event.isComposing) { event.preventDefault(); input.value = query = ''; change(true); } });
    clear.addEventListener('click', () => { input.value = query = channel = tag = ''; change(true); input.focus({ preventScroll: true }); });
    chip.addEventListener('click', () => { channel = ''; change(true); input.focus({ preventScroll: true }); });
    const setChannel = value => { channel = value; change(true); chip.focus({ preventScroll: true }); };
    tagChip.addEventListener('click', () => { tag = ''; change(true); input.focus({ preventScroll: true }); });
    const setTag = value => { if (tag !== value) { tag = value; change(true); } tagChip.focus({ preventScroll: true }); };
    const reset = () => { input.value = query = channel = tag = ''; change(true); };
    paint(); return { setChannel, setTag, reset };
  };
  globalThis.MVSWatchSearch = { create };
})();
