const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'x-video-download.js'), 'utf8');
const variant = (width, height, bitrate = 1000, id = '123456789') => ({
  url: `https://video.twimg.com/amplify_video/${id}/vid/avc1/${width}x${height}/sample.mp4?tag=14`,
  type: 'video/mp4', bitrate
});
function load(overrides = {}) {
  const context = { URL, Uint8Array, DataView, AbortSignal, ...overrides };
  vm.runInNewContext(`${source}\nglobalThis.api = XVideoDownload;`, context);
  return context.api;
}

function box(type, ...parts) {
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, data]);
}
function track(type) {
  const header = Buffer.alloc(24);
  header.write(type, 8);
  return box('trak', box('mdia', box('hdlr', header)));
}
const movie = (...tracks) => box('moov', ...tracks.map(track));
const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
const mdat = box('mdat', Buffer.alloc(128 * 1024));
function rangeFetch(data, requests = []) {
  return async (url, options) => {
    const [, begin, finish] = options.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
    const start = Number(begin);
    const end = Math.min(Number(finish), data.length - 1);
    requests.push({ url, start, end, options });
    assert.ok(start < data.length, 'no request past EOF');
    return new Response(data.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Type': 'video/mp4' }
    });
  };
}

test('selects largest complete rendition, then highest bitrate, regardless of array order', () => {
  const api = load();
  const high = variant(1920, 1080, 8000000);
  const result = api.selectBest([
    variant(640, 360, 9000000), high,
    { type: 'application/x-mpegURL', url: 'https://video.twimg.com/stream.m3u8' },
    variant(1920, 1080, 3000000), variant(1280, 720, 5000000)
  ]);
  assert.equal(result.url, high.url);
  assert.equal(result.bitrate, 8000000);
  assert.equal(api.selectBest([variant(720, 1280), variant(480, 854)]).height, 1280);
  const legacy = { ...high, url: high.url.replace('/amplify_video/', '/ext_tw_video/').replace('/vid/avc1/', '/pu/vid/') };
  assert.equal(api.selectBest([legacy]).url, legacy.url);
});

test('rejects audio/init fragments, foreign hosts, unsafe URLs, GIFs and mixed players', () => {
  const api = load();
  const valid = variant(1280, 720);
  for (const url of [
    valid.url.replace('/avc1/', '/avc1/0/0/'),
    valid.url.replace('/vid/', '/aud/'),
    valid.url.replace('video.twimg.com', 'video.twimg.com.evil.example'),
    valid.url.replace('https:', 'http:'),
    valid.url.replace('video.twimg.com', 'user:password@video.twimg.com'),
    valid.url.replace('video.twimg.com', 'video.twimg.com:444'),
    `${valid.url}#fragment`, 'blob:https://x.com/some-video',
    'https://video.twimg.com/tweet_video/silent.mp4',
    'https://video.twimg.com/amplify_video/123/vid/avc1/0x0/a.mp4',
    'https://video.twimg.com/amplify_video/123/vid/avc1/99999x99999/a.mp4'
  ]) assert.throws(() => api.selectBest([{ ...valid, url }]), /no_mp4/);
  assert.throws(() => api.selectBest([valid, variant(640, 360, 1000, '987654321')]), /ambiguous_video/);
  assert.throws(() => api.selectBest(Array(33).fill(valid)), /no_mp4/);
  assert.throws(() => api.selectBest(null), /no_mp4/);
});

test('validates X sender domains', () => {
  const { isXPage } = load();
  assert.equal(isXPage('https://x.com/home'), true);
  assert.equal(isXPage('https://mobile.twitter.com/example/status/123'), true);
  for (const url of ['https://x.com.evil.example', 'https://other.example/x.com', 'http://x.com', 'https://user@x.com', 'https://x.com:444', null]) {
    assert.equal(isXPage(url), false);
  }
});

