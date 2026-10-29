/* OFFLINE, FAKE-DATA UI FIXTURE. No credentials or external API calls. */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const T = require('../watch-timer-core.js');
const root = path.resolve(__dirname, '../web/dist');
const port = Number(process.argv[2] || 8768);
const preferences = { theme: 'system', timerDefault: 15 };
const records = Array.from({ length: 14 }, (_, i) => ({
  videoUrl: `https://www.youtube.com/watch?v=mock_${String(i).padStart(6, '0')}`, readerId: `fixture-reader-${i}`,
  title: ['Making room for better work', 'The quiet craft of attention', 'A long conversation about ideas', 'How we learn to see'][i % 4] + ` · Demo ${i + 1}`,
  author: ['Studio Notes', 'The Learning Room', 'Studio Notes', 'Weekend Journal'][i % 4],
  summary: i === 2 ? '' : `FAKE PREVIEW DATA. A useful idea from this conversation: focus grows through small deliberate choices.\n\nThis mock summary tests reading, search and the established card layout. Video ${i + 1} explores attention, design and everyday practice.`,
  summaryTruncated: false, description: i === 0 ? 'FAKE DESCRIPTION. A thoughtful discussion about making space for meaningful work, with ideas to try this week.' : '',
  notes: i === 0 ? 'My fake personal note: revisit the opening example.' : '', tags: i % 3 === 0 ? ['Design', 'Long conversations'] : i % 3 === 1 ? ['Focus'] : [],
  location: i === 12 ? 'archive' : i === 13 ? 'shortlist' : 'later', status: 'saved', durationSeconds: i === 2 ? null : 970 + i * 211,
  durationIsLive: false, savedAt: Date.now() - i * 3600000, firstSavedAt: Date.now() - i * 3600000,
  checkedAt: Date.now() - 60000, revision: 1,
}));
let timer = T.idle();
const tickets = new Map();
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const cookie = req => /(?:^|;\s*)fixtureAuth=off(?:;|$)/.test(req.headers.cookie || '');
const respond = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); res.end(JSON.stringify(data)); };
const page = (message, exporting = false) => {
  let rows = records.filter(row => exporting || row.status !== 'deleted');
  if (!exporting) {
    if (message.filter === 'watch' || !message.filter) rows = rows.filter(row => row.status !== 'missing' && !['archive', 'feed'].includes(row.location));
    else if (message.filter !== 'all') rows = rows.filter(row => row.location === message.filter);
    const terms = normalize(message.query).split(' ').filter(Boolean);
    rows = rows.filter(row => (!message.channel || normalize(row.author) === normalize(message.channel)) && (!message.tag || row.tags.some(tag => normalize(tag) === normalize(message.tag))) && terms.every(term => normalize([row.title, row.author, row.summary, row.description, row.notes, ...row.tags].join(' ')).includes(term)));
  }
  rows.sort((a, b) => b.savedAt - a.savedAt || b.videoUrl.localeCompare(a.videoUrl));
  if (message.cursor) rows = rows.filter(row => row.savedAt < message.cursor[0] || row.savedAt === message.cursor[0] && row.videoUrl < message.cursor[1]);
  const size = exporting ? 4 : 12, fullItems = rows.slice(0, size), hasNext = rows.length > size;
  const items = exporting ? fullItems : fullItems.map(row => ({ ...row, summary: row.summary.slice(0, 32768), description: undefined, notes: undefined, contentPartial: true }));
  return { ok: true, items, hasNext, nextCursor: hasNext ? [items.at(-1).savedAt, items.at(-1).videoUrl] : null };
};
const api = async (req, res, url) => {
  if (req.method === 'GET') return respond(res, { ok: true, configured: true, authenticated: !cookie(req), ...preferences, raindropEnabled: true, fixture: true });
  let body = ''; for await (const part of req) { body += part; if (body.length > 1024 * 1024) return respond(res, { ok: false, code: 'invalid_request' }, 400); }
  const message = JSON.parse(body || '{}');
  if (message.type === 'auth-login') { res.setHeader('Set-Cookie', 'fixtureAuth=on; Path=/; SameSite=Lax'); return respond(res, { ok: true }); }
  if (message.type === 'auth-logout') { res.setHeader('Set-Cookie', 'fixtureAuth=off; Path=/; SameSite=Lax'); return respond(res, { ok: true }); }
  if (cookie(req)) return respond(res, { ok: false, code: 'unauthorized' }, 401);
  if (message.type === 'watch-list-page') return respond(res, page(message));
  if (message.type === 'cloud-export') return respond(res, page(message, true));
  if (message.type === 'cloud-settings') { Object.assign(preferences, { theme: message.theme, timerDefault: message.timerDefault }); return respond(res, { ok: true, ...preferences, raindropEnabled: true }); }
  if (message.type === 'cloud-pair') return respond(res, { ok: true, token: 'FAKE-DEVICE-TOKEN-FOR-PREVIEW-ONLY', origin: `http://127.0.0.1:${port}` });
  if (message.type === 'cloud-revoke') return respond(res, { ok: true });
  if (message.type === 'watch-card-action') return respond(res, { ok: true, saved: true });
  if (message.type === 'viewing-timer') {
    timer = T.project(timer, Date.now());
    if (message.action === 'start') timer = { phase: 'running', id: crypto.randomUUID(), revision: timer.revision + 1, durationMinutes: message.minutes, deadline: Date.now() + message.minutes * 60000, remainingMs: 0, dismissed: false };
    else if (!['get', 'expire'].includes(message.action) && (message.id !== timer.id || message.revision !== timer.revision)) return respond(res, { ok: false, code: 'timer_changed', state: timer, defaultMinutes: preferences.timerDefault });
    else if (message.action === 'pause' && timer.phase === 'running') timer = { ...timer, phase: 'paused', remainingMs: T.remaining(timer, Date.now()), deadline: null, revision: timer.revision + 1 };
    else if (message.action === 'resume' && timer.phase === 'paused') timer = { ...timer, phase: 'running', deadline: Date.now() + timer.remainingMs, revision: timer.revision + 1 };
    else if (message.action === 'reset') timer = { ...T.idle(), revision: timer.revision + 1 };
    else if (message.action === 'dismiss') timer = { ...timer, dismissed: true, revision: timer.revision + 1 };
    return respond(res, { ok: true, state: timer, defaultMinutes: preferences.timerDefault });
  }
  const row = records.find(record => record.videoUrl === message.videoUrl);
  if (message.type === 'watch-list-delete') {
    const target = tickets.get(message.token); tickets.delete(message.token);
    if (!target || message.confirmed !== true) return respond(res, { ok: false, code: 'confirmation_expired' });
    target.status = 'deleted'; target.revision++; return respond(res, { ok: true });
  }
  if (!row) return respond(res, { ok: false, code: 'not_found' });
  if (message.type === 'cloud-item') return respond(res, { ok: true, item: row });
  if (message.type === 'cloud-edit') {
    if (message.revision !== row.revision) return respond(res, { ok: false, code: 'document_changed', item: row });
    Object.assign(row, { description: message.description, notes: message.notes, revision: row.revision + 1 }); return respond(res, { ok: true, item: row });
  }
  if (message.type === 'watch-list-refresh') { row.checkedAt = Date.now(); return respond(res, { ok: true, item: row }); }
  if (message.type === 'watch-list-move') { if (message.baseLocation !== row.location) return respond(res, { ok: false, code: 'document_changed' }); row.location = message.location; row.revision++; return respond(res, { ok: true, item: row }); }
  if (message.type === 'watch-list-prepare-delete') { const token = crypto.randomUUID(); tickets.set(token, row); return respond(res, { ok: true, token, id: row.readerId, title: row.title, videoUrl: row.videoUrl }); }
  return respond(res, { ok: false, code: 'invalid_request' }, 400);
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.searchParams.has('auth')) { res.writeHead(303, { Location: url.pathname, 'Set-Cookie': `fixtureAuth=${url.searchParams.get('auth') === 'off' ? 'off' : 'on'}; Path=/; SameSite=Lax` }); return res.end(); }
    if (url.pathname === '/api/recent-saves') return await api(req, res, url);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    const content = await fs.readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); res.end(content);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Fake fixture unavailable'); }
}).listen(port, '127.0.0.1', () => console.log(`FAKE DATA ONLY: http://127.0.0.1:${port} (no real accounts or API calls)`));
