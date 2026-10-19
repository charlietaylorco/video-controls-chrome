/* Optional browser layout regressions; mock notifications, no Reader/network.
 * Run: node --test tests/watch-toast.browser.cjs (requires Playwright + Chromium).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { html } = require('./watch-toast-fixture.cjs');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); });
after(async () => { await browser?.close(); });
async function fixture(width) {
  const context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage(); await page.setContent(html());
  return { page, close: () => context.close() };
}
async function geometry(page, id) {
  return page.locator(id).evaluate(box => {
    const p = box.querySelector('p'), button = box.querySelector('button'), icon = button.querySelector('svg');
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
    const style = getComputedStyle(box);
    return { box: rect(box), p: rect(p), button: rect(button), icon: rect(icon),
      scrollWidth: p.scrollWidth, scrollHeight: p.scrollHeight, clientWidth: p.clientWidth, clientHeight: p.clientHeight,
      bg: style.backgroundColor, fg: style.color };
  });
}
function aligned(g, width) {
  assert.ok(Math.abs(g.p.cy - g.button.cy) < 1, 'message block and close button share a vertical center');
  assert.ok(Math.abs(g.icon.cx - g.button.cx) < 1 && Math.abs(g.icon.cy - g.button.cy) < 1, 'X is centered in the hit target');
  assert.ok(g.button.width >= 24 && g.button.height >= 24);
  assert.ok(g.p.x + g.p.width <= g.button.x - 15, 'message never overlaps the close target');
  assert.ok(g.box.x >= 0 && g.box.x + g.box.width <= width && g.box.width <= 380);
  assert.ok(g.scrollWidth <= g.clientWidth + 1, 'long words wrap without horizontal scrolling');
}
test('single-line, wrapped and scroll-limited toasts center text/X without shifting the page in every theme', async () => {
  for (const width of [320, 1100]) {
    const f = await fixture(width), { page } = f;
    const anchor = await page.locator('#layout-anchor').boundingBox();
    for (const [theme, scheme, resolved] of [['light', 'dark', 'light'], ['dark', 'light', 'dark'], ['system', 'light', 'light'], ['system', 'dark', 'dark']]) {
      await page.emulateMedia({ colorScheme: scheme }); await page.selectOption('#theme', theme);
      assert.equal(await page.locator('html').getAttribute('data-theme'), resolved);
      await page.click('#single'); const single = await geometry(page, '#toast'); aligned(single, width);
      assert.ok(single.p.height < 24); assert.equal(single.box.height, 54, 'single-line toast retains its compact height');
      await page.click('#wrapped'); const wrapped = await geometry(page, '#toast'); aligned(wrapped, width);
      assert.ok(wrapped.p.height > 24);
      await page.click('#error'); const error = await geometry(page, '#error-toast'); aligned(error, width);
      assert.ok(error.scrollHeight > error.clientHeight && error.p.height <= 700 * .35 + 1);
      assert.notEqual(error.bg, error.fg); assert.deepEqual(await page.locator('#layout-anchor').boundingBox(), anchor);
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      assert.deepEqual(await page.locator('#layout-anchor').boundingBox(), anchor);
    }
    await f.close();
  }
});
test('dismiss buttons retain labels, keyboard activation, visible focus and return focus to the origin', async () => {
  const f = await fixture(320), { page } = f;
  for (const [origin, dismiss, box] of [['Single line', 'Dismiss notification', '#toast'], ['Long error', 'Dismiss error', '#error-toast']]) {
    await page.getByRole('button', { name: origin, exact: true }).click();
    const close = page.getByRole('button', { name: dismiss, exact: true });
    for (let steps = 0; steps < 4 && !(await close.evaluate(el => el === document.activeElement)); steps++) await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(el => el === document.activeElement), true);
    assert.equal(await close.locator('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(await close.locator('svg').getAttribute('focusable'), 'false');
    assert.equal(await close.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await page.keyboard.press('Enter'); assert.equal(await page.locator(box).isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), origin);
  }
  await f.close();
});