test('requires actual video and audio handler boxes and rejects fragmented/malformed MP4 metadata', () => {
  const { inspectMovie } = load();
  inspectMovie(movie('vide', 'soun'));
  assert.throws(() => inspectMovie(movie('vide')), /no_audio/);
  assert.throws(() => inspectMovie(movie('soun')), /no_video/);
  assert.throws(() => inspectMovie(box('moov', track('vide'), track('soun'), box('mvex'))), /fragmented_mp4/);
  const encrypted = box('trak', box('mdia', box('minf', box('stbl', box('stsd', Buffer.alloc(8), box('encv'))))));
  assert.throws(() => inspectMovie(box('moov', track('vide'), track('soun'), encrypted)), /encrypted_mp4/);
  assert.throws(() => inspectMovie(box('moov', Buffer.from('vide soun'))), /invalid_mp4/);
  const invalidSize = movie('vide', 'soun');
  invalidSize.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => inspectMovie(invalidSize), /invalid_mp4/);
});

test('bounded range verification supports moov at either end without fetching video payload', async () => {
  for (const data of [Buffer.concat([ftyp, movie('vide', 'soun'), mdat]), Buffer.concat([ftyp, mdat, movie('vide', 'soun')])]) {
    const requests = [];
    const api = load({ fetch: rangeFetch(data, requests) });
    const signal = AbortSignal.timeout(5000);
    await api.verifyAudioVideo(variant(1280, 720).url, signal);
    assert.ok(requests.reduce((sum, item) => sum + item.end - item.start + 1, 0) < 1024);
    assert.ok(requests.every(({ options }) => options.signal === signal && options.credentials === 'include' && options.redirect === 'error'));
  }
});

test('range failure cancels the response, rejects authorization failures and truncated bodies', async () => {
  for (const status of [200, 401, 403]) {
    let cancelled = false;
    const api = load({ fetch: async () => ({
      status, headers: new Headers(), body: { async cancel() { cancelled = true; } }
    }) });
    await assert.rejects(api.verifyAudioVideo(variant(640, 360).url), status === 200 ? /range_failed/ : /access_denied/);
    assert.equal(cancelled, true);
  }
  const truncated = load({ fetch: async () => new Response(new Uint8Array(8), {
    status: 206, headers: { 'Content-Range': 'bytes 0-15/1000' }
  }) });
  await assert.rejects(truncated.verifyAudioVideo(variant(640, 360).url), /invalid_mp4/);
});

test('rejects oversized metadata and changing files without downloading their contents', async () => {
  const hugeMoov = Buffer.alloc(16);
  hugeMoov.writeUInt32BE(5 * 1024 * 1024);
  hugeMoov.write('moov', 4);
  let requests = 0;
  const api = load({ fetch: async () => {
    const start = requests++ ? ftyp.length : 0;
    const bytes = start ? hugeMoov : ftyp.subarray(0, 16);
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 15}/10000000` } });
  } });
  await assert.rejects(api.verifyAudioVideo(variant(640, 360).url), /metadata_too_large/);
  assert.equal(requests, 2);
  let count = 0;
  const changed = load({ fetch: async () => {
    const start = count++ ? ftyp.length : 0;
    return new Response(ftyp.subarray(0, 16), { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 15}/${1000 + count}` } });
  } });
  await assert.rejects(changed.verifyAudioVideo(variant(640, 360).url), /changed_file/);
});

