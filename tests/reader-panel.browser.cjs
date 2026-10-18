/* Optional real-browser regression checks. No extension installation or live Reader requests.
 * Run: node --test tests/reader-panel.browser.cjs (requires playwright + its Chromium).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;
const A = 'https://www.youtube.com/watch?v=alpha';
const B = 'https://www.youtube.com/watch?v=beta';
const root = path.resolve(__dirname, '..');
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); });
after(async () => { await browser?.close(); });
async function fixture({ enabled = true, width = 1100 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  // Block every real network request, including Reader and YouTube.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{font-family:Arial,sans-serif;margin:0;padding:24px;background:#fafafa;color:#171717}main{max-width:850px;margin:auto}video{width:100%;height:290px;background:#1e252b;border-radius:12px}h1{font-size:22px}#above-the-fold>p{color:#777;font-size:13px}.fixture{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#777}</style>
    <main><p class="fixture">Mock YouTube layout · Reader fixtures only</p><video muted></video><ytd-watch-metadata><div id="above-the-fold"><h1>How attention shapes the way we learn</h1><p>Example channel &nbsp; · &nbsp; Like &nbsp; Share &nbsp; Save</p></div></ytd-watch-metadata></main>` }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ enabled }) => {
    // Expose only this test's closed roots to automation; production remains closed.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) { return attach.call(this, { ...init, mode: 'open' }); };
    const changes = [];
    const data = { showReaderPanel: enabled, showReader: true };
    window.mock = { messages: [], callbacks: [], defer: false, notes: 'A useful observation to revisit.',
      summary: 'Attention is a limited resource. This video explores how deliberate practice, fewer distractions, and time for reflection can help us learn.\n\nThe key idea: make space for what matters before adding more information.',
      tags: ['Learning', 'Ideas to try'], conflict: false, empty: false, error: null,
      change(values) {
        Object.assign(data, values);
        changes.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'));
      },
      release() { const [callback, response] = this.callbacks.shift(); callback(response); },
    };
    const documentFor = message => ({ id: message.pageUrl.includes('beta') ? 'doc-b' : 'doc-a',
      videoUrl: message.pageUrl, summary: mock.summary, notes: mock.notes, tags: mock.tags });
    window.chrome = {
      runtime: { lastError: null,
        sendMessage(message, callback) {
          mock.messages.push(message);
          let response;
          if (message.type === 'reader-panel-get') response = mock.error ? { ok: false, code: mock.error }
            : { ok: true, document: mock.empty ? null : documentFor(message), nextCursor: mock.empty ? 'next' : null };
          else if (message.type === 'reader-panel-save-note') {
            response = mock.conflict ? { ok: false, code: 'conflict', document: { ...documentFor(message), notes: 'External Reader note' } }
              : { ok: true, id: message.id, notes: message.notes };
          } else if (message.type === 'save-to-reader') response = { ok: true, url: 'https://read.readwise.io/read/doc-a' };
          else response = { ok: true, saved: false };
          if (mock.defer && message.type.startsWith('reader-panel-')) mock.callbacks.push([callback, response]);
          else callback(response);
        },
      },
      storage: { onChanged: { addListener(fn) { changes.push(fn); } }, local: {
        get(keys, cb) { cb(Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])) : { ...keys, ...data }); },
        set(values, cb) { mock.change(values); cb?.(); },
      } },
    };
  }, { enabled });
  await page.goto(A);
  for (const file of ['reader-core.js', 'reader-panel.js']) await page.addScriptTag({ path: path.join(root, file) });
  const panel = page.locator('#mvs-reader-panel');
  const open = () => panel.locator('.toggle').click();
  const navigate = async url => {
    await page.evaluate(url => { history.pushState({}, '', url); document.dispatchEvent(new Event('yt-navigate-finish')); }, url);
    await page.waitForFunction(() => !document.querySelector('#mvs-reader-panel') || document.querySelector('#mvs-reader-panel').shadowRoot.querySelector('.toggle').getAttribute('aria-expanded') === 'false');
  };
  return { page, panel, open, navigate, errors, close: () => context.close() };
}

test('panel is opt-in, collapsed, and opens without creating a Reader document', async () => {
  const f = await fixture({ enabled: false });
  assert.equal(await f.panel.count(), 0);
  await f.page.evaluate(() => mock.change({ showReaderPanel: true }));
  await f.panel.waitFor();
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await f.page.evaluate(() => mock.messages.length), 0);
  await f.open();
  assert.match(await f.panel.locator('.summary').innerText(), /Attention is a limited resource/);
  assert.deepEqual(await f.page.evaluate(() => mock.messages.map(m => m.type)), ['reader-panel-get']);
  assert.equal(await f.panel.locator('a').getAttribute('href'), 'https://read.readwise.io/read/doc-a');
  assert.deepEqual(f.errors, []);
  await f.close();
});

test('dirty drafts survive refresh, collapse, SPA navigation and late responses', async () => {
  const f = await fixture(); await f.open();
  await f.panel.locator('textarea').fill('Draft for A');
  await f.panel.getByText('Refresh', { exact: true }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Refresh', { exact: true }).click();
  await f.navigate(B); await f.open();
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('textarea').inputValue(), 'A useful observation to revisit.');
  await f.panel.locator('textarea').fill('Draft for B');
  await f.navigate(A); await f.open();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for A');
  await f.navigate(B); await f.open();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for B');
  assert.deepEqual(f.errors, []); await f.close();
});

test('late save stays on its captured video and preserves edits made while saving', async () => {
  const f = await fixture(); await f.open();
  await f.panel.locator('textarea').fill('Sent A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.panel.locator('textarea').fill('Newer A draft');
  await f.navigate(B); await f.open();
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('textarea').inputValue(), 'A useful observation to revisit.');
  const saves = await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-save-note'));
  assert.equal(saves.length, 1); assert.equal(saves[0].pageUrl, A); assert.equal(saves[0].id, 'doc-a'); assert.equal(saves[0].notes, 'Sent A');
  await f.navigate(A); await f.open();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Newer A draft');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});

test('refresh while typing does not replace the draft and external changes require resolution', async () => {
  const f = await fixture(); await f.open();
  await f.page.evaluate(() => { mock.defer = true; mock.notes = 'Changed elsewhere'; });
  await f.panel.getByText('Refresh', { exact: true }).click();
  await f.panel.locator('textarea').fill('Typed while loading');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Typed while loading');
  assert.equal(await f.panel.locator('.conflict').isVisible(), true);
  assert.equal(await f.panel.getByText('Save note', { exact: true }).isDisabled(), true);
  await f.panel.getByText('Keep my draft for next save', { exact: true }).click();
  await f.panel.getByText('Save note', { exact: true }).click();
  const sent = await f.page.evaluate(() => mock.messages.at(-1));
  assert.equal(sent.baseNotes, 'Changed elsewhere'); assert.equal(sent.notes, 'Typed while loading');
  assert.deepEqual(f.errors, []); await f.close();
});

test('save conflicts keep draft, offer Reader note, and clear note only with explicit Save', async () => {
  const f = await fixture(); await f.open();
  await f.panel.locator('textarea').fill('Local draft');
  await f.page.evaluate(() => { mock.conflict = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Local draft');
  assert.equal(await f.panel.locator('.remote').innerText(), 'External Reader note');
  await f.panel.getByText('Use Reader note', { exact: true }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'External Reader note');
  await f.panel.locator('textarea').fill('');
  await f.page.evaluate(() => { mock.conflict = false; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.at(-1).notes), '');
  assert.deepEqual(f.errors, []); await f.close();
});

test('remote HTML stays inert text and never becomes a script, image or link', async () => {
  const f = await fixture();
  const malicious = '<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>';
  await f.page.evaluate(value => { mock.summary = value; mock.notes = value; mock.tags = [value]; }, malicious);
  await f.open();
  assert.equal(await f.panel.locator('.summary').innerText(), malicious);
  assert.equal(await f.panel.locator('textarea').inputValue(), malicious);
  assert.equal(await f.panel.locator('.tag').innerText(), malicious);
  assert.equal(await f.panel.locator('img, script').count(), 0);
  assert.equal(await f.page.evaluate(() => window.pwned), undefined);
  assert.deepEqual(f.errors, []); await f.close();
});

test('not-found pagination and errors stay explicit and never trigger automatic retries or saves', async () => {
  const f = await fixture();
  await f.page.evaluate(() => { mock.empty = true; }); await f.open();
  await f.panel.getByText('Search next 100 videos', { exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.at(-1).cursor), 'next');
  await f.page.evaluate(() => { mock.error = 'unauthorized'; });
  await f.panel.getByText('Refresh', { exact: true }).click();
  assert.match(await f.panel.locator('.status').innerText(), /rejected/);
  assert.equal(await f.page.evaluate(() => mock.messages.length), 3);
  assert.ok((await f.page.evaluate(() => mock.messages.map(m => m.type))).every(t => t === 'reader-panel-get'));
  assert.deepEqual(f.errors, []); await f.close();
});

test('panel remounts after YouTube replaces metadata and leaves nonvideo pages unobstructed', async () => {
  const f = await fixture(); await f.open();
  await f.panel.locator('textarea').fill('Preserved after remount');
  await f.page.evaluate(() => { const el = document.querySelector('#above-the-fold'); el.replaceChildren(); });
  await f.panel.waitFor();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Preserved after remount');
  await f.navigate('https://www.youtube.com/');
  await f.panel.waitFor({ state: 'detached' });
  assert.deepEqual(f.errors, []); await f.close();
});

test('light, dark and mobile panel layouts stay below the video without horizontal overflow', async () => {
  fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
  for (const [name, width, dark] of [['reader-desktop-light', 1100, false], ['reader-desktop-dark', 1100, true], ['reader-mobile', 390, false]]) {
    const f = await fixture({ width });
    if (dark) await f.page.addStyleTag({ content: 'body{background:#0f0f0f;color:#f1f1f1;--yt-spec-base-background:#0f0f0f;--yt-spec-text-primary:#f1f1f1;--yt-spec-text-secondary:#aaa;--yt-spec-10-percent-layer:#333;--yt-spec-badge-chip-background:#272727}' });
    await f.open();
    const video = await f.page.locator('video').boundingBox();
    const panel = await f.panel.boundingBox();
    assert.ok(panel.y >= video.y + video.height);
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await f.page.screenshot({ path: path.join(root, `output/playwright/${name}.png`), fullPage: true });
    assert.deepEqual(f.errors, []); await f.close();
  }
});

test('existing playback speed and one-click save still operate with the Reader panel enabled', async () => {
  const f = await fixture();
  // A real watch page extends far beyond the viewport; a tiny fixture main resembles a preview card.
  await f.page.addStyleTag({ content: 'main{min-height:1800px}' });
  await f.page.addScriptTag({ path: path.join(root, 'content.js') });
  await f.page.locator('video').hover({ position: { x: 350, y: 200 } });
  const speed = f.page.locator('[data-rate="2"]');
  await speed.click();
  assert.equal(await f.page.locator('video').evaluate(video => video.playbackRate), 2);
  await f.page.locator('[data-action="reader"]').click();
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'save-to-reader').length), 1);
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-get').length), 0);
  assert.deepEqual(f.errors, []); await f.close();
});


test('credential changes invalidate late note-save replies without rebasing the draft', async () => {
  const f = await fixture(); await f.open();
  await f.panel.locator('textarea').fill('Draft from previous connection');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.page.evaluate(() => { mock.change({ readerToken: 'changed-fixture-token' }); mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft from previous connection');
  assert.equal(await f.panel.getByText('Save note', { exact: true }).isDisabled(), true);
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});
