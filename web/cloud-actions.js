/* Destination actions for the hosted page; integration secrets remain on the server. */
(() => {
  const create = ({ send, announce }) => {
    const rows = new Set(), pending = new Set(); let status = {};
    const render = row => {
      row.rain.hidden = status.raindropEnabled !== true;
      row.rain.disabled = !row.enabled || pending.has(row.url);
      row.rain.title = pending.has(row.url) ? 'Saving to Raindrop…' : row.saved ? 'Saved to Raindrop' : 'Save video to Raindrop';
      row.rain.setAttribute('aria-label', `${row.rain.title}: ${row.title}`); row.rain.dataset.saved = String(row.saved);
      row.downie.setAttribute('aria-label', `Open ${row.title} in Downie`);
      row.downie.setAttribute('aria-disabled', String(!row.enabled));
    };
    MVSWatchTransport.subscribe(next => { status = next; for (const row of rows) render(row); });
    const attach = (parent, url) => {
      const group = document.createElement('div'); group.className = 'card-destination-actions'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Raindrop and Downie'); parent.append(group);
      const row = { url, title: 'video', enabled: false, saved: false };
      const action = (tag, path, title) => {
        const button = document.createElement(tag); button.className = 'destination-action card-destination-action'; button.title = title; if (tag === 'button') button.type = 'button';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', path); svg.append(line); button.append(svg); group.append(button); return button;
      };
      row.rain = action('button', 'M6 19h12a4 4 0 0 0 .7-7.94A7 7 0 0 0 5.2 9.1 5 5 0 0 0 6 19Z', 'Save video to Raindrop');
      row.downie = action('a', 'M12 4v9m-3.5-2.5 3.5 3.5 3.5-3.5M5 18h14', 'Open in Downie');
      row.downie.href = `downie://XUOpenLink?url=${encodeURIComponent(url)}`;
      row.downie.addEventListener('click', event => {
        event.stopPropagation(); if (!row.enabled) { event.preventDefault(); return; }
        announce('Downie handoff requested. Your browser may ask to open the app.');
      });
      row.rain.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation(); if (!row.enabled || pending.has(url) || !rows.has(row)) return;
        pending.add(url); for (const r of rows) render(r);
        const result = await send({ type: 'watch-card-action', action: 'raindrop', videoUrl: url });
        pending.delete(url); if (result.ok) row.saved = true; for (const r of rows) render(r);
        announce(result.ok ? 'Saved to Raindrop.' : ['request_uncertain', 'save_uncertain', 'network_error'].includes(result.code) ? 'The save could not be confirmed. Check Raindrop before retrying.' : 'Could not save to Raindrop. Check the website’s connection before retrying.', !result.ok);
      });
      rows.add(row); render(row);
      return { update(title, enabled) { row.title = title || 'video'; row.enabled = enabled; render(row); }, destroy() { rows.delete(row); row.enabled = false; } };
    };
    return { attach };
  };
  globalThis.MVSWatchCardActions = { create };
})();