test('downloads the verified best MP4 with an informative safe filename and never falls back', async () => {
  const requests = [];
  const downloads = [];
  const api = load({
    fetch: rangeFetch(Buffer.concat([ftyp, movie('vide', 'soun'), mdat]), requests),
    chrome: { downloads: { async download(options) { downloads.push(options); return 42; } } }
  });
  const result = await api.start([variant(640, 360), variant(1920, 1080)]);
  assert.equal(result.downloadId, 42);
  assert.equal(result.width, 1920);
  assert.equal(downloads[0].url, variant(1920, 1080).url);
  assert.equal(downloads[0].filename, 'x-video-123456789-1920x1080.mp4');
  assert.equal(downloads[0].conflictAction, 'uniquify');
  assert.ok(requests.every((request) => request.url === downloads[0].url));

  let attempts = 0;
  const failed = load({ fetch: async () => { attempts++; throw new Error('offline'); },
    chrome: { downloads: { async download() { assert.fail('unverified video must not download'); } } } });
  await assert.rejects(failed.start([variant(640, 360), variant(1920, 1080)]), /offline/);
  assert.equal(attempts, 1);
});

test('missing audio prevents the native download', async () => {
  const api = load({ fetch: rangeFetch(Buffer.concat([ftyp, movie('vide'), mdat])),
    chrome: { downloads: { download() { assert.fail('silent file must not download'); } } } });
  await assert.rejects(api.start([variant(1280, 720)]), /no_audio/);
});

test('page bridge resolves the requested player only, including reused video nodes', () => {
  const listeners = {};
  const responses = [];
  class Video {
    isConnected = true;
    parentElement = null;
    getAttribute() { return '12345678-1234-1234-1234-123456789abc'; }
    dispatchEvent(event) { responses.push(JSON.parse(event.detail)); }
  }
  const context = { window: {}, HTMLVideoElement: Video,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { addEventListener(type, listener) { listeners[type] = listener; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'x-video-page.js'), 'utf8'), context);
  const a = new Video();
  const b = new Video();
  const playerA = { memoizedProps: { variants: [{ src: 'player-a', type: 'video/mp4', bitrate: 10 }] } };
  const playerB = { memoizedProps: { variants: [{ src: 'player-b', type: 'video/mp4', bitrate: 20 }] } };
  a.parentElement = { __reactFiber$test: { return: playerA, sibling: playerB } };
  b.parentElement = { __reactFiber$test: { return: playerB, sibling: playerA } };
  listeners['mvs-x-video-request']({ target: b });
  assert.equal(responses[0].variants[0].url, 'player-b');
  playerB.memoizedProps.variants[0].src = 'recycled-player';
  listeners['mvs-x-video-request']({ target: b });
  assert.equal(responses[1].variants[0].url, 'recycled-player');
  delete playerB.memoizedProps.variants;
  listeners['mvs-x-video-request']({ target: b });
  assert.equal(responses[2].variants.length, 0);
  b.isConnected = false;
  listeners['mvs-x-video-request']({ target: b });
  assert.equal(responses.length, 3);
});

test('background refuses non-X senders before any network or download action', () => {
  let listener;
  const context = {
    URL, AbortSignal, importScripts() {}, XVideoDownload: load(),
    chrome: {
      runtime: { id: 'test-extension', getURL: (file) => file, onMessage: { addListener(value) { listener = value; } } },
      action: { onClicked: { addListener() {} } }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  for (const sender of [
    { id: 'test-extension', tab: { id: 1 }, url: 'https://example.com' },
    { id: 'other-extension', tab: { id: 1 }, url: 'https://x.com' },
    { id: 'test-extension', url: 'https://x.com' },
    { id: 'test-extension', tab: { id: 1, url: 'https://x.com' }, url: 'https://evil.example' }
  ]) {
    let response;
    listener({ type: 'download-x-video', variants: [variant(1280, 720)] }, sender, (value) => { response = value; });
    assert.equal(response.code, 'invalid_sender');
  }
});

test('manifest wires X-only page bridge, background helper and media download permission', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const bridge = manifest.content_scripts.find((script) => script.js.includes('x-video-page.js'));
  assert.equal(bridge.world, 'MAIN');
  assert.equal(bridge.run_at, 'document_start');
  assert.ok(bridge.matches.every((pattern) => load().isXPage(pattern.replace('*', ''))));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.host_permissions.includes('https://video.twimg.com/*'));
});
