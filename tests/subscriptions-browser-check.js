// Run after build-subscriptions-fixture.js and its generated Playwright CLI setup snippet.
async (page) => {
  const checks = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const host = page.locator('#mvs-subscriptions-tools');
  const dialog = host.locator('dialog');
  const check = async (label, fn, arg) => {
    try { await page.waitForFunction(fn, arg, { timeout: 4000 }); }
    catch { throw new Error(`Failed fixture check: ${label}`); }
    checks.push(label);
  };
  const title = async (text) => check(`review shows ${text}`, value => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.card h2')?.textContent === value, text);
  const entry = async (id, field, present = true) => check(`${id}: ${field} ${present ? 'present' : 'absent'}`, ({ id, field, present }) => Boolean(fixture.saved.subscriptionsReviewV1?.entries[id]?.[field]) === present, { id, field, present });
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => localStorage.removeItem('subscriptions-fixture-storage'));
  await page.reload();
  await click('Review subscriptions');
  await title('First native upload · 2 weeks ago');
  await page.evaluate(() => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.card')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: true, bubbles: true, composed: true })));
  await check('held decision keys neither commit nor reach YouTube hotkeys', () => !fixture.saved.subscriptionsReviewV1 && !fixture.pageKeys.includes('ArrowLeft'));
  await check('duplicate cards deduplicate and approximate dates do not sort the deck', () => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.scope').textContent.startsWith('3 loaded'));
  if (await dialog.getAttribute('aria-label') !== 'Review subscriptions') throw new Error('Dialog needs an accessible name');
  await page.screenshot({ path: 'subscriptions-review-desktop.png' });
  await page.keyboard.press('ArrowLeft');
  await entry('abcdefghijk', 'hiddenAt');
  await check('both duplicates hide in the ordinary feed', () => document.querySelectorAll('[data-mvs-subscription-hidden="abcdefghijk"]').length === 2 &&
    Array.from(document.querySelectorAll('[data-mvs-subscription-hidden]')).every(card => getComputedStyle(card).display === 'none'));
  await title('Second native upload · 1 hour ago');
  await page.keyboard.press('ArrowRight');
  await entry('lmnopqrstuv', 'laterAt');
  await check('Later leaves the native subscription card visible', () => getComputedStyle(document.querySelector('ytd-grid-video-renderer')).display !== 'none');
  await check('handled shortcuts do not reach YouTube page hotkeys', () => !fixture.pageKeys.includes('ArrowLeft') && !fixture.pageKeys.includes('ArrowRight'));
  await page.keyboard.press('Meta+z');
  await entry('lmnopqrstuv', 'laterAt', false);
  await title('Second native upload · 1 hour ago');
  await page.keyboard.press('ArrowDown');
  await title('Third native upload');
  await click('Undo');
  await title('Second native upload · 1 hour ago');
  await click('Later →');
  await entry('lmnopqrstuv', 'laterAt');
  await page.keyboard.press('ArrowDown');
  await check('end state explicitly covers loaded cards rather than the entire history', () => {
    const shadow = document.querySelector('#mvs-subscriptions-tools').shadowRoot;
    return !shadow.querySelector('.review-empty').hidden && shadow.querySelector('.scope').textContent.startsWith('0 loaded') && shadow.querySelector('.review-empty').textContent.includes('not your whole subscription history');
  });
  await page.evaluate(() => fixture.add('newvideo001', 'Lazy loaded upload', 'ytd-video-renderer'));
  await title('Lazy loaded upload');
  let box = await host.locator('.card').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 50;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 25, y, { steps: 3 }); await page.mouse.up();
  await entry('newvideo001', 'laterAt', false);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 130, y, { steps: 5 });
  await page.evaluate(() => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.card')
    .dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, isPrimary: true })));
  await page.mouse.up();
  await entry('newvideo001', 'laterAt', false);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 160, y, { steps: 8 }); await page.mouse.up();
  await entry('newvideo001', 'laterAt');
  await page.evaluate(() => {
    const card = document.querySelector('ytd-rich-item-renderer');
    card.querySelectorAll('a').forEach(link => link.href = '/watch?v=recycled001');
    card.querySelector('#video-title').textContent = 'Recycled renderer upload';
  });
  await check('recycled renderers lose stale hide markers', () => !document.querySelector('ytd-rich-item-renderer').hasAttribute('data-mvs-subscription-hidden'));
  await title('Recycled renderer upload');
  await page.evaluate(() => fixture.add('abcdefghijk', 'Original hidden video reinserted'));
  await check('late inserts of a hidden ID are filtered too', () => document.querySelector('#contents').lastElementChild.getAttribute('data-mvs-subscription-hidden') === 'abcdefghijk');
  await click('Hidden');
  const revision = await page.evaluate(() => fixture.saved.subscriptionsReviewV1.revision);
  await page.getByRole('searchbox').fill('First');
  await page.keyboard.press('ArrowLeft');
  if (await page.evaluate(() => fixture.saved.subscriptionsReviewV1.revision) !== revision) throw new Error('Typing consumed a decision shortcut');
  checks.push('typing in collection search does not hide a video');
  await click('Restore');
  await entry('abcdefghijk', 'hiddenAt', false);
  await click('Later');
  await check('Later contains snapshots independent of currently loaded cards', () => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelectorAll('.rows .row').length === 2);
  const watch = await host.locator('.row-actions a').first().getAttribute('href');
  if (!/^https:\/\/www.youtube.com\/watch\?v=/.test(watch)) throw new Error('Unsafe Watch URL');
  await click('Clear Later');
  await click('Confirm — click again');
  await check('clear Later does not hide its videos', () => Object.keys(fixture.saved.subscriptionsReviewV1.entries).length === 0);
  await click('Close subscription tools');
  await click('Review subscriptions');
  await title('Recycled renderer upload');
  await page.evaluate(() => { fixture.failWrites = true; });
  await click('← Hide');
  await check('failed persistence is visible and leaves the native card intact', () => document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.status').textContent.includes('not saved') && !document.querySelector('ytd-rich-item-renderer').hasAttribute('data-mvs-subscription-hidden'));
  await page.evaluate(() => { fixture.failWrites = false; });
  await click('← Hide');
  await entry('recycled001', 'hiddenAt');
  await page.evaluate(() => fixture.focus(true));
  await check('Focus activation closes review and hides all subscription tools', () => document.querySelector('#mvs-subscriptions-tools').hidden && !document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('dialog').open && document.documentElement.classList.contains('ytl-hide-feed-videos'));
  await page.getByRole('button', { name: 'Reveal YouTube feed (3 left)', exact: true }).click();
  await check('existing delayed Focus reveal cannot be bypassed by review', () => document.querySelector('#mvs-subscriptions-tools').hidden && !fixture.saved.ytListsFeedRevealUsage?.count);
  await page.evaluate(() => fixture.navigate('/watch?v=abcdefghijk'));
  await check('Focus allows the existing watch page while review remains absent', () => !document.documentElement.classList.contains('ytl-hide-feed-videos') && document.documentElement.dataset.mvsFeedFocusReady === 'true');
  const immediateGate = await page.evaluate(() => {
    fixture.navigate('/feed/subscriptions');
    return document.querySelector('#mvs-subscriptions-tools').hidden;
  });
  if (!immediateGate) throw new Error('Review exposed subscriptions before Focus reinitialized');
  checks.push('navigation from an allowed watch page waits for Focus before showing tools');
  await check('Focus remains enforced after returning from watch', () => document.documentElement.classList.contains('ytl-hide-feed-videos') && document.querySelector('#mvs-subscriptions-tools').hidden);
  await page.evaluate(() => fixture.focus(false));
  await check('tools return after Focus is disabled through its existing setting', () => !document.querySelector('#mvs-subscriptions-tools').hidden);
  await page.evaluate(() => fixture.navigate('/'));
  await check('leaving subscriptions removes feature visibility and native filtering', () => document.querySelector('#mvs-subscriptions-tools').hidden && !document.documentElement.classList.contains('mvs-subscriptions') && !document.querySelector('[data-mvs-subscription-hidden]'));
  await page.evaluate(() => fixture.navigate('/feed/subscriptions'));
  await entry('recycled001', 'hiddenAt');
  await check('returning through SPA navigation reapplies persistent hides', () => document.querySelector('[data-mvs-subscription-hidden="recycled001"]'));
  await page.reload();
  await check('reload retains saved decisions without importing YT Lists archives', () => fixture.saved.subscriptionsReviewV1.entries.recycled001.hiddenAt && fixture.saved.ytListsArchived.abcdefghijk === 123 && !fixture.saved.subscriptionsReviewV1.entries.abcdefghijk);
  await click('Review subscriptions');
  await page.evaluate(() => {
    const next = document.querySelector('ytd-browse').cloneNode(true);
    next.querySelector('#contents').replaceChildren(fixture.card('rootreplace', 'Replacement root upload', 'yt-lockup-view-model'));
    document.querySelector('ytd-browse').replaceWith(next);
  });
  await title('Replacement root upload');
  await page.evaluate(() => fixture.add('hostile0001', '<img src=x onerror=window.fixtureInjected=true>'));
  await click('↓ Skip');
  await title('<img src=x onerror=window.fixtureInjected=true>');
  await check('page metadata renders as text, without injected markup', () => !window.fixtureInjected && document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('.copy h2').childElementCount === 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  box = await dialog.boundingBox();
  if (box.x < 0 || box.x + box.width > 391) throw new Error('Dialog overflows compact viewport');
  await page.screenshot({ path: 'subscriptions-review-compact.png' });
  await page.keyboard.press('Tab');
  await check('native modal focus remains within the dialog at compact width', () => {
    const shadow = document.querySelector('#mvs-subscriptions-tools').shadowRoot;
    return shadow.querySelector('dialog').contains(shadow.activeElement);
  });
  await page.keyboard.press('Escape');
  await check('Escape exits review without changing queue or hidden state', () => !document.querySelector('#mvs-subscriptions-tools').shadowRoot.querySelector('dialog').open);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  return { passed: checks.length, checks, pageErrors: errors };
}
