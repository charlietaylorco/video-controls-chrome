/* Isolated Site-origin relay. No page messages, DOM tokens, or arbitrary URLs. */
(() => {
  const ORIGIN = 'https://watchlater.chimping.chatgpt.site', PATH = '/extension-sync';
  if (location.origin !== ORIGIN || location.pathname !== PATH || location.search || window.top !== window) return;
  const nonce = /^#rs-([A-Za-z0-9_-]{16,100})$/.exec(location.hash)?.[1];
  if (!nonce) return;
  const here = () => location.origin === ORIGIN && location.pathname === PATH && !location.search && location.hash === '#rs-' + nonce;
  const ready = () => { if (here()) chrome.runtime.sendMessage({ type: 'sites-sync-ready', nonce }, () => { void chrome.runtime.lastError; }); };
  const fields = new Set(['videoUrl', 'readerId', 'savedAt', 'firstSavedAt', 'title', 'author', 'description', 'durationSeconds', 'durationIsLive', 'tags', 'location', 'checkedAt', 'status', 'provenance', 'updatedAt', 'summary', 'summaryTruncated', 'summaryCheckedAt']);
  const validBody = body => body && typeof body === 'object' && !Array.isArray(body) &&
    (body.type === 'cloud-ping' && Object.keys(body).every(key => key === 'type') || body.type === 'cloud-import' &&
      Object.keys(body).every(key => ['type', 'items'].includes(key)) && Array.isArray(body.items) && body.items.length <= 25 && body.items.every(item =>
        item && typeof item === 'object' && !Array.isArray(item) && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{1,100}$/.test(item.videoUrl) && Object.keys(item).every(key => fields.has(key))));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['sites-sync-check', 'sites-sync-request'].includes(message?.type)) return undefined;
    if (sender.id !== chrome.runtime.id || sender.url && sender.url !== chrome.runtime.getURL('background.js') || !here() || message.nonce !== nonce) { respond({ ok: false }); return undefined; }
    if (message.type === 'sites-sync-check') { ready(); respond({ ok: true, nonce, url: location.href }); return undefined; }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(message.token || '') || !/^[A-Za-z0-9_-]{16,100}$/.test(message.requestId || '') || !validBody(message.body)) { respond({ ok: false }); return undefined; }
    const requestId = message.requestId, responseUrl = location.href;
    const reply = value => respond({ nonce, requestId, url: responseUrl, ...value });
    void (async () => {
      try {
        const response = await fetch('/api/recent-saves', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + message.token }, body: JSON.stringify(message.body) });
        if (!here()) { reply({ code: 'sign_in_required' }); return; }
        if (!String(response.headers.get('content-type') || '').includes('application/json')) { reply({ code: 'sign_in_required' }); return; }
        const body = await response.json();
        if (['auth_required', 'sign_in_required', 'invalid_origin'].includes(body?.code)) { reply({ code: 'sign_in_required' }); return; }
        // Return only this narrow protocol, never arbitrary server payloads.
        const result = { ok: body?.ok === true };
        if (typeof body?.scope === 'string' && body.scope.length <= 256) result.scope = body.scope;
        if (Array.isArray(body?.accepted) && body.accepted.length <= 25 && body.accepted.every(url => typeof url === 'string' && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{1,100}$/.test(url))) result.accepted = body.accepted;
        if (typeof body?.code === 'string' && /^[a-z_]{1,80}$/.test(body.code)) result.code = body.code;
        reply({ status: response.status, body: result });
      } catch { reply({ code: 'sign_in_required' }); }
    })();
    return true;
  });
  ready();
})();
