// Generate a Playwright CLI setup snippet. It intercepts *every* request; no account/network is used.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright');
fs.mkdirSync(output, { recursive: true });
const assets = Object.fromEntries(['subscriptions-state.js', 'subscriptions-content.js', 'subscriptions.css', 'yt-lists-content.js']
  .map(file => [`/__fixture/${file}`, { body: fs.readFileSync(path.join(root, file), 'utf8'), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' }]));
assets['/feed/subscriptions'] = { body: fs.readFileSync(path.join(__dirname, 'subscriptions-browser-fixture.html'), 'utf8'), contentType: 'text/html' };
fs.writeFileSync(path.join(output, 'subscriptions-setup.js'), `async (page) => {
  const assets = ${JSON.stringify(assets)};
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = url.hostname === 'www.youtube.com' && assets[url.pathname];
    if (asset) await route.fulfill(asset);
    else if (url.hostname === 'i.ytimg.com') await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#c8d4c3"/><circle cx="320" cy="180" r="90" fill="#617d66"/><path d="M300 130 370 180 300 230Z" fill="#f8f7f3"/></svg>' });
    else await route.fulfill({ status: 404, body: 'Fixture blocked external request' });
  });
  await page.goto('https://www.youtube.com/feed/subscriptions');
  await page.getByRole('button', { name: 'Review subscriptions', exact: true }).waitFor();
}`);
console.log(path.join(output, 'subscriptions-setup.js'));
