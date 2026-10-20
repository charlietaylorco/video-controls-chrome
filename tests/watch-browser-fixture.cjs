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
const data = { readerToken: 'fixture-token-not-real', raindropToken: options.get('raindrop') === 'missing' ? '' : 'fixture-raindrop-token-not-real', readerPanelTheme: options.get('theme') || 'system', readerSavedUrls: {}, readerDocuments: {} };
if (options.get('rate') === 'local') data.readerPanelBudget = { list: Array(18).fill(Date.now()) };
let calls = 0, fixtureClock = Date.now() - 3600000, added = 0;
const report = text => { const row = document.createElement('li'); row.textContent = text; document.getElementById('fixture-log').append(row); };
window.fetch = async (url, init = {}) => {
  if (url === 'https://api.raindrop.io/rest/v1/raindrop') {
    report('Mock Raindrop save: ' + JSON.parse(init.body).link);
    return { ok: !document.getElementById('fixture-fail').checked, status: document.getElementById('fixture-fail').checked ? 401 : 200, json: async () => ({ result: true }) };
  }
  if (!url.startsWith('https://readwise.io/api/v3/')) throw Error('Fixture blocks network');
  calls++; document.getElementById('fixture-count').textContent = 'Mock Reader requests: ' + calls;
  report((init.method || 'GET') + ' ' + url.replace('https://readwise.io/api/v3/', ''));
  if (document.getElementById('fixture-slow').checked) await new Promise(resolve => setTimeout(resolve, 600));
  let value, status = 200;
  if (options.get('rate') === 'reader') status = 429;
  else if (document.getElementById('fixture-fail').checked) status = 401;
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
  return { status, ok: status >= 200 && status < 300, headers: { get: () => status === 429 ? '120' : null }, json: async () => value, text: async () => JSON.stringify(value) };
};
let seeded;
window.chrome = { runtime: { id: 'extension', lastError: null, getURL: file => 'chrome-extension://extension/' + file,
  onMessage: { addListener(fn) { listeners.push(fn); } },
  sendMessage(message, callback) { seeded.then(() => { for (const fn of listeners) fn(message,
    { id: 'extension', frameId: 0, documentId: 'fixture-watch', url: 'chrome-extension://extension/watch.html', tab: { id: 1 } }, reply => {
      if (message.type === 'watch-list-page') report('Local page: ' + (reply.items?.length || 0) + ' cards');
      if (message.type === 'watch-list-page' && document.getElementById('fixture-search-slow').checked) setTimeout(() => callback(reply), message.query?.length === 1 ? 600 : 50);
      else callback(reply);
    }); }); }
}, storage: { local: {
  get(defaults, cb) { cb(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, data[key] ?? value]))); },
  set(values, cb) { const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
    Object.assign(data, structuredClone(values)); queueMicrotask(() => storageListeners.forEach(fn => fn(changes, 'local'))); cb?.(); }
}, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
tabs: { get(id, cb) { cb({ id, url: 'chrome-extension://extension/watch.html' }); }, create(options, cb) {
  report('Mock protocol handoff; no app opened: ' + options.url);
  chrome.runtime.lastError = document.getElementById('fixture-fail').checked ? { message: 'Mock handoff rejected' } : null;
  cb?.(chrome.runtime.lastError ? undefined : { id: 8 }); chrome.runtime.lastError = null;
} },
action: { onClicked: { addListener() {} } } };
window.importScripts = () => {};
const imageSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
Object.defineProperty(HTMLImageElement.prototype, 'currentSrc', { get() { return this.dataset.fixtureSource || ''; } });
Object.defineProperty(HTMLImageElement.prototype, 'src', { get: imageSource.get, set(value) {
  this.dataset.fixtureSource = value;
  const mode = options.get('thumbnail') || 'available';
  const low = mode === 'placeholder' && value.includes('/maxresdefault.jpg') || mode === 'unavailable';
  const width = low ? 120 : value.includes('/maxresdefault.jpg') ? 1280 : value.includes('/sddefault.jpg') ? 640 : value.includes('/hqdefault.jpg') ? 480 : 320;
  const height = low ? 90 : value.includes('/sddefault.jpg') ? 480 : value.includes('/hqdefault.jpg') ? 360 : width * 9 / 16;
  report('Mock thumbnail: ' + value.split('/').pop() + ' ' + width + '×' + height);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 224 126"><title>' + value.split('/').pop() + '</title><rect width="224" height="126" fill="#505d48"/><circle cx="176" cy="32" r="13" fill="#d6dfca"/><path d="M0 126 60 44 117 108 155 73 224 126Z" fill="#718267"/></svg>';
  imageSource.set.call(this, 'data:image/svg+xml,' + encodeURIComponent(svg));
} });
${source('reader-core.js')}
${source('reader-watch-core.js')}
${source('reader-watch-store.js')}
const createWatch = MVSReaderWatchStore.create;
MVSReaderWatchStore.create = opts => createWatch({ ...opts, name: 'mvs-watch-offline-fixture', now: () => ++fixtureClock });
${source('reader-service.js')}
${source('reader-watch-service.js')}
${fs.existsSync(path.join(root, 'reader-summary-service.js')) ? source('reader-summary-service.js') : ''}
${source('background.js')}
seeded = (async () => {
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('mvs-watch-offline-fixture'); r.onsuccess = resolve; r.onerror = reject; });
  const store = getReaderWatchStore();
  if (mode !== 'empty') for (let i = mode === 'layout' ? 24 : 0; i < (mode === 'layout' ? 26 : 27); i++) {
    const videoUrl = 'https://www.youtube.com/watch?v=mock_watch_' + i, id = 'mock-' + i;
    const titles = ['A quieter way to plan your week', 'What makes a small business work', 'Designing a useful daily practice', 'Learning to see the bigger picture', 'The craft behind a good decision'];
    const doc = { id, source_url: videoUrl, title: titles[i % titles.length] + ' · ' + (i + 1), author: 'Mock channel ' + (i % 4 + 1),
      tags: options.get('tags') === 'stress' ? ['Deep work', 'Very long multiword tag for focused learning and thoughtful practice', 'x'.repeat(200), ...Array.from({length:50}, (_,n) => 'Topic ' + n)] : i === 3 ? ['<img src=x onerror=alert(1)>'] : i % 5 === 0 ? [] : ['Creativity', 'Learning'],
      location: i % 7 === 0 ? 'archive' : i % 3 === 0 ? 'shortlist' : i % 5 === 0 ? 'new' : 'later',
      summary: i === 3 ? '<img src=x onerror=alert(1)> is inert fixture text.' : i % 11 === 0 ? '' : 'A saved idea worth returning to. This mock summary explores practical ways to make room for focused work, thoughtful decisions, and a little more curiosity.\\n\\nThe useful takeaway: start with one small change you can actually try.',
      notes: 'Private fixture note', updated_at: 'v1' };
    documents.set(id, doc); data.readerSavedUrls[videoUrl] = fixtureClock; data.readerDocuments[videoUrl] = { id, at: fixtureClock };
    await store.recordSave(videoUrl, mode === 'unlinked' ? null : id, { title: doc.title, author: doc.author, durationVideoUrl: videoUrl,
      durationSeconds: i % 4 === 0 ? 65 : i % 4 === 1 ? 3661 : null, durationIsLive: i % 4 === 3 });
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
html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src data:; connect-src \'none\'">');
const tools = '<aside style="font:11px system-ui;padding:10px 20px;background:#e5e8df;color:#25301d"><strong>Mock data only · isolated native browser check</strong> · <span id="fixture-count">Mock Reader requests: 0</span> <button id="fixture-add" type="button">Add a mock save</button> <button id="fixture-auth" type="button">Change mock connection</button> <label><input type="checkbox" id="fixture-slow"> Slow responses</label> <label><input type="checkbox" id="fixture-fail"> Reject Reader requests</label> <label><input type="checkbox" id="fixture-search-slow"> Slow local searches</label><details><summary>Mock trace</summary><ol id="fixture-log"></ol></details></aside>';
html = html.replace('<body>', '<body>' + tools).replace('</body>', '<script>' + bootstrap + '</script><script src="watch-location-menu.js"></script><script src="watch-feedback.js"></script><script src="watch-search.js"></script><script src="watch-thumbnail.js"></script><script src="watch-card-actions.js"></script><script src="watch.js"></script></body>');
fs.writeFileSync(path.join(destination, 'index.html'), html);
for (const file of ['watch.css', 'watch-location-menu.js', 'watch-feedback.js', 'watch-search.js', 'watch-thumbnail.js', 'watch-card-actions.js', 'watch.js']) fs.copyFileSync(path.join(root, file), path.join(destination, file));
console.log(destination);

