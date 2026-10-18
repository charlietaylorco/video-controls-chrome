/* Offline native-browser fixture: actual IndexedDB, UI, worker and Reader service.
 * Serve only the generated directory on loopback. All remote data is synthetic.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), destination = path.resolve(process.argv[2] || path.join(root, 'output/watch-browser'));
fs.mkdirSync(destination, { recursive: true });
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/<\/script/gi, '<\\/script');
const bootstrap = `
const options = new URL(location.href).searchParams;
const mode = options.get('mode') || 'normal';
const listeners = [], storageListeners = [], documents = new Map();
const data = { readerToken: 'fixture-token-not-real', readerPanelTheme: options.get('theme') || 'system', readerSavedUrls: {}, readerDocuments: {} };
let calls = 0, fixtureClock = Date.now() - 3600000, added = 0;
const report = text => { const row = document.createElement('li'); row.textContent = text; document.getElementById('fixture-log').append(row); };
window.fetch = async (url, init = {}) => {
  if (!url.startsWith('https://readwise.io/api/v3/')) throw Error('Fixture blocks network');
  calls++; document.getElementById('fixture-count').textContent = 'Mock Reader requests: ' + calls;
  report((init.method || 'GET') + ' ' + url.replace('https://readwise.io/api/v3/', ''));
  if (document.getElementById('fixture-slow').checked) await new Promise(resolve => setTimeout(resolve, 600));
  let value, status = 200;
  if (document.getElementById('fixture-fail').checked) status = 401;
  else if (url.endsWith('/save/')) {
    const body = JSON.parse(init.body), id = 'added-' + ++added;
    documents.set(id, { id, source_url: body.url, title: body.title, author: body.author, location: 'later', summary: 'A newly saved mock summary.', notes: 'Private fixture note', updated_at: 'v1' });
    status = 201; value = { id, url: 'https://read.readwise.io/read/' + id };
  } else {
    const id = url.includes('/list/') ? new URL(url).searchParams.get('id') : url.split('/').at(-2);
    if (init.method === 'PATCH') { Object.assign(documents.get(id), JSON.parse(init.body), { updated_at: 'v2' }); value = { id }; }
    else if (init.method === 'DELETE') { documents.delete(id); status = 204; }
    else value = { results: documents.has(id) ? [structuredClone(documents.get(id))] : [] };
  }
  report('HTTP ' + status);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => value, text: async () => JSON.stringify(value) };
};
let seeded;
window.chrome = { runtime: { id: 'extension', lastError: null, getURL: file => 'chrome-extension://extension/' + file,
  onMessage: { addListener(fn) { listeners.push(fn); } },
  sendMessage(message, callback) { seeded.then(() => { for (const fn of listeners) fn(message,
    { id: 'extension', frameId: 0, documentId: 'fixture-watch', url: 'chrome-extension://extension/watch.html', tab: { id: 1 } }, reply => {
      if (message.type === 'watch-list-page') report('Local page: ' + (reply.items?.length || 0) + ' cards');
      callback(reply);
    }); }); }
}, storage: { local: {
  get(defaults, cb) { cb(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, data[key] ?? value]))); },
  set(values, cb) { const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
    Object.assign(data, structuredClone(values)); queueMicrotask(() => storageListeners.forEach(fn => fn(changes, 'local'))); cb?.(); }
}, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
tabs: { get(id, cb) { cb({ id, url: 'chrome-extension://extension/watch.html' }); }, create() { report('Fixture blocked external tab navigation'); } },
action: { onClicked: { addListener() {} } } };
window.importScripts = () => {};
const imageSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
Object.defineProperty(HTMLImageElement.prototype, 'src', { get: imageSource.get, set(value) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="224" height="126"><rect width="224" height="126" fill="#505d48"/><circle cx="176" cy="32" r="13" fill="#d6dfca"/><path d="M0 126 60 44 117 108 155 73 224 126Z" fill="#718267"/></svg>';
  imageSource.set.call(this, 'data:image/svg+xml,' + encodeURIComponent(svg));
} });
const frameSource = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
Object.defineProperty(HTMLIFrameElement.prototype, 'src', { get: frameSource.get, set(value) {
  const url = new URL(value);
  if (url.origin !== 'https://www.youtube.com' || !url.pathname.startsWith('/embed/')) throw Error('Fixture blocks external frames');
  report('Mock player request: ' + url.pathname + ' autoplay=' + url.searchParams.get('autoplay'));
  frameSource.set.call(this, 'player.html?' + new URLSearchParams({ video: url.pathname.split('/').at(-1), unavailable: options.get('player_error') || '' }));
} });
${source('reader-core.js')}
${source('reader-watch-core.js')}
${source('reader-watch-store.js')}
const createWatch = MVSReaderWatchStore.create;
MVSReaderWatchStore.create = opts => createWatch({ ...opts, name: 'mvs-watch-offline-fixture', now: () => ++fixtureClock });
${source('reader-service.js')}
${source('reader-watch-service.js')}
${source('background.js')}
seeded = (async () => {
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('mvs-watch-offline-fixture'); r.onsuccess = resolve; r.onerror = reject; });
  const store = getReaderWatchStore();
  if (mode !== 'empty') for (let i = mode === 'layout' ? 24 : 0; i < (mode === 'layout' ? 26 : 27); i++) {
    const videoUrl = 'https://www.youtube.com/watch?v=mock_watch_' + i, id = 'mock-' + i;
    const titles = ['A quieter way to plan your week', 'What makes a small business work', 'Designing a useful daily practice', 'Learning to see the bigger picture', 'The craft behind a good decision'];
    const doc = { id, source_url: videoUrl, title: titles[i % titles.length] + ' · ' + (i + 1), author: 'Mock channel ' + (i % 4 + 1),
      tags: i === 3 ? ['<img src=x onerror=alert(1)>'] : i % 5 === 0 ? [] : ['Creativity', 'Learning'],
      location: i % 7 === 0 ? 'archive' : i % 3 === 0 ? 'shortlist' : i % 5 === 0 ? 'new' : 'later',
      summary: i === 3 ? '<img src=x onerror=alert(1)> is inert fixture text.' : i % 11 === 0 ? '' : 'A saved idea worth returning to. This mock summary explores practical ways to make room for focused work, thoughtful decisions, and a little more curiosity.\\n\\nThe useful takeaway: start with one small change you can actually try.',
      notes: 'Private fixture note', updated_at: 'v1' };
    documents.set(id, doc); data.readerSavedUrls[videoUrl] = fixtureClock; data.readerDocuments[videoUrl] = { id, at: fixtureClock };
    await store.recordSave(videoUrl, mode === 'unlinked' ? null : id, { title: doc.title, author: doc.author });
    if (mode !== 'unlinked' && (i % 2 === 0 || mode === 'layout')) await store.verify(videoUrl, MVSReaderCore.cleanDocument(doc, videoUrl));
  }
  report('Fixture ready. No real Reader data.');
})();
document.getElementById('fixture-add').addEventListener('click', async () => {
  await seeded;
  for (const fn of listeners) fn({ type: 'save-to-reader', pageUrl: 'https://www.youtube.com/watch?v=mock_added_' + (added + 1), title: 'A newly saved mock video', author: 'Mock channel' },
    { id: 'extension', frameId: 0, url: 'https://www.youtube.com/', tab: { id: 2 } }, reply => report('New save recorded: ' + reply.ok));
});
document.getElementById('fixture-auth').addEventListener('click', () => chrome.storage.local.set({ readerToken: 'fixture-token-' + Date.now() }));
document.addEventListener('click', event => { if (event.target.closest('a')) { event.preventDefault(); report('Fixture blocked link navigation'); } }, true);
`;
let html = fs.readFileSync(path.join(root, 'watch.html'), 'utf8').replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, '');
html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src data:; frame-src \'self\'; connect-src \'none\'">');
const tools = '<aside style="font:11px system-ui;padding:10px 20px;background:#e5e8df;color:#25301d"><strong>Mock data only · isolated native browser check</strong> · <span id="fixture-count">Mock Reader requests: 0</span> <button id="fixture-add" type="button">Add a mock save</button> <button id="fixture-auth" type="button">Change mock connection</button> <label><input type="checkbox" id="fixture-slow"> Slow responses</label> <label><input type="checkbox" id="fixture-fail"> Reject Reader requests</label><details><summary>Mock trace</summary><ol id="fixture-log"></ol></details></aside>';
html = html.replace('<body>', '<body>' + tools).replace('</body>', '<script>' + bootstrap + '</script><script src="watch-player.js"></script><script src="watch.js"></script></body>');
fs.writeFileSync(path.join(destination, 'index.html'), html);
for (const file of ['watch.css', 'watch-player.js', 'watch.js']) fs.copyFileSync(path.join(root, file), path.join(destination, file));
console.log(destination);

fs.writeFileSync(path.join(destination, 'player.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>body{margin:0;padding:14px;background:#19221a;color:#e8eee2;font:12px system-ui}h1{font-size:16px;margin:8px 0}p{margin:8px 0}button{padding:8px;font:inherit}</style></head><body><h1>Mock YouTube player</h1><p id="identity"></p><p id="state">Paused · autoplay off · synthetic data only</p><button id="play">Play mock video</button><script>const q=new URLSearchParams(location.search);document.querySelector('#identity').textContent='Fixture video: '+q.get('video');if(q.get('unavailable')){document.querySelector('#state').textContent='Mock unavailable player (simulates identification error 153)';document.querySelector('#play').hidden=true;}document.querySelector('#play').onclick=()=>document.querySelector('#state').textContent='Playing mock video · no real media/network';</script></body></html>`);
