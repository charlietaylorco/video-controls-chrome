/* Authenticated settings; all durable preferences and records are server-owned. */
(() => {
  const backupRecords = value => {
    if (value && !Array.isArray(value) && value.version != null && value.version !== 1) throw new Error('This backup version is not supported.');
    const source = Array.isArray(value) ? value : value?.records || value?.items;
    if (!Array.isArray(source)) throw new Error('Choose a metadata JSON export from the extension or Watchlater.');
    const fields = ['videoUrl', 'readerId', 'savedAt', 'firstSavedAt', 'title', 'author', 'description', 'notes', 'summary', 'summaryTruncated', 'tags', 'location', 'status', 'checkedAt', 'durationSeconds', 'durationIsLive', 'provenance', 'revision'];
    const seen = new Set(), records = []; let skippedDeleted = 0;
    for (const row of source) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('The backup contains an invalid record.');
      if (row.status === 'deleted') { skippedDeleted++; continue; }
      let url;
      try { url = new URL(row.videoUrl); } catch { throw new Error('The backup contains an invalid video address.'); }
      if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/watch' || !/^[\w-]{1,100}$/.test(url.searchParams.get('v') || '') || url.href !== `https://www.youtube.com/watch?v=${url.searchParams.get('v')}` || !Number.isFinite(row.savedAt) || row.savedAt <= 0) throw new Error('The backup contains an invalid saved-video record.');
      if (seen.has(row.videoUrl)) throw new Error('The backup contains duplicate video addresses.');
      if (['description', 'notes', 'summary'].some(key => row[key] != null && (typeof row[key] !== 'string' || row[key].length > 64000))) throw new Error('A saved text field exceeds the supported 64,000-character length.');
      seen.add(row.videoUrl);
      records.push(Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
    }
    return { records, skippedDeleted };
  };
  const importBackup = async (value, transport, onProgress = () => {}) => {
    const { records, skippedDeleted } = backupRecords(value);
    const initial = await transport.send({ type: 'cloud-ping' });
    if (!initial.ok || typeof initial.scope !== 'string' || !initial.scope) throw new Error('Could not verify the signed-in library. Sign in again before importing.');
    let imported = 0;
    for (let offset = 0; offset < records.length; offset += 5) {
      const session = await transport.send({ type: 'cloud-ping' });
      if (!session.ok || session.scope !== initial.scope) throw new Error(`Import stopped after ${imported} records because the library connection changed. Sign in and import the same file again.`);
      const items = records.slice(offset, offset + 5);
      const result = await transport.send({ type: 'cloud-import', items, scope: initial.scope });
      const expected = items.map(row => row.videoUrl).sort();
      if (!result.ok || result.scope !== initial.scope || !Array.isArray(result.accepted) || JSON.stringify([...result.accepted].sort()) !== JSON.stringify(expected)) throw new Error(`Import stopped after ${imported} verified records. It is safe to import the same file again after checking the connection.`);
      imported += items.length; onProgress(imported, records.length, skippedDeleted);
    }
    return { imported, skippedDeleted };
  };
  if (typeof module !== 'undefined') module.exports = { backupRecords, importBackup };
  if (!globalThis.document) return;
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
  $('check-integrations').addEventListener('click', async () => {
    const button=$('check-integrations'), note=$('integrations-status');button.disabled=true;note.textContent='Checking…';
    const result=await transport.send({type:'cloud-check-integrations'});
    const label=value=>!value?.configured?'not configured':value.connected?'connected':'could not connect';
    note.textContent=result.ok?`Reader: ${label(result.reader)}. Raindrop: ${label(result.raindrop)}.`:'Could not check connections. Try again.';
    button.disabled=false;
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
  $('import-backup-form').addEventListener('submit', event => {
    event.preventDefault();
    const file = $('import-backup-file').files?.[0];
    if (!file) return;
    void run('import-backup', 'import-status', async note => {
      if (file.size > 50 * 1024 * 1024) { note.textContent = 'This file is larger than 50 MB. Split it into smaller metadata exports before importing.'; return; }
      note.textContent = 'Checking backup…';
      let value;
      try { value = JSON.parse(await file.text()); }
      catch { note.textContent = 'This file is not valid JSON. Choose an export from the extension or Watchlater.'; return; }
      try {
        const result = await importBackup(value, transport, (count, total) => { note.textContent = `Importing… ${count} of ${total} records verified`; });
        note.textContent = `Imported ${result.imported} records.${result.skippedDeleted ? ` Skipped ${result.skippedDeleted} deletion markers.` : ''} Your source file and local extension history are kept.`;
      } catch (error) { note.textContent = error.message || 'Import could not be verified. Check the connection before trying the file again.'; }
    });
  });
  window.addEventListener('pagehide', () => { $('device-token').value = ''; });
})();
