import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(web, '..');
const out = path.join(web, 'dist');
// This folder contains generated output only. Vercel serves only this allowlist,
// never extension source, server credentials, SQL, or the repository root.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const shared = ['watch.css', 'watch.js', 'reader-core.js', 'reader-watch-core.js',
  'watch-timer-core.js', 'watch-timer.js', 'watch-location-menu.js',
  'watch-feedback.js', 'watch-search.js', 'watch-thumbnail.js'];
const hosted = ['client.js', 'cloud-actions.js', 'embeds.js', 'app.css', 'settings.html', 'settings.js'];
for (const name of shared) {
  if (name === 'watch-timer.js') {
    const timer = (await readFile(path.join(repo, name), 'utf8')).replace('We’ll remind you on YouTube when time is up.', 'Keep this page open for a reminder when time is up.');
    await writeFile(path.join(out, name), timer);
  } else await copyFile(path.join(repo, name), path.join(out, name));
}
for (const name of hosted) await copyFile(path.join(web, name), path.join(out, name));
let html = await readFile(path.join(repo, 'watch.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="watch.css">', '<meta name="referrer" content="strict-origin-when-cross-origin"><meta name="description" content="Your private saved video library, summaries, descriptions and notes."><link rel="stylesheet" href="watch.css"><link rel="stylesheet" href="app.css">')
  .replace('href="options.html#watch-timer-default-minutes"', 'href="settings.html#timer-default"')
  .replace('Default duration in Options', 'Default duration in Settings')
  .replace('<a class="yt-lists-link" href="feed.html">YT Lists</a>', '<a class="yt-lists-link" href="settings.html">Settings</a>')
  .replace('The extension cannot undo it.', 'This cannot be undone here.')
  .replace(/  <script src="watch-timer-core.js">[\s\S]*?<\/body>/, '  ' + [
    'watch-timer-core.js', 'reader-core.js', 'reader-watch-core.js', 'client.js',
    'watch-timer.js', 'watch-location-menu.js', 'watch-feedback.js', 'watch-search.js',
    'watch-thumbnail.js', 'cloud-actions.js', 'embeds.js', 'watch.js'
  ].map(name => `<script src="${name}"></script>`).join('') + '\n</body>');
if (html.includes('watch-card-actions.js') || html.includes('watch-timer-client.js')) throw new Error('Extension-only client leaked into hosted build');
await writeFile(path.join(out, 'index.html'), html);
console.log('Built Recent saves in web/dist (static assets only).');
