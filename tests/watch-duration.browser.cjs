/* Native layout + IndexedDB/worker fixture checks; all remote data is synthetic.
 * PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE may reuse a local runtime.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'output/playwright/durations'), fixtureDir = path.join(output, 'fixture');
let browser, server, origin;
before(async () => {
  fs.mkdirSync(output, { recursive: true });
  execFileSync(process.execPath, [path.join(__dirname, 'watch-browser-fixture.cjs'), fixtureDir]);
  server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, 'http://fixture').pathname), file = path.join(fixtureDir, name || 'index.html');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function fixture(width, theme, thumbnail = 'available') {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/index.html?mode=layout&theme=${theme}&thumbnail=${thumbnail}`);
  await page.locator('.video').nth(1).waitFor();
  return { context, page, errors };
}
async function mediaGeometry(page) {
  return page.locator('.video-media').first().evaluate(media => {
    const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
    return {media:rect(media),link:rect(media.querySelector('a')),image:rect(media.querySelector('img')),badge:rect(media.querySelector('.duration-badge')),
      overflow:document.documentElement.scrollWidth>innerWidth, pointerEvents:getComputedStyle(media.querySelector('.duration-badge')).pointerEvents};
  });
}
test('known badges are compact overlays with unchanged 16:9 thumbnails, Saved only, in light/dark/narrow layouts', async () => {
  for (const [width, theme] of [[1100,'light'],[1100,'dark'],[390,'light'],[320,'dark']]) {
    const f = await fixture(width, theme), {page} = f;
    assert.deepEqual((await page.locator('.duration-badge').allTextContents()).sort(),['1:01:01','1:05']);
    assert.equal(await page.locator('.footer-meta').first().textContent().then(text=>text.includes('Checked')),false);
    assert.match(await page.locator('.footer-meta').first().textContent(),/^Saved /);
    const g = await mediaGeometry(page);
    assert.ok(Math.abs(g.media.width/g.media.height-16/9)<.01); assert.deepEqual(g.link,g.media);
    assert.ok(Math.abs(g.image.height-g.media.height)<1); assert.ok(g.badge.width<70 && g.badge.height<=22);
    assert.ok(Math.abs(g.media.right-g.badge.right-8)<1 && Math.abs(g.media.bottom-g.badge.bottom-8)<1);
    assert.equal(g.pointerEvents,'none'); assert.equal(g.overflow,false); assert.deepEqual(f.errors,[]);
    await page.screenshot({path:path.join(output,`recent-saves-duration-${width}-${theme}.png`),fullPage:true});
    await f.context.close();
  }
});
test('unknown/live badges stay blank, cached old entries enrich locally, and updates never shift the thumbnail', async () => {
  const f = await fixture(390,'dark','unavailable'), {page} = f;
  await page.locator('.thumbnail-link[data-thumbnail-unavailable=true]').first().waitFor();
  const before = (await mediaGeometry(page)).media;
  await page.evaluate(async () => {
    const store=getReaderWatchStore(), url='https://www.youtube.com/watch?v=mock_watch_24';
    await store.recordSave(url,'mock-24',{durationVideoUrl:url,durationIsLive:true});
  });
  await page.waitForFunction(()=>document.querySelector('.duration-badge').hidden);
  assert.deepEqual((await mediaGeometry(page)).media,before);
  await page.evaluate(async () => {
    const store=getReaderWatchStore(), url='https://www.youtube.com/watch?v=mock_watch_25';
    // An old record with no duration can use a newly populated existing cache.
    await store.recordSave(url,'mock-25',{durationVideoUrl:url,durationIsLive:true});
    await store.recordSave(url,'mock-25',{durationVideoUrl:url,durationSeconds:90});
    await store.recordSave('https://www.youtube.com/watch?v=unknown_old','old-id',{title:'Unknown old save'});
    chrome.storage.local.set({ytListsDurationCache:{unknown_old:{seconds:125,isLive:false}}});
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('.duration-badge')].some(node=>node.textContent==='2:05'));
  assert.equal(await page.locator('#fixture-count').textContent(),'Mock Reader requests: 0');
  assert.deepEqual(f.errors,[]); await f.context.close();
});
test('actual browser save-time capture follows the exact player/card identity through SPA changes and rejects ads/live previews', async () => {
  const context=await browser.newContext(), page=await context.newPage();
  await context.route('**/*', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><ytd-watch-flexy video-id="alpha"><div id="movie_player"><video></video></div></ytd-watch-flexy><article id="card"><a href="/watch?v=card_video">Synthetic card</a><ytd-thumbnail-overlay-time-status-renderer>12:34</ytd-thumbnail-overlay-time-status-renderer></article>'}));
  await page.goto('https://www.youtube.com/watch?v=alpha');
  await page.evaluate(()=>{const video=document.querySelector('video');Object.defineProperties(video,{currentSrc:{value:'blob:synthetic',configurable:true},readyState:{value:4},duration:{value:3661}});});
  for(const file of ['reader-core.js','reader-duration.js']) await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
  const result=await page.evaluate(()=>{
    const video=document.querySelector('video'), card=document.querySelector('#card');
    const capture=url=>MVSReaderDuration.capture({source:video,videoUrl:url}).durationSeconds??null;
    const old=capture(location.href), cardValue=MVSReaderDuration.capture({source:card,videoUrl:'https://www.youtube.com/watch?v=card_video',card:true}).durationSeconds;
    history.pushState({},'','/watch?v=beta');document.querySelector('ytd-watch-flexy').setAttribute('video-id','beta');
    const stale=capture(location.href);video.dispatchEvent(new Event('loadedmetadata'));const fresh=capture(location.href);
    document.querySelector('#movie_player').classList.add('ad-showing');const ad=capture(location.href);
    document.querySelector('#movie_player').classList.remove('ad-showing');document.querySelector('ytd-watch-flexy').setAttribute('is-live','');const live=capture(location.href);
    return {old,cardValue,stale,fresh,ad,live};
  });
  assert.deepEqual(result,{old:3661,cardValue:754,stale:null,fresh:3661,ad:null,live:null}); await context.close();
});
