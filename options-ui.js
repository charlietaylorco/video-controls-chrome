(() => {
  // Share the existing Reader / Recent saves preference, including live changes.
  const media = matchMedia('(prefers-color-scheme: dark)');
  let theme = 'system';
  const normalizeTheme = value => ['light', 'dark'].includes(value) ? value : 'system';
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
  };
  chrome.storage.local.get({ readerPanelTheme: 'system' }, values => {
    theme = normalizeTheme(values.readerPanelTheme);
    applyTheme();
  });
  media.addEventListener('change', applyTheme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.readerPanelTheme) return;
    theme = normalizeTheme(changes.readerPanelTheme.newValue);
    document.getElementById('reader-panel-theme').value = theme;
    applyTheme();
  });

  const navLinks = [...document.querySelectorAll('.section-nav a')];
  const sections = navLinks.map(link => document.querySelector(link.getAttribute('href')));
  let frame;
  const updateNavigation = () => {
    frame = null;
    const threshold = Math.min(180, innerHeight * .25);
    let index = 0;
    sections.forEach((section, current) => {
      if (section.getBoundingClientRect().top <= threshold) index = current;
    });
    // The final section may be too short to reach the activation threshold.
    if (scrollY + innerHeight >= document.documentElement.scrollHeight - 2) index = sections.length - 1;
    navLinks.forEach((link, current) => {
      if (current === index) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const scheduleNavigation = () => { if (!frame) frame = requestAnimationFrame(updateNavigation); };
  window.addEventListener('scroll', scheduleNavigation, { passive: true });
  window.addEventListener('resize', scheduleNavigation);
  window.addEventListener('load', scheduleNavigation);
  updateNavigation();

  window.MVSOptionsUI = {
    updateHoverPreview(bands) {
      const outsideWidth = Math.max(0, (100 - bands.center.width) / 2 - bands.middle.width - bands.outer.width);
      document.querySelectorAll('[data-band]').forEach(node => {
        const band = bands[node.dataset.band] || { width: outsideWidth, speed: 0 };
        node.hidden = band.width <= 0;
        node.style.flexBasis = `${band.width}%`;
        node.dataset.enabled = String(band.speed > 0);
        node.firstElementChild.textContent = band.speed > 0 ? `${band.speed}×` : 'Saved';
      });
    }
  };
})();