fs.copyFileSync(path.join(root, 'reader-launcher.js'), path.join(destination, 'reader-launcher.js'));
fs.writeFileSync(path.join(destination, 'launcher.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{margin:0;background:#fafafa;color:#222;font:14px system-ui}aside{padding:18px;background:#eceee7}button,select{padding:8px}ytd-masthead{display:block;padding:12px 24px;border-bottom:1px solid #ddd}#buttons{display:flex;justify-content:flex-end;gap:10px}main{padding:32px}</style></head><body><aside>Mock YouTube page · <span id="requests">Recent saves requests: 0</span> <button id="remount">Remount header</button> <button id="navigate">Simulate navigation</button> <button id="remove">Remove floating host</button> <label><input id="enabled" type="checkbox" checked> Show shortcut</label> <label>Position <select id="position"><option>bottom-left</option><option>bottom-right</option><option>top-left</option><option>top-right</option></select></label> <label><input id="fullscreen" type="checkbox"> Mock fullscreen</label></aside><div id="mount"></div><main><h1>Mock YouTube page</h1><p>The Recent saves shortcut floats independently; the native header and Reader panel are separate.</p></main><script>
let requests=0,fullscreen=false;const settings={},listeners=new Set();
window.chrome={runtime:{lastError:null,sendMessage(message,cb){if(message.type==='open-watch-list')document.querySelector('#requests').textContent='Recent saves requests: '+ ++requests;cb({ok:true});}},storage:{local:{get(defaults,cb){cb({...defaults,...settings});},set(patch){Object.assign(settings,patch);for(const fn of listeners)fn(Object.fromEntries(Object.entries(patch).map(([key,newValue])=>[key,{newValue}])),'local');}},onChanged:{addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);}}}};
Object.defineProperty(document,'fullscreenElement',{get:()=>fullscreen?document.querySelector('main'):null});
function mount(){document.querySelector('#mount').innerHTML='<ytd-masthead><div id="buttons"><button>Native search</button><button>Native account</button></div></ytd-masthead>';}mount();
document.querySelector('#remount').onclick=mount;document.querySelector('#navigate').onclick=()=>window.dispatchEvent(new Event('yt-navigate-finish'));
document.querySelector('#remove').onclick=()=>document.querySelector('#mvs-recent-saves-launcher')?.remove();
document.querySelector('#enabled').onchange=event=>chrome.storage.local.set({showRecentSavesLauncher:event.target.checked});
document.querySelector('#position').onchange=event=>chrome.storage.local.set({recentSavesLauncherPosition:event.target.value});
document.querySelector('#fullscreen').onchange=event=>{fullscreen=event.target.checked;document.dispatchEvent(new Event('fullscreenchange'));};
</script><script src="reader-launcher.js"></script><script>window.fixtureLauncher=MVSRecentLauncher.create();</script></body></html>`);
