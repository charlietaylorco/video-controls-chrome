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
async function fixture({ enabled = true, width = 1100, height = 1100, theme = 'system', colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  // Block every real network request, including Reader and YouTube.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{font-family:Arial,sans-serif;margin:0;padding:24px;background:#fafafa;color:#171717}main{max-width:850px;margin:auto}video{width:100%;height:290px;background:#1e252b;border-radius:12px}h1{font-size:22px}#above-the-fold>p{color:#777;font-size:13px}.fixture{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#777}</style>
    <button id="outside" type="button">Outside control</button><main><p class="fixture">Mock YouTube layout · Reader fixtures only</p><video muted></video><ytd-watch-metadata><div id="above-the-fold"><h1>How attention shapes the way we learn</h1><p>Example channel &nbsp; · &nbsp; Like &nbsp; Share &nbsp; Save</p></div></ytd-watch-metadata></main>` }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ enabled, theme }) => {
    // Expose only this test's closed roots to automation; production remains closed.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) { return attach.call(this, { ...init, mode: 'open' }); };
    const changes = [];
    const data = { showReaderPanel: enabled, showReader: true, readerPanelTheme: theme };
    window.mock = { messages: [], callbacks: [], defer: false, notes: 'A useful observation to revisit.',
      summary: 'Attention is a limited resource. This video explores how deliberate practice, fewer distractions, and time for reflection can help us learn.\n\nThe key idea: make space for what matters before adding more information.',
      tags: ['Learning', 'Ideas to try'], location: 'later', moveError: null, conflict: false, empty: false, error: null, saveError: null, deleteError: null, deleteReply: null, deleted: [], ids: {},
      change(values) {
        const changed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]));
        Object.assign(data, values);
        changes.forEach(fn => fn(changed, 'local'));
      },
      release() { const [callback, response] = this.callbacks.shift(); callback(response); },
    };
    const documentFor = message => ({ id: mock.ids[message.pageUrl] || (message.pageUrl.includes('beta') ? 'doc-b' : 'doc-a'),
      videoUrl: message.pageUrl, title: 'How attention shapes the way we learn', updatedAt: 'v1', location: mock.location, summary: mock.summary, notes: mock.notes, tags: mock.tags });
    window.chrome = {
      runtime: { lastError: null,
        sendMessage(message, callback) {
          mock.messages.push(message);
          let response;
          if (message.type === 'reader-panel-get') response = mock.error ? { ok: false, code: mock.error }
            : { ok: true, document: mock.empty || mock.deleted.includes(message.pageUrl) ? null : documentFor(message), nextCursor: mock.empty ? 'next' : null };
          else if (message.type === 'reader-panel-save-note') {
            response = mock.saveError ? { ok: false, code: mock.saveError } : mock.conflict ? { ok: false, code: 'conflict', document: { ...documentFor(message), notes: 'External Reader note' } }
              : { ok: true, id: message.id, notes: message.notes };
          } else if (message.type === 'reader-panel-delete') {
            response = mock.deleteReply || (mock.deleteError ? { ok: false, code: mock.deleteError } : { ok: true, id: message.id });
            if (response.ok) mock.deleted.push(message.pageUrl);
          } else if (message.type === 'reader-panel-move') {
            if (!mock.moveError) mock.location = message.location;
            response = mock.moveError ? { ok: false, code: mock.moveError } : { ok: true, document: documentFor(message) };
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
  }, { enabled, theme });
  await page.goto(A);
  for (const file of ['reader-core.js', 'reader-editor.js', 'reader-peek.js', 'reader-panel.js']) await page.addScriptTag({ path: path.join(root, file) });
  const panel = page.locator('#mvs-reader-panel');
  const editor = panel.frameLocator('iframe[title="Document Note"]').locator('textarea');
  const open = async (tab) => {
    if (await panel.locator('.toggle').getAttribute('aria-expanded') === 'false') await panel.locator('.toggle').click();
    if (tab === 'note' && await panel.getByRole('tab', { name: /^Note/ }).isVisible() && await panel.getByRole('tab', { name: /^Note/ }).isEnabled()) await panel.getByRole('tab', { name: /^Note/ }).click();
  };
  const navigate = async url => {
    await page.evaluate(url => { history.pushState({}, '', url); document.dispatchEvent(new Event('yt-navigate-finish')); }, url);
  };
  const trash = async () => { await panel.locator('.location').click(); await panel.getByRole('menuitem', { name: 'Delete from Reader', exact: true }).click(); };
  return { page, panel, editor, open, trash, navigate, errors, close: () => context.close() };
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

test('SPA navigation: a closed panel opens on the current URL before the finish event', async () => {
  const f = await fixture(); await f.open(); await f.panel.getByRole('button', { name: 'Close Reader', exact: true }).click();
  await f.page.evaluate(url => history.pushState({}, '', url), B); await f.open();
  const request = await f.page.evaluate(() => mock.messages.at(-1));
  assert.equal(request.type, 'reader-panel-get'); assert.equal(request.pageUrl, B);
  assert.equal(await f.panel.locator('a[aria-label="Open in Reader"]').getAttribute('href'), 'https://read.readwise.io/read/doc-b');
  assert.deepEqual(f.errors, []); await f.close();
});

test('SPA navigation: an open panel rebinds without closing and late replies cannot replace its next video', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Draft A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.navigate(B); assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'true');
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('a[aria-label="Open in Reader"]').getAttribute('href'), 'https://read.readwise.io/read/doc-b');
  await f.navigate(A); await f.panel.getByRole('tab', { name: /^Note/ }).click(); assert.equal(await f.editor.inputValue(), 'Draft A');
  const count = await f.page.evaluate(() => mock.messages.length);
  await f.navigate(A + '&t=12#chapter'); assert.equal(await f.page.evaluate(() => mock.messages.length), count);
  assert.deepEqual(f.errors, []); await f.close();
});

test('dirty drafts survive refresh, collapse, SPA navigation and late responses', async () => {
  const f = await fixture(); await f.open('note');
  await f.editor.fill('Draft for A');
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await f.editor.inputValue(), 'Draft for A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.navigate(B); await f.open('note');
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.editor.inputValue(), 'A useful observation to revisit.');
  await f.editor.fill('Draft for B');
  await f.navigate(A); await f.open('note');
  assert.equal(await f.editor.inputValue(), 'Draft for A');
  await f.navigate(B); await f.open('note');
  assert.equal(await f.editor.inputValue(), 'Draft for B');
  assert.deepEqual(f.errors, []); await f.close();
});

test('late save stays on its captured video and preserves edits made while saving', async () => {
  const f = await fixture(); await f.open('note');
  await f.editor.fill('Sent A');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.editor.fill('Newer A draft');
  await f.navigate(B); await f.open('note');
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.editor.inputValue(), 'A useful observation to revisit.');
  const saves = await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-save-note'));
  assert.equal(saves.length, 1); assert.equal(saves[0].pageUrl, A); assert.equal(saves[0].id, 'doc-a'); assert.equal(saves[0].notes, 'Sent A');
  await f.navigate(A); await f.open('note');
  assert.equal(await f.editor.inputValue(), 'Newer A draft');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});

test('refresh while typing does not replace the draft and external changes require resolution', async () => {
  const f = await fixture(); await f.open('note');
  await f.page.evaluate(() => { mock.defer = true; mock.notes = 'Changed elsewhere'; });
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await f.editor.fill('Typed while loading');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.editor.inputValue(), 'Typed while loading');
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
  await f.editor.fill('Local draft');
  await f.page.evaluate(() => { mock.conflict = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.equal(await f.editor.inputValue(), 'Local draft');
  assert.equal(await f.panel.locator('.remote').innerText(), 'External Reader note');
  await f.panel.getByText('Use Reader note', { exact: true }).click();
  assert.equal(await f.editor.inputValue(), 'External Reader note');
  await f.editor.fill('');
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
  assert.equal(await f.editor.inputValue(), malicious);
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
  await f.editor.fill('Preserved after remount');
  await f.page.evaluate(() => { const el = document.querySelector('#above-the-fold'); el.replaceChildren(); });
  await f.page.evaluate(() => document.querySelector('#mvs-reader-panel').remove());
  await f.panel.waitFor();
  assert.equal(await f.editor.inputValue(), 'Preserved after remount');
  await f.navigate('https://www.youtube.com/');
  await f.panel.waitFor({ state: 'detached' });
  assert.deepEqual(f.errors, []); await f.close();
});

test('compact launcher and popover fit light, dark, mobile and short viewports without page reflow', async () => {
  fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
  for (const [name, width, height, dark] of [['reader-desktop-light', 1100, 900, false], ['reader-desktop-dark', 1100, 900, true], ['reader-mobile', 390, 800, false], ['reader-short', 320, 240, false]]) {
    const f = await fixture({ width, height });
    await f.page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
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
  await f.editor.fill('Draft from previous connection');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.page.evaluate(() => { mock.change({ readerToken: 'changed-fixture-token' }); mock.release(); mock.defer = false; });
  assert.equal(await f.editor.inputValue(), 'Draft from previous connection');
  assert.equal(await f.panel.getByText('Save note', { exact: true }).isDisabled(), true);
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});


test('Escape, close button, outside click and outside focus dismiss without losing the note', async () => {
  const f = await fixture(); await f.open('note');
  await f.editor.fill('Kept through dismissal');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await f.panel.locator('.toggle').evaluate(el => el.getRootNode().activeElement === el), true);
  await f.open('note');
  assert.equal(await f.editor.inputValue(), 'Kept through dismissal');
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
  assert.equal(await f.editor.inputValue(), 'Kept through dismissal');
  assert.equal(await f.panel.getByRole('tab', { name: /^Note/ }).getAttribute('aria-label'), 'Note, unsaved draft');
  assert.deepEqual(f.errors, []); await f.close();
});

test('Summary is first and keyboard tab switching preserves drafts and visible tags', async () => {
  const f = await fixture(); await f.open();
  const summary = f.panel.getByRole('tab', { name: 'Summary', exact: true });
  const note = f.panel.getByRole('tab', { name: /^Note/ });
  assert.equal(await summary.getAttribute('aria-selected'), 'true');
  assert.equal(await f.editor.isVisible(), false);
  await summary.focus(); await f.page.keyboard.press('ArrowRight');
  assert.equal(await note.getAttribute('aria-selected'), 'true');
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  await f.editor.fill('Draft across views');
  await note.focus(); await f.page.keyboard.press('Home');
  assert.equal(await summary.getAttribute('aria-selected'), 'true');
  assert.equal(await f.panel.locator('.tag-toggle').isVisible(), true);
  await f.page.keyboard.press('End');
  assert.equal(await f.editor.inputValue(), 'Draft across views');
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
  await f.editor.fill('Sent draft');
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.editor.fill('Newer draft');
  await f.page.keyboard.press('Escape');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  await f.open('note');
  assert.equal(await f.editor.inputValue(), 'Newer draft');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});


test('fullscreen hides the launcher and resizing keeps the restored draft inside the viewport', async () => {
  const f = await fixture(); await f.open('note');
  await f.editor.fill('Kept during fullscreen');
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
  assert.equal(await f.editor.inputValue(), 'Kept during fullscreen');
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
  assert.equal(await f.panel.locator('h2:visible, label:visible, .hint:visible').count(), 0);
  assert.equal(await f.panel.locator('.status').isVisible(), false);
  const header = f.panel.locator('.header');
  const headerBounds = await header.boundingBox();
  assert.ok(headerBounds.height <= 40);
  for (const label of ['Refresh', 'More Reader actions', 'Close Reader']) {
    const action = f.panel.getByRole(label === 'Open in Reader' ? 'link' : 'button', { name: label, exact: true });
    assert.ok(await action.getAttribute('title'));
    assert.equal(await action.innerText(), '');
    const bounds = await action.boundingBox();
    assert.ok(bounds.width >= 28 && bounds.height >= 28);
    assert.ok(bounds.y >= headerBounds.y && bounds.y + bounds.height <= headerBounds.y + headerBounds.height);
  }
  await f.panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-get').length), 2);
  await f.panel.getByRole('button', { name: 'More Reader actions', exact: true }).click();
  const popupPromise = f.page.waitForEvent('popup');
  await f.panel.getByRole('menuitem', { name: 'Open in Reader', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL('https://read.readwise.io/read/doc-a');
  assert.equal(popup.url(), 'https://read.readwise.io/read/doc-a');
  await popup.close();
  await f.panel.getByRole('button', { name: 'More Reader actions', exact: true }).click();
  await f.panel.getByRole('menuitem', { name: 'Extension options', exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.at(-1).type), 'open-options');
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.editor.isVisible(), true);
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

test('location and overflow menus fit narrow viewports and keep the Note draft and header geometry', async () => {
  for (const width of [280, 390]) {
    const f = await fixture({ width, height: 520 }); await f.open('note'); await f.editor.fill('Keep this draft');
    const before = await f.panel.locator('.header').boundingBox();
    await f.panel.locator('.location').click();
    const menu = f.panel.locator('#reader-location-menu'), bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 520);
    assert.deepEqual(await menu.getByRole('menuitemradio').allTextContents(), ['Later', 'Shortlist', 'Archive']);
    await menu.getByRole('menuitemradio', { name: 'Shortlist', exact: true }).click();
    assert.equal(await f.panel.locator('.location-label').innerText(), 'Shortlist');
    assert.equal(await f.editor.inputValue(), 'Keep this draft');
    assert.deepEqual(await f.panel.locator('.header').boundingBox(), before);
    await f.panel.getByRole('button', { name: 'More Reader actions', exact: true }).focus();
    await f.page.keyboard.press('ArrowDown');
    assert.equal(await f.panel.getByRole('menuitem', { name: 'Open in Reader', exact: true }).evaluate(el => el.getRootNode().activeElement === el), true);
    await f.page.keyboard.press('End');
    assert.equal(await f.panel.getByRole('menuitem', { name: 'Watch list', exact: true }).evaluate(el => el.getRootNode().activeElement === el), true);
    await f.page.keyboard.press('Escape'); assert.equal(await f.panel.locator('#reader-more-menu').isVisible(), false);
    assert.equal(await f.panel.getByRole('dialog').isVisible(), true);
    assert.deepEqual(f.errors, []); await f.close();
  }
});

test('launcher summary peek is temporary, focus-free, and pins the normal Note panel without changing its draft', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Keep while peeking');
  await f.panel.getByRole('button', { name: 'Close Reader', exact: true }).click();
  await f.panel.locator('.toggle').hover(); await f.panel.locator('.peek').waitFor({ state: 'visible' });
  assert.match(await f.panel.locator('.peek-summary').innerText(), /Attention is a limited resource/);
  assert.equal(await f.panel.locator('.body').isVisible(), false);
  assert.equal(await f.panel.locator('#reader-note-tab').getAttribute('aria-selected'), 'true');
  assert.equal(await f.panel.locator('.toggle').evaluate(el => el.getRootNode().activeElement === el), true);
  await f.panel.locator('.toggle').click();
  assert.equal(await f.panel.locator('.peek').isVisible(), false); assert.equal(await f.editor.inputValue(), 'Keep while peeking');
  assert.equal(await f.panel.getByRole('tab', { name: /^Note/ }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await f.page.evaluate(() => mock.messages.map(m => m.type)), ['reader-panel-get']);
  assert.deepEqual(f.errors, []); await f.close();
});

test('native note keyboard events never reach host capture/bubble shortcuts, while editing remains native', async () => {
  const f = await fixture();
  await f.page.addScriptTag({ path: path.join(root, 'content.js') });
  await f.page.evaluate(() => {
    window.shortcutKeys = [];
    for (const target of [window, document]) for (const capture of [true, false]) {
      for (const type of ['keydown', 'keypress', 'keyup']) target.addEventListener(type, event => {
        shortcutKeys.push({ key: event.key, type, capture });
      }, capture);
    }
  });
  await f.open('note');
  await f.editor.fill('');
  await f.editor.pressSequentially('alpha beta');
  await f.editor.press('ArrowLeft'); await f.editor.press('ArrowRight');
  await f.editor.press('Shift+ArrowLeft');
  assert.equal(await f.editor.evaluate(el => el.selectionEnd - el.selectionStart), 1);
  await f.editor.press('ArrowRight');
  await f.editor.press('Enter');
  await f.editor.pressSequentially('k j f');
  assert.equal(await f.editor.inputValue(), 'alpha beta\nk j f');
  assert.deepEqual(await f.page.evaluate(() => shortcutKeys), []);
  // Native modifier commands retain defaults; no clipboard data is read or replaced.
  const defaults = await f.editor.evaluate(el => [
    new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true, composed: true }),
    new ClipboardEvent('copy', { bubbles: true, cancelable: true, composed: true }),
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true })
  ].map(event => { el.dispatchEvent(event); return event.defaultPrevented; }));
  assert.deepEqual(defaults, [false, false, false]);
  await f.editor.press('ControlOrMeta+a');
  assert.equal(await f.editor.evaluate(el => el.selectionEnd - el.selectionStart), (await f.editor.inputValue()).length);
  await f.editor.press('Escape');
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await f.panel.locator('.toggle').evaluate(el => el.getRootNode().activeElement === el), true);
  assert.deepEqual(await f.page.evaluate(() => shortcutKeys), []);
  await f.page.locator('#outside').focus(); await f.page.keyboard.press('Space');
  assert.ok((await f.page.evaluate(() => shortcutKeys)).some(event => event.key === ' '));
  assert.deepEqual(f.errors, []); await f.close();
});

test('IME composition Escape stays in the editor and composed Unicode input retains the draft', async () => {
  const f = await fixture(); await f.open('note');
  await f.editor.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    el.value = '日本語 café';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語 café', isComposing: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語 café' }));
  });
  assert.equal(await f.panel.locator('.toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await f.editor.inputValue(), '日本語 café');
  assert.match(await f.panel.locator('.footer').innerText(), /Unsaved draft/);
  assert.deepEqual(f.errors, []); await f.close();
});

function contrast(a, b) {
  const luminance = value => {
    const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
      const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test('all theme modes and live system changes keep launcher hover, editor and errors opaque and legible', async () => {
  const f = await fixture();
  await f.page.addStyleTag({ content: 'html{--yt-spec-badge-chip-background:rgba(0,0,0,0)}' });
  for (const [mode, system, expected] of [['system', 'light', 'light'], ['system', 'dark', 'dark'], ['light', 'dark', 'light'], ['dark', 'light', 'dark']]) {
    await f.page.evaluate(mode => mock.change({ readerPanelTheme: mode }), mode);
    await f.page.emulateMedia({ colorScheme: system });
    await f.panel.locator('.toggle').hover();
    const styles = await f.panel.locator('.toggle').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color, theme: el.getRootNode().host.dataset.theme }));
    assert.equal(styles.theme, expected);
    assert.match(styles.bg, /^rgb\(/); // Opaque, never the inherited translucent material.
    assert.ok(contrast(styles.bg, styles.fg) >= 4.5);
  }
  await f.open('note');
  const editor = await f.editor.evaluate(el => ({ bg: getComputedStyle(el.ownerDocument.body).backgroundColor, fg: getComputedStyle(el).color }));
  assert.ok(contrast(editor.bg, editor.fg) >= 4.5);
  await f.editor.fill('Unsaved');
  await f.page.evaluate(() => { mock.saveError = 'unauthorized'; });
  await f.panel.getByText('Save note', { exact: true }).click();
  const error = await f.panel.locator('.status').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  assert.ok(contrast(error.bg, error.fg) >= 4.5);
  assert.deepEqual(f.errors, []); await f.close();
});

async function dragHeader(f, x, y) {
  const header = await f.panel.locator('.header').boundingBox();
  await f.page.mouse.move(header.x + header.width / 2, header.y + 2);
  await f.page.mouse.down(); await f.page.mouse.move(x, y, { steps: 4 }); await f.page.mouse.up();
}

test('safe header drag tracks the grab point, clamps, persists in this tab and reclamps on resize', async () => {
  const f = await fixture(); await f.open();
  const initial = await f.panel.getByRole('dialog').boundingBox();
  await dragHeader(f, initial.x + initial.width / 2 - 200, initial.y + 102);
  let bounds = await f.panel.getByRole('dialog').boundingBox();
  assert.ok(Math.abs(bounds.x - (initial.x - 200)) < 2);
  assert.ok(Math.abs(bounds.y - (initial.y + 100)) < 2);
  await f.page.keyboard.press('Escape'); await f.open();
  assert.deepEqual(await f.panel.getByRole('dialog').boundingBox(), bounds);
  await f.navigate(B); await f.open();
  assert.deepEqual(await f.panel.getByRole('dialog').boundingBox(), bounds);
  await dragHeader(f, 2000, 2000);
  bounds = await f.panel.getByRole('dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1100 && bounds.y + bounds.height <= 1100);
  await f.page.setViewportSize({ width: 280, height: 260 });
  await f.page.waitForFunction(() => {
    const bounds = document.querySelector('#mvs-reader-panel').shadowRoot.querySelector('.body').getBoundingClientRect();
    return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  });
  bounds = await f.panel.getByRole('dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 280 && bounds.y + bounds.height <= 260);
  assert.equal(await f.panel.locator('.header').getAttribute('data-dragging'), 'false');
  assert.deepEqual(f.errors, []); await f.close();
});

test('header controls and editor/summary text selection never initiate a drag', async () => {
  const f = await fixture(); await f.open('note');
  const before = await f.panel.getByRole('dialog').boundingBox();
  const control = await f.panel.getByRole('button', { name: 'Refresh', exact: true }).boundingBox();
  await f.page.mouse.move(control.x + 14, control.y + 14); await f.page.mouse.down();
  await f.page.mouse.move(control.x + 55, control.y + 25, { steps: 3 }); await f.page.mouse.up();
  assert.deepEqual(await f.panel.getByRole('dialog').boundingBox(), before);
  await f.editor.fill('Selectable note text'); await f.editor.press('ControlOrMeta+a');
  assert.equal(await f.editor.evaluate(el => el.selectionEnd - el.selectionStart), 'Selectable note text'.length);
  assert.notEqual(await f.panel.locator('.header').getAttribute('data-dragging'), 'true');
  await f.panel.getByRole('tab', { name: 'Summary', exact: true }).click();
  const summaryBefore = await f.panel.getByRole('dialog').boundingBox();
  const text = await f.panel.locator('.summary').boundingBox();
  await f.page.mouse.move(text.x + 5, text.y + 8); await f.page.mouse.down();
  await f.page.mouse.move(text.x + 120, text.y + 8, { steps: 3 }); await f.page.mouse.up();
  assert.deepEqual(await f.panel.getByRole('dialog').boundingBox(), summaryBefore);
  assert.notEqual(await f.panel.locator('.header').getAttribute('data-dragging'), 'true');
  assert.deepEqual(f.errors, []); await f.close();
});

async function noteGeometry(f) {
  return { editor: await f.panel.locator('.editor').boundingBox(), popover: await f.panel.getByRole('dialog').boundingBox(), save: await f.panel.getByText('Save note', { exact: true }).boundingBox() };
}

test('Delete browser: confirmation is inert text, focuses Cancel and restores note geometry on cancel/Escape at narrow widths', async () => {
  for (const width of [280, 390]) {
    const f = await fixture({ width, height: 520 }); await f.open('note');
    await f.editor.fill('Preserved local draft');
    const before = await noteGeometry(f), videoBefore = await f.page.locator('video').boundingBox();
    await f.trash();
    const confirmation = f.panel.getByRole('alertdialog');
    assert.match(await confirmation.innerText(), /How attention shapes the way we learn/);
    assert.match(await confirmation.innerText(), /alpha.*doc-a/);
    assert.match(await confirmation.innerText(), /highlights and their notes.*cannot undo deletion/s);
    assert.match(await confirmation.innerText(), /unsaved local note will stay in this tab/);
    assert.equal(await confirmation.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el.getRootNode().activeElement === el), true);
    await f.page.keyboard.press('Tab');
    assert.equal(await confirmation.getByRole('button', { name: 'Delete document', exact: true }).evaluate(el => el.getRootNode().activeElement === el), true);
    await f.page.keyboard.press('Tab');
    assert.equal(await confirmation.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el.getRootNode().activeElement === el), true);
    const bounds = await f.panel.getByRole('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 520);
    assert.deepEqual(await f.page.locator('video').boundingBox(), videoBefore);
    assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-delete').length), 0);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await f.editor.inputValue(), 'Preserved local draft'); assert.deepEqual(await noteGeometry(f), before);
    await f.trash();
    await f.page.keyboard.press('Escape');
    assert.equal(await confirmation.isVisible(), false); assert.equal(await f.panel.getByRole('dialog').isVisible(), true);
    assert.deepEqual(await noteGeometry(f), before); assert.deepEqual(f.errors, []); await f.close();
  }
});

test('Delete browser: dirty success preserves newer text without layout shifts and clean success becomes unsaved without auto-save', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Before deletion');
  const before = await noteGeometry(f);
  await f.trash();
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
  assert.deepEqual(await noteGeometry(f), before);
  await f.editor.fill('Typed while deletion pending');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.match(await f.panel.locator('.status').innerText(), /Deleted from Reader.*unsaved note is kept/s);
  assert.equal(await f.editor.inputValue(), 'Typed while deletion pending'); assert.deepEqual(await noteGeometry(f), before);
  assert.equal(await f.panel.getByRole('button', { name: 'Save note', exact: true }).isDisabled(), true);
  assert.equal(await f.panel.locator('button[aria-label="Delete from Reader"]').isDisabled(), true);
  assert.deepEqual(await f.page.evaluate(() => mock.messages.map(m => m.type)), ['reader-panel-get', 'reader-panel-delete']);
  assert.deepEqual(f.errors, []); await f.close();
  const clean = await fixture(); await clean.open();
  await clean.trash();
  await clean.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
  assert.match(await clean.panel.locator('.status').innerText(), /^Deleted from Reader/);
  assert.equal(await clean.panel.locator('.summary').isVisible(), false);
  assert.equal(await clean.panel.locator('a[aria-label="Open in Reader"]').getAttribute('href'), null);
  assert.deepEqual(await clean.page.evaluate(() => mock.messages.map(m => m.type)), ['reader-panel-get', 'reader-panel-delete']);
  assert.deepEqual(clean.errors, []); await clean.close();
});

test('Delete browser: navigation and replacement identity cancel confirmation, including before SPA synchronization', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Draft A');
  await f.trash();
  await f.page.evaluate(url => history.pushState({}, '', url), B);
  await f.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-delete').length), 0);
  await f.navigate(B); await f.open('note');
  assert.equal(await f.panel.getByRole('alertdialog').isVisible(), false); assert.equal(await f.editor.inputValue(), 'A useful observation to revisit.');
  await f.navigate(A); await f.open('note'); assert.equal(await f.editor.inputValue(), 'Draft A');
  await f.page.evaluate(url => mock.change({ readerDocuments: { [url]: { id: 'doc-a' } } }), A);
  await f.trash();
  await f.page.evaluate(url => { mock.ids[url] = 'replacement'; mock.change({ readerDocuments: { [url]: { id: 'replacement' } } }); }, A);
  assert.equal(await f.panel.getByRole('alertdialog').isVisible(), false);
  assert.equal(await f.panel.locator('button[aria-label="Delete from Reader"]').isDisabled(), true);
  assert.equal(await f.editor.inputValue(), 'Draft A');
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-delete').length), 0);
  assert.deepEqual(f.errors, []); await f.close();
});

test('Delete browser: a late response stays bound to its video and cannot change the next editor', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Draft for deleted A');
  await f.trash();
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
  await f.navigate(B); await f.open();
  await f.page.evaluate(() => { mock.release(); mock.release(); mock.defer = false; });
  await f.panel.getByRole('tab', { name: /^Note/ }).click();
  assert.equal(await f.editor.inputValue(), 'A useful observation to revisit.');
  assert.equal(await f.panel.locator('button[aria-label="Delete from Reader"]').isEnabled(), true);
  assert.doesNotMatch(await f.panel.locator('.status').textContent(), /Deleted from Reader/);
  const sent = await f.page.evaluate(() => mock.messages.find(m => m.type === 'reader-panel-delete'));
  assert.equal(sent.pageUrl, A); assert.equal(sent.id, 'doc-a');
  await f.navigate(A); await f.open('note'); assert.equal(await f.editor.inputValue(), 'Draft for deleted A');
  assert.equal(await f.panel.getByRole('button', { name: 'Save note', exact: true }).isDisabled(), true);
  assert.deepEqual(f.errors, []); await f.close();
});

test('Delete browser: errors and uncertain outcomes keep the draft and geometry; already absent is distinct', async () => {
  const f = await fixture(); await f.open('note'); await f.editor.fill('Keep on failure');
  const before = await noteGeometry(f);
  for (const code of ['unauthorized', 'rate_limited', 'network_error', 'delete_uncertain', 'delete_cache_error', 'document_changed']) {
    await f.page.evaluate(code => { mock.deleteError = code; }, code);
    await f.trash();
    await f.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
    assert.equal(await f.panel.locator('.status').getAttribute('data-kind'), 'error');
    assert.doesNotMatch(await f.panel.locator('.status').innerText(), /^Deleted from Reader/);
    assert.equal(await f.editor.inputValue(), 'Keep on failure'); assert.deepEqual(await noteGeometry(f), before);
  }
  await f.page.evaluate(() => { mock.deleteReply = { ok: true, id: 'doc-a', alreadyDeleted: true }; });
  await f.trash();
  await f.panel.getByRole('button', { name: 'Delete document', exact: true }).click();
  assert.match(await f.panel.locator('.status').innerText(), /already absent/);
  assert.equal(await f.editor.inputValue(), 'Keep on failure'); assert.deepEqual(await noteGeometry(f), before);
  assert.equal(await f.page.evaluate(() => mock.messages.filter(m => m.type === 'reader-panel-delete').length), 7);
  assert.deepEqual(f.errors, []); await f.close();
});

test('save feedback is beside Save, expires, and never shifts editor or popover geometry', async () => {
  const f = await fixture(); await f.open('note'); await f.page.clock.install();
  await f.editor.fill('Geometry draft');
  const before = await noteGeometry(f);
  await f.page.evaluate(() => { mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.deepEqual(await noteGeometry(f), before);
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('.footer [role="status"]').innerText(), 'Saved');
  assert.equal(await f.panel.locator('.status').isVisible(), false);
  assert.deepEqual(await noteGeometry(f), before);
  await f.page.clock.runFor(3100);
  assert.equal(await f.panel.locator('.footer [role="status"]').innerText(), '');
  assert.deepEqual(await noteGeometry(f), before);
  await f.editor.fill('Newer draft');
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.editor.fill('Typed after success');
  await f.page.clock.runFor(3100);
  assert.equal(await f.panel.locator('.footer [role="status"]').innerText(), 'Unsaved draft');
  assert.deepEqual(await noteGeometry(f), before);
  assert.deepEqual(f.errors, []); await f.close();
});

test('persistent errors/conflicts and late replies keep fixed note geometry and cannot show stale success', async () => {
  const f = await fixture(); await f.open('note'); await f.page.clock.install();
  await f.editor.fill('Keep my draft'); const before = await noteGeometry(f);
  await f.page.evaluate(() => { mock.saveError = 'network_error'; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.match(await f.panel.locator('.status').innerText(), /connection/);
  assert.deepEqual(await noteGeometry(f), before);
  await f.page.clock.runFor(5000);
  assert.equal(await f.panel.locator('.status').isVisible(), true);
  await f.page.evaluate(() => { mock.saveError = null; mock.conflict = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  assert.equal(await f.panel.locator('.conflict').isVisible(), true);
  assert.deepEqual(await noteGeometry(f), before);
  await f.panel.getByText('Keep my draft for next save', { exact: true }).click();
  await f.page.evaluate(() => { mock.conflict = false; mock.defer = true; });
  await f.panel.getByText('Save note', { exact: true }).click();
  await f.editor.fill('Newer text while pending');
  await f.page.evaluate(() => { mock.release(); mock.defer = false; });
  assert.equal(await f.panel.locator('.footer [role="status"]').innerText(), 'Unsaved draft');
  await f.page.clock.runFor(3100);
  assert.equal(await f.panel.locator('.footer [role="status"]').innerText(), 'Unsaved draft');
  await f.navigate(B); await f.page.clock.runFor(160); await f.open('note');
  assert.notEqual(await f.panel.locator('.footer [role="status"]').innerText(), 'Saved');
  assert.deepEqual(f.errors, []); await f.close();
});
