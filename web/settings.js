/* Authenticated settings; all durable preferences and records are server-owned. */
(() => {
  const $ = id => document.getElementById(id), transport = globalThis.MVSWatchTransport;
  const failure = result => transport.messageFor(result) || (result.code === 'rate_limited' ? 'Too many requests. Wait a moment and try again.' : 'The request could not be confirmed. Check the connection before retrying.');
  const locks = new Set();
  const run = async (key, target, action) => {
    if (locks.has(key)) return; locks.add(key);
    const button = $(key); button.disabled = true;
    try { await action($(target)); } catch { $(target).textContent = 'The request could not be completed. Try again.'; }
    finally { locks.delete(key); button.disabled = false; }
  };
  transport.subscribe(status => {
    if (!status.authenticated) return;
    $('theme').value = ['system', 'light', 'dark'].includes(status.theme) ? status.theme : 'system';
    $('timer-default').value = String(status.timerDefault || 15);
    document.documentElement.dataset.theme = $('theme').value === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : $('theme').value;
  });
  $('site-origin').value = location.origin;
  $('preferences').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('preferences').reportValidity()) return;
    void run('save-preferences', 'preferences-status', async note => {
      note.textContent = 'Saving…';
      const result = await transport.send({ type: 'cloud-settings', theme: $('theme').value, timerDefault: Number($('timer-default').value) });
      note.textContent = result.ok ? 'Settings saved.' : failure(result);
    });
  });
  $('pair').addEventListener('click', () => void run('pair', 'pair-status', async note => {
    note.textContent = 'Generating…'; $('pair-result').hidden = true; $('device-token').value = '';
    const result = await transport.send({ type: 'cloud-pair' });
    if (!result.ok) { note.textContent = failure(result); return; }
    $('device-token').value = result.token; $('pair-result').hidden = false; note.textContent = 'Token ready. Copy it into the extension’s Options.';
  }));
  $('copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('device-token').value); $('pair-status').textContent = 'Device token copied.'; }
    catch { $('device-token').type = 'text'; $('device-token').select(); $('pair-status').textContent = 'Press Copy to copy the selected token.'; }
  });
  $('revoke').addEventListener('click', () => void run('revoke', 'pair-status', async note => {
    note.textContent = 'Disconnecting…';
    const result = await transport.send({ type: 'cloud-revoke' });
    if (result.ok) { $('device-token').value = ''; $('pair-result').hidden = true; note.textContent = 'All extensions disconnected. Your cloud records are kept. Generate a new token to reconnect.'; }
    else note.textContent = failure(result);
  }));
  $('export').addEventListener('click', () => void run('export', 'export-status', async note => {
    note.textContent = 'Preparing export…';
    const items = [], seen = new Set(); let cursor = null;
    do {
      const result = await transport.send({ type: 'cloud-export', cursor });
      if (!result.ok) { note.textContent = failure(result); return; }
      if (!Array.isArray(result.items)) throw new Error('invalid export');
      items.push(...result.items); note.textContent = `Preparing export… ${items.length} records`;
      cursor = result.nextCursor || null;
      if (cursor) { const key = JSON.stringify(cursor); if (seen.has(key)) throw new Error('repeated export page'); seen.add(key); }
    } while (cursor);
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: items }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `recent-saves-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    note.textContent = `Export downloaded: ${items.length} records.`;
  }));
  window.addEventListener('pagehide', () => { $('device-token').value = ''; });
})();
