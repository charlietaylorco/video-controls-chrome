/* One portaled menu with a captured document identity and native button focus. */
(() => {
  const create = ({ document = globalThis.document, window = globalThis.window, isCurrent, choose }) => {
    const root = document.createElement('div'); root.id = 'recent-location-menu'; root.className = 'location-menu'; root.hidden = true; root.setAttribute('role', 'menu'); document.body.append(root);
    let current = null;
    const options = [...Object.entries(globalThis.MVSReaderCore.locations), ['trash', 'Trash…']];
    const buttons = options.map(([value, label]) => {
      if (value === 'trash') { const separator = document.createElement('div'); separator.className = 'menu-separator'; separator.setAttribute('role', 'separator'); root.append(separator); }
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1; button.className = value === 'trash' ? 'menu-item destructive-item' : 'menu-item';
      button.setAttribute('role', value === 'trash' ? 'menuitem' : 'menuitemradio'); button.setAttribute('aria-label', label);
      const text = document.createElement('span'); text.textContent = label; button.append(text);
      const check = document.createElement('span'); check.className = 'menu-check'; check.setAttribute('aria-hidden', 'true'); button.append(check);
      button.addEventListener('click', () => {
        const captured = current;
        if (!captured || !isCurrent(captured)) { close(true); return; }
        close(true); choose(captured, value);
      });
      root.append(button); return { button, check, value, label };
    });
    const close = (focus = false) => {
      const previous = current; current = null; root.hidden = true;
      previous?.trigger.setAttribute('aria-expanded', 'false');
      for (const { button } of buttons) button.tabIndex = -1;
      if (focus && previous?.trigger.isConnected && !previous.trigger.disabled) previous.trigger.focus({ preventScroll: true });
    };
    const focusAt = index => { buttons.forEach(({ button }, i) => { button.tabIndex = i === index ? 0 : -1; }); buttons[index].button.focus({ preventScroll: true }); };
    const place = () => {
      if (!current) return;
      if (!isCurrent(current) || !current.trigger.isConnected || current.trigger.disabled) { close(true); return; }
      const width = Math.min(184, window.innerWidth - 16), available = Math.max(40, window.innerHeight - 16), b = current.trigger.getBoundingClientRect();
      root.style.width = `${width}px`; root.style.maxHeight = `${available}px`;
      const height = Math.min(root.scrollHeight, available);
      let top = b.bottom + 5; if (top + height > window.innerHeight - 8) top = b.top - height - 5;
      root.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - width - 8))}px`;
      root.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    };
    const open = (target, edge) => {
      close(); if (!isCurrent(target) || target.trigger.disabled || !target.trigger.isConnected) return;
      current = Object.freeze({ ...target }); root.setAttribute('aria-label', `Saved location for ${target.title || 'video'}`);
      for (const row of buttons) {
        if (row.value !== 'trash') row.button.setAttribute('aria-checked', String(row.value === target.location));
        row.check.textContent = row.value === target.location ? '✓' : '';
      }
      root.hidden = false; target.trigger.setAttribute('aria-expanded', 'true'); place();
      if (current) focusAt(edge === 'last' ? buttons.length - 1 : edge === 'first' ? 0 : Math.max(0, buttons.findIndex(row => row.value === target.location)));
    };
    const keydown = event => {
      if (!current) return;
      const index = Math.max(0, buttons.findIndex(row => row.button === document.activeElement));
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; focusAt(next);
      } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const next = buttons.findIndex((_, offset) => buttons[(index + 1 + offset) % buttons.length].label.toLowerCase().startsWith(event.key.toLowerCase()));
        if (next >= 0) { event.preventDefault(); focusAt((index + 1 + next) % buttons.length); }
      }
    };
    const outside = event => { if (current && !root.contains(event.target) && !current.trigger.contains(event.target)) close(); };
    root.addEventListener('keydown', keydown); document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return { id: root.id, open, close, refresh: place, toggle(target) { if (current?.trigger === target.trigger) close(); else open(target); },
      destroy() { close(); root.remove(); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); } };
  };
  globalThis.MVSWatchLocationMenu = { create };
})();
