/* Offline toast preview using the production markup, CSS and feedback controller.
 * Generate: node tests/watch-toast-fixture.cjs output/toast-preview.html
 */
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
function html() {
  const markup = fs.readFileSync(path.join(root, 'watch.html'), 'utf8');
  const feedback = markup.match(/<aside class="feedback"[\s\S]*?<\/aside><p id="announcements"[\s\S]*?<\/p>/)?.[0];
  if (!feedback) throw new Error('Production notification markup not found');
  const css = fs.readFileSync(path.join(root, 'watch.css'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'watch-feedback.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
<title>Toast alignment · mock preview</title><style>${css}</style></head><body>
<main class="watch-app"><h1>Toast alignment</h1><p>Mock notifications only. No Reader connection or browser storage.</p>
<p><label>Theme <select id="theme"><option>system</option><option>light</option><option>dark</option></select></label></p>
<button id="single" type="button">Single line</button> <button id="wrapped" type="button">Wrapped message</button> <button id="error" type="button">Long error</button>
<p id="layout-anchor">The page stays in place when notifications appear or dismiss.</p></main>${feedback}
<script>${controller}</script><script>
const feedback = MVSWatchFeedback.create({routine: document.getElementById('toast'), error: document.getElementById('error-toast'), live: document.getElementById('announcements')});
const theme = document.getElementById('theme'), system = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() { document.documentElement.dataset.theme = theme.value === 'system' ? (system.matches ? 'dark' : 'light') : theme.value; }
theme.addEventListener('change', applyTheme); system.addEventListener('change', applyTheme); applyTheme();
document.getElementById('single').onclick = () => feedback.show('Moved to Shortlist.');
document.getElementById('wrapped').onclick = () => feedback.show('Reader could not confirm the location change. Refresh this video before trying again. Your note draft is kept.');
document.getElementById('error').onclick = () => feedback.show('Reader could not be reached. Your draft is kept. ' + 'LongErrorDetail'.repeat(100), true);
</script></body></html>`;
}
module.exports = { html };
if (require.main === module) {
  const target = path.resolve(process.argv[2] || path.join(root, 'output/toast-preview.html'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html()); process.stdout.write(target + '\n');
}
