/* Build a dependency-free, offline browser fixture from the actual card UI,
 * background guard and API service. Serve only the generated output directory.
 * No extension installation, real YouTube page or real Reader request is used.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const destination = process.argv[2] || path.resolve(__dirname, '../output/hover-interaction-fixture');
const cardRef = process.argv[3]; // Optional old UI revision for a before/after reproduction.
fs.mkdirSync(destination, { recursive: true });
const source = name => (cardRef && name === 'reader-card-preview.js'
  ? execFileSync('git', ['show', cardRef + ':reader-card-preview.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
  : fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8')).replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'">
<title>Reader hover interaction · mock data only</title>
<style>body{font:14px/1.5 system-ui;margin:32px;background:#f6f7f8;color:#222}h1{font-size:20px}#card{width:420px;height:90px;border:1px solid #bbb;background:white;padding:16px}#bookmark{padding:8px}#transport{margin-top:340px}#events{font:12px/1.5 monospace;max-height:220px;overflow:auto}li{white-space:pre-wrap}</style>
<h1>Reader hover interaction — mock data only</h1><p>Actual extension UI, background checks and API service. Network disabled. No real Reader library.</p>
<div id="card"><button id="bookmark" type="button" aria-label="Reader bookmark (mock)">Reader bookmark (mock)</button><p>Mock saved video</p></div>
<section id="transport"><h2>Interaction and mock transport trace</h2><ol id="events"></ol></section>
<script>
const PAGE = 'https://www.youtube.com/feed/subscriptions', VIDEO = 'https://www.youtube.com/watch?v=fixture_hover_delete';
const delay = Math.min(2000, Math.max(0, Number(new URL(window.location.href).searchParams.get('delay')) || 800));
const outcome = new URL(window.location.href).searchParams.get('outcome') || 'success';
const started = performance.now(), listeners = [], storageListeners = [];
const trace = text => { const li = document.createElement('li'); li.textContent = Math.round(performance.now() - started) + 'ms ' + text; document.querySelector('#events').append(li); };
const data = { readerToken: 'fixture-only-not-a-real-token', readerDocuments: { [VIDEO]: { id: 'fixture-doc', at: 1 } }, readerSavedUrls: { [VIDEO]: 1 } };
let present = true, reads = 0;
const raw = () => ({ id: 'fixture-doc', source_url: VIDEO, title: 'Mock studio video', summary: 'Mock Reader summary. No real library data.', notes: 'Fixture note', updated_at: 'v1' });
window.fetch = async (url, init) => {
  if (!url.startsWith('https://readwise.io/api/v3/')) throw new Error('Fixture forbids network');
  trace((init.method || 'GET') + ' ' + url.replace('https://readwise.io/api/v3/', ''));
  if (!init.method && ++reads === 2) await new Promise(resolve => setTimeout(resolve, delay));
  let status = 200, result;
  if (init.method === 'DELETE') {
    if (outcome === 'unauthorized') status = 401;
    else { status = 204; if (outcome !== 'still-present') present = false; }
  } else result = { results: present ? [raw()] : [] };
  trace('Mock HTTP ' + status + (result ? ' · records ' + result.results.length : ''));
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => result };
};
window.chrome = { runtime: { id: 'extension', lastError: null, getURL: s => s,
  onMessage: { addListener(fn) { listeners.push(fn); } },
  sendMessage(message, callback) {
    trace('UI ' + message.type);
    for (const fn of listeners) fn(message, { id: 'extension', frameId: 0, documentId: 'fixture-document', url: PAGE, tab: { id: 1, url: PAGE } }, reply => { trace('Reply ' + JSON.stringify(reply)); callback(reply); });
  } }, storage: { local: {
    get(defaults, cb) { cb({ ...defaults, ...data }); },
    set(values, cb) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
      Object.assign(data, structuredClone(values)); queueMicrotask(() => storageListeners.forEach(fn => fn(changes, 'local'))); cb?.();
    }
  }, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
  action: { onClicked: { addListener() {} } }, tabs: {
    get(id, cb) { cb({ id, url: PAGE }); },
    sendMessage(id, message, options, cb) { for (const fn of listeners) fn(message, { id: 'extension' }, reply => { trace('Live card validation ' + reply.ok); cb(reply); }); }
  } };
window.importScripts = () => {};
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init) {
  // Test-only locator access, matching the optional Playwright fixtures.
  // Production remains closed; omit ?open=1 for the unmodified root mode.
  const root = attach.call(this, new URL(window.location.href).searchParams.get('open') === '1' ? { ...init, mode: 'open' } : init);
  root.addEventListener('click', event => {
    if (event.composedPath().some(node => node.tagName === 'A')) { event.preventDefault(); trace('Fixture blocked external navigation'); }
  }, true);
  root.addEventListener('focusout', event => trace('Native focusout: ' + event.target.textContent.trim().slice(0, 40) + ' -> ' + (event.relatedTarget?.textContent.trim().slice(0, 25) || 'none')));
  root.addEventListener('focusin', event => trace('Native focusin: ' + (event.target.getAttribute('aria-label') || event.target.className || event.target.textContent.trim().slice(0, 25))));
  return root;
};
${source('reader-core.js')}
${source('reader-service.js')}
${source('background.js')}
(() => { const location = { href: PAGE };
${source('reader-card-preview.js')}
})();
const bookmark = document.querySelector('#bookmark'), card = document.querySelector('#card');
MVSReaderCardPreview.create({ button: bookmark, getTarget: () => ({ source: card, videoUrl: VIDEO, title: 'Mock studio video', saved: true }), onDeleted: () => trace('VERIFIED DELETION SUCCESS'), onClose: () => trace('POPOVER CLOSED') });
trace('Ready. Focus bookmark and press ArrowDown, then click trash and Delete document. Preflight delay ' + delay + 'ms.');
</script>`;
fs.writeFileSync(path.join(destination, 'hover.html'), html);
console.log(path.join(destination, 'hover.html'));
