/* Actual unpacked extension in a fresh headless Chromium profile. Every request
 * is served by an offline fixture or aborted. No media or real account data. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(__dirname, '..');
let context, profile;
const errors = [];
before(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-youtube-speed-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=user-gesture-required'],
  });
  await context.route('**/*', route => route.abort());
});
after(async () => { await context?.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
const html = `<!doctype html><meta charset="utf-8"><style>
video{width:640px;height:360px;background:#222}#movie_player{width:640px}#hidden{display:none}</style>
<script>
window.nativeEvents = []; window.nativeChanges = 0; window.nativeMutate = true;
// Registered by page code while parsing: before content.js at document_idle.
for (const type of ['keydown','keypress','keyup']) {
  for (const target of [window, document]) for (const capture of [true, false]) {
    target.addEventListener(type, e => {
      nativeEvents.push(type + ':' + e.key + ':' + (target === window ? 'window' : 'document') + ':' + capture);
      if (type !== 'keydown' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey ||
          !nativeMutate || !['>', '<', '.', ','].includes(e.key) || e.composedPath().some(node =>
            node instanceof Element && node.closest('input,textarea,select,[contenteditable],[role="textbox"]'))) return;
      const v = document.querySelector('#movie_player video');
      if (v) { nativeChanges++; v.playbackRate = Math.max(.25, Math.min(2, v.playbackRate + (['>','.'].includes(e.key) ? .25 : -.25))); }
    }, capture);
  }
}
</script>
<button id="outside">Outside</button><video id="preview" muted></video>
<ytd-watch-flexy video-id="alpha"><div id="movie_player"><video class="html5-main-video" id="main" muted></video></div></ytd-watch-flexy>
<input id="search"><textarea id="comment"></textarea><div id="editable" contenteditable="true">Comment</div>
<select id="select"><option>one</option></select><div role="textbox" id="textbox" tabindex="0"></div>
<div id="shadow"></div><div id="other-fullscreen">Other fullscreen content</div>
<script>shadow.attachShadow({mode:'open'}).innerHTML='<input id="inner">';</script>`;
async function fixture(url = 'https://www.youtube.com/watch?v=alpha') {
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto(url); await page.waitForSelector('#minimal-video-speed-root', { state: 'attached' });
  return page;
}
const rate = page => page.$eval('#main', v => v.playbackRate);
const setRate = (page, value) => page.$eval('#main', (v, value) => { v.playbackRate = value; }, value);
const key = (page, key = 'Shift+>') => page.keyboard.press(key);

test('actual isolated-world capture beats earlier page listeners, repeats across 2x, respects bounds and off-grid rates', async () => {
  const page = await fixture();
  await setRate(page, 1.75);
  for (const expected of [2, 2.25, 2.5, 2.75, 3]) { await key(page); assert.equal(await rate(page), expected); }
  await page.keyboard.down('Shift');
  await page.keyboard.down('<'); await page.keyboard.down('<');
  assert.equal(await rate(page), 2.5);
  await page.keyboard.up('<'); await page.keyboard.up('Shift');
  for (const expected of [2.25, 2, 1.75]) { await key(page, 'Shift+<'); assert.equal(await rate(page), expected); }
  await setRate(page, 15.9); await key(page); await key(page); assert.equal(await rate(page), 16);
  await setRate(page, .0625); await key(page, 'Shift+<'); await key(page, 'Shift+<');
  assert.equal(await rate(page), .0625, 'browser-rejected lower rates retain current speed without native fallback');
  await setRate(page, 3.1); await key(page, 'Shift+<'); assert.equal(await rate(page), 2.85);
  assert.equal(await page.evaluate(() => nativeChanges), 0);
  // Shift events themselves pass; none of the owned punctuation sequence does.
  assert.equal(await page.evaluate(() => nativeEvents.filter(x => x.startsWith('keypress')).length), 0);
  assert.equal(await page.$eval('#preview', v => v.playbackRate), 1);
  assert.equal(await page.$eval('#main', v => v.paused), true);
  await page.close();
});

test('search/comments/contenteditable/shadow fields and unrelated modifiers keep their events and text', async () => {
  const page = await fixture();
  await page.evaluate(() => { nativeMutate = false; });
  for (const selector of ['#search','#comment','#editable','#select','#textbox','#shadow #inner']) {
    await page.locator(selector).focus(); const before = await rate(page);
    const seen = await page.evaluate(() => nativeEvents.filter(e => e.startsWith('keydown:>')).length);
    await key(page); await key(page, 'Shift+<'); assert.equal(await rate(page), before, selector);
    assert.ok(await page.evaluate(() => nativeEvents.filter(e => e.startsWith('keydown:>')).length) > seen);
  }
  await page.locator('#search').focus(); await key(page);
  assert.match(await page.locator('#search').inputValue(), />/);
  await page.locator('#outside').focus();
  for (const combo of ['Control+Shift+>', 'Meta+Shift+>', 'Alt+Shift+>', '.', ',', 'k', '/', 'Shift+?']) {
    const before = await rate(page); await key(page, combo); assert.equal(await rate(page), before, combo);
  }
  assert.equal(await page.evaluate(() => nativeChanges), 0);
  await page.close();
});

test('live SPA route/player identity, navigation gap, missing/hidden video and fullscreen choose only current watch player', async () => {
  const page = await fixture();
  await page.evaluate(() => { nativeMutate = false; });
  await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-start')));
  await key(page); assert.equal(await rate(page), 1);
  // Native is independent of the extension: disable only the fixture rate mutations for ignored events.
  await page.evaluate(() => { document.querySelector('#main').playbackRate = 1; history.pushState({}, '', '/feed/subscriptions'); });
  const nativeBefore = await page.evaluate(() => nativeEvents.length);
  await key(page); assert.ok(await page.evaluate(() => nativeEvents.length) > nativeBefore);
  await page.evaluate(() => {
    history.pushState({}, '', '/watch?v=beta'); document.dispatchEvent(new Event('yt-navigate-finish'));
    document.querySelector('#main').playbackRate = 1;
  });
  // Mismatched old watch DOM passes the key through instead of changing the stale video.
  await key(page); assert.equal(await rate(page), 1);
  await page.evaluate(() => { window.nativeChanges = 0; document.querySelector('ytd-watch-flexy').setAttribute('video-id','beta');
    const old = document.querySelector('#main'); old.id = 'old';
    const next = document.createElement('video'); next.className = 'html5-main-video'; next.id = 'main'; next.muted = true;
    old.replaceWith(next);
  });
  await key(page); assert.equal(await rate(page), 1.25); assert.equal(await page.evaluate(() => nativeChanges), 0);
  await page.locator('#movie_player').evaluate(node => node.requestFullscreen());
  await key(page); assert.equal(await rate(page), 1.5);
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('#other-fullscreen').evaluate(node => node.requestFullscreen());
  const seen = await page.evaluate(() => nativeEvents.length); await key(page);
  assert.ok(await page.evaluate(() => nativeEvents.length) > seen);
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('#main').evaluate(node => { node.hidden = true; });
  await key(page); assert.equal(await rate(page), 1.5);
  await page.locator('#main').evaluate(node => { node.hidden = false; });
  await page.evaluate(() => document.querySelector('#main').remove());
  await key(page); assert.equal(await page.$eval('#preview', v => v.playbackRate), 1);
  await page.close();
});

test('other sites keep native handlers and their existing controller', async () => {
  const page = await fixture('https://example.com/watch?v=alpha');
  await page.evaluate(() => { nativeMutate = false; });
  await key(page); assert.equal(await rate(page), 1);
  assert.ok(await page.evaluate(() => nativeEvents.some(e => e.startsWith('keydown:>'))));
  await page.close();
});

test('hover preview and configured overlay step share their saved rate with keyboard control', async () => {
  const page = await fixture();
  // Configure through the isolated world's real storage API, never the user's profile.
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({adjustmentStep:.5}));
  await setRate(page, 3);
  await page.locator('#main').hover({position:{x:320,y:180}});
  assert.equal(await rate(page), 1, 'center band previews 1x');
  await key(page); assert.equal(await rate(page), 3.25, 'changes saved 3x rather than temporary 1x');
  await page.mouse.move(900, 500); assert.equal(await rate(page), 3.25);
  await page.locator('#main').hover({position:{x:600,y:300}});
  await page.locator('#minimal-video-speed-root').evaluate(host => {
    host.shadowRoot.querySelector('[data-action="increase"]').click();
  });
  assert.equal(await rate(page), 3.75, 'overlay still honors its configured .5x step');
  await page.mouse.move(900, 500);
  await page.locator('#preview').hover({position:{x:320,y:180}});
  const otherReadout = await page.locator('#minimal-video-speed-root').evaluate(host =>
    host.shadowRoot.querySelector('.preset[data-active="true"]').textContent);
  await key(page);
  assert.equal(await rate(page), 4, 'watch player is selected even with another video hovered');
  assert.equal(await page.$eval('#preview', v => v.playbackRate), 1);
  assert.equal(await page.locator('#minimal-video-speed-root').evaluate(host =>
    host.shadowRoot.querySelector('.preset[data-active="true"]').textContent), otherReadout);
  await page.close();
  assert.deepEqual(errors, []);
});
