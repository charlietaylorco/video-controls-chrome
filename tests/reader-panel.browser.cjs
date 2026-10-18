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
async function fixture({ enabled = true, width = 1100, height = 1100 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  // Block every real network request, including Reader and YouTube.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{font-family:Arial,sans-serif;margin:0;padding:24px;background:#fafafa;color:#171717}main{max-width:850px;margin:auto}video{width:100%;height:290px;background:#1e252b;border-radius:12px}h1{font-size:22px}#above-the-fold>p{color:#777;font-size:13px}.fixture{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#777}</style>
    <button id="outside" type="button">Outside control</button><main><p class="fixture">Mock YouTube layout · Reader fixtures only</p><video muted></video><ytd-watch-metadata><div id="above-the-fold"><h1>How attention shapes the way we learn</h1><p>Example channel &nbsp; · &nbsp; Like &nbsp; Share &nbsp; Save</p></div></ytd-watch-metadata></main>` }));
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
  const open = async (tab) => {
    await panel.locator('.toggle').click();
    if (tab === 'note' && await panel.getByRole('tab', { name: /^Note/ }).isVisible() && await panel.getByRole('tab', { name: /^Note/ }).isEnabled()) await panel.getByRole('tab', { name: /^Note/ }).click();
  };
  const navigate = async url => {
    await page.evaluate(url => { history.pushState({}, '', url); document.dispatchEvent(new Event('yt-navigate-finish')); }, url);
    await page.waitForFunction(() => !document.querySelector('#mvs-reader-panel') || document.querySelector('#mvs-reader-panel').shadowRoot.querySelector('.toggle').getAttribute('aria-expanded') === 'false');
  };
  return { page, panel, open, navigate, errors, close: () => context.close() };
}

test('launcher is opt-in, collapsed, and opens without creating a Reader document', async () => {
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
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Draft for A');
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.navigate(B); await f.open('note');
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'A useful observation to revisit.');
  await f.panel.locator('textarea').fill('Draft for B');
  await f.navigate(A); await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for A');
  await f.navigate(B); await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft for B');
  assert.deepEqual(f.errors, []); await f.close();
});

test('late save stays on its captured video and preserves edits made while saving', async () => {
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Sent A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.panel.locator('textarea').fill('Newer A draft');
  await f.navigate(B); await f.open('note');
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'A useful observation to revisit.');
  const saves = await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-save-note'));
  assert.equal(saves.length, 1); assert.equal(saves[0].pageUrl, A); assert.equal(saves[0].id, 'doc-a'); assert.equal(saves[0].notes, 'Sent A');
  await f.navigate(A); await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Newer A draft');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});

test('refresh while typing does not replace the draft and external changes require resolution', async () => {
  const f = await fixture(); await f.open('note');
  await f.page.evaluate(() => { mock.defer = true; mock.notes = 'Changed elsewhere'; });
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
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
  const f = await fixture(); await f.open('note');
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
  await f.panel.locator('.tag-toggle').click();
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
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.match(await f.panel.locator('.status').innerText(), /rejected/);
  assert.equal(await f.page.evaluate(() => mock.messages.length), 3);
  assert.ok((await f.page.evaluate(() => mock.messages.map(m => m.type))).every(t => t === 'reader-panel-get'));
  assert.deepEqual(f.errors, []); await f.close();
});

test('floating UI survives metadata changes and remounts without losing drafts', async () => {
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Preserved after remount');
  await f.page.evaluate(() => { const el = document.querySelector('#above-the-fold'); el.replaceChildren(); });
  await f.page.evaluate(() => document.querySelector('#mvs-reader-panel').remove());
  await f.panel.waitFor();
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Preserved after remount');
  await f.navigate('https://www.youtube.com/');
  await f.panel.waitFor({ state: 'detached' });
  assert.deepEqual(f.errors, []); await f.close();
});

test('compact launcher and popover fit light, dark, mobile and short viewports without page reflow', async () => {
  fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
  for (const [name, width, height, dark] of [['reader-desktop-light', 1100, 900, false], ['reader-desktop-dark', 1100, 900, true], ['reader-mobile', 390, 800, false], ['reader-short', 320, 240, false]]) {
    const f = await fixture({ width, height });
    if (dark) await f.page.addStyleTag({ content: 'html{--yt-spec-base-background:#0f0f0f;--yt-spec-text-primary:#f1f1f1;--yt-spec-text-secondary:#aaa;--yt-spec-10-percent-layer:#333;--yt-spec-badge-chip-background:#272727}body{background:#0f0f0f;color:#f1f1f1}' });
    const before = await f.page.locator('h1').boundingBox();
    const launcher = await f.panel.locator('.toggle').boundingBox();
    assert.equal(launcher.width, 36);
    assert.equal(launcher.y, 0);
    assert.equal(launcher.x + launcher.width, width);
    assert.ok(launcher.x >= 0 && launcher.x + launcher.width <= width);
    await f.open();
    const dialog = await f.panel.getByRole('dialog').boundingBox();
    assert.ok(dialog.width <= 390);
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width, name);
    assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= height, name);
    assert.deepEqual(await f.page.locator('h1').boundingBox(), before);
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await f.page.screenshot({ path: path.join(root, `output/playwright/${name}.png`) });
    await f.panel.getByRole('tab', { name: /^Note/ }).click();
    const noteDialog = await f.panel.getByRole('dialog').boundingBox();
    assert.ok(noteDialog.y + noteDialog.height <= height);
    if (height > 240) await f.page.screenshot({ path: path.join(root, `output/playwright/${name}-note.png`) });
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
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Draft from previous connection');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.page.evaluate(() => { mock.change({ readerToken: 'changed-fixture-token' }); mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft from previous connection');
  assert.equal(await f.panel.getByText('Save note', { exact: true }).isDisabled(), true);
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});


test('Escape, close button, outside click and outside focus dismiss without losing the note', async () => {
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Kept through dismissal');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await f.panel.locator('.toggle').evaluate(el => el.getRootNode().activeElement === el), true);
  await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Kept through dismissal');
  await f.panel.getByRole('button', { name: 'Close Reader', exact: true }).click();
  assert.equal(await f.panel.locator('.toggle').evaluate(el => el.getRootNode().activeElement === el), true);
  await f.open('note');
  await f.page.locator('#outside').click();
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await f.page.locator('#outside').evaluate(el => document.activeElement === el), true);
  await f.open('note');
  await f.page.locator('#outside').focus();
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Kept through dismissal');
  assert.equal(await f.panel.getByRole('tab', { name: /^Note/ }).getAttribute('aria-label'), 'Note, unsaved draft');
  assert.deepEqual(f.errors, []); await f.close();
});

test('Summary is first and keyboard tab switching preserves drafts and visible tags', async () => {
  const f = await fixture(); await f.open();
  const summary = f.panel.getByRole('tab', { name: 'Summary', exact: true });
  const note = f.panel.getByRole('tab', { name: /^Note/ });
  assert.equal(await summary.getAttribute('aria-selected'), 'true');
  assert.equal(await f.panel.locator('textarea').isVisible(), false);
  await summary.focus(); await f.page.keyboard.press('ArrowRight');
  assert.equal(await note.getAttribute('aria-selected'), 'true');
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  await f.panel.locator('textarea').fill('Draft across views');
  await note.focus(); await f.page.keyboard.press('Home');
  assert.equal(await summary.getAttribute('aria-selected'), 'true');
  assert.equal(await f.panel.locator('.tag-toggle').isVisible(), true);
  await f.page.keyboard.press('End');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Draft across views');
  assert.equal(await f.panel.locator('.tag-toggle').isVisible(), true);
  assert.deepEqual(f.errors, []); await f.close();
});

test('dismissal during pending fetch and save never reopens the popover or loses later edits', async () => {
  const f = await fixture();
  await f.page.evaluate(() => { mock.defer = true; }); await f.open();
  await f.page.keyboard.press('Escape');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  await f.open('note');
  await f.panel.locator('textarea').fill('Sent draft');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.panel.locator('textarea').fill('Newer draft');
  await f.page.keyboard.press('Escape');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Newer draft');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});


test('fullscreen hides the launcher and resizing keeps the restored draft inside the viewport', async () => {
  const f = await fixture(); await f.open('note');
  await f.panel.locator('textarea').fill('Kept during fullscreen');
  await f.page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.querySelector('video') });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await f.panel.waitFor({ state: 'detached' });
  await f.page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await f.panel.waitFor(); await f.open('note');
  assert.equal(await f.panel.locator('textarea').inputValue(), 'Kept during fullscreen');
  await f.page.setViewportSize({ width: 280, height: 210 });
  const bounds = await f.panel.getByRole('dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 280);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 210);
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-get').length), 1);
  assert.deepEqual(f.errors, []); await f.close();
});


test('header is one compact row with working icon actions and no removed explanatory chrome', async () => {
  const f = await fixture(); await f.open();
  assert.equal(await f.panel.locator('.toggle').innerText(), '');
  assert.equal(await f.panel.locator('h2, label, .hint').count(), 0);
  assert.equal(await f.panel.locator('.status').isVisible(), false);
  const header = f.panel.locator('.header');
  const headerBounds = await header.boundingBox();
  assert.ok(headerBounds.height <= 40);
  for (const label of ['Refresh', 'Open in Reader', 'Extension options', 'Close Reader']) {
    const action = f.panel.getByRole(label === 'Open in Reader' ? 'link' : 'button', { name: label, exact: true });
    assert.ok(await action.getAttribute('title'));
    assert.equal(await action.innerText(), '');
    const bounds = await action.boundingBox();
    assert.ok(bounds.width >= 28 && bounds.height >= 28);
    assert.ok(bounds.y >= headerBounds.y && bounds.y + bounds.height <= headerBounds.y + headerBounds.height);
  }
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-get').length), 2);
  const popupPromise = f.page.waitForEvent('popup');
  await f.panel.getByRole('link', { name: 'Open in Reader', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL('https://read.readwise.io/read/doc-a');
  assert.equal(popup.url(), 'https://read.readwise.io/read/doc-a');
  await popup.close();
  await f.panel.getByRole('button', { name: 'Extension options', exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.at(-1).type), 'open-options');
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.panel.getByLabel('Document Note', { exact: true }).isVisible(), true);
  assert.equal(await f.panel.locator('.status').isVisible(), false);
  await f.panel.getByRole('button', { name: 'Close Reader', exact: true }).click();
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.errors, []); await f.close();
});

test('long and multiple tags expand safely without displacing header controls at narrow widths', async () => {
  const f = await fixture({ width: 280, height: 640 });
  const tags = ['A very long category name '.repeat(10), ...Array.from({ length: 9 }, (_, i) => `Category ${i}`)];
  await f.page.evaluate(tags => { mock.tags = tags; }, tags);
  await f.open();
  const header = f.panel.locator('.header');
  const before = await header.boundingBox();
  assert.ok(before.height <= 40);
  assert.equal(await f.panel.locator('.tag-total').innerText(), '10');
  await f.panel.getByRole('button', { name: 'Show 10 tags', exact: true }).click();
  assert.equal(await f.panel.locator('.tag').count(), tags.length);
  assert.deepEqual(await f.panel.locator('.tag').allTextContents(), tags);
  assert.deepEqual(await header.boundingBox(), before);
  for (const action of await header.locator('.icon').all()) {
    const bounds = await action.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 280);
    assert.ok(bounds.y >= before.y && bounds.y + bounds.height <= before.y + before.height);
  }
  assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await f.panel.locator('.tag-toggle').click();
  assert.equal(await f.panel.locator('.tags').isVisible(), false);
  assert.deepEqual(f.errors, []); await f.close();
});
