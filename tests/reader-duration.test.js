const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const C = require('../reader-core.js');
const A = 'https://www.youtube.com/watch?v=alpha', B = 'https://www.youtube.com/watch?v=beta';
function fixture() {
  let id = 'alpha', live = false;
  const events = {}, classes = new Set();
  const player = { classList: { contains: name => classes.has(name) }, querySelectorAll: () => [video] };
  const video = { isConnected: true, currentSrc: 'blob:alpha', readyState: 4, duration: 65.2, closest: () => player };
  const host = { getAttribute: () => id };
  const location = { href: A };
  const document = { querySelector: selector => selector === '#movie_player' ? player : selector === 'ytd-watch-flexy[is-live]' ? live ? host : null : host,
    querySelectorAll: selector => selector === '#movie_player video' ? [video] : [], addEventListener: (type, fn) => { events[type] = fn; } };
  const context = vm.createContext({ MVSReaderCore: C, URL, location, document, window: { addEventListener: (type, fn) => { events[type] = fn; } } });
  vm.runInContext(fs.readFileSync(require.resolve('../reader-duration.js'), 'utf8'), context);
  let links = [A], badgeText = '1:05', badgeStyle = '';
  const card = { isConnected: true, querySelectorAll: selector => selector === 'a[href]' ? links.map(href => ({ href })) : [{ textContent: badgeText, getAttribute: () => badgeStyle }] };
  return { C: context.MVSReaderDuration, classes, video, card, location,
    capture: (value = A, isCard = false) => context.MVSReaderDuration.capture({ source: isCard ? card : video, videoUrl: value, card: isCard }),
    navigate(url, videoId) { location.href = url; id = videoId; }, event(type) { events[type]?.({ target: video }); },
    live(value) { live = value; }, badge(text, style = '') { badgeText = text; badgeStyle = style; }, links(value) { links = value; } };
}
test('finite positive durations format seconds, minutes and hours, with no unknown/invalid badge', () => {
  for (const [value, text] of [[1, '0:01'],[59,'0:59'],[60,'1:00'],[65.2,'1:05'],[3599,'59:59'],[3600,'1:00:00'],[3661,'1:01:01'],[86400,'24:00:00']]) assert.equal(C.formatVideoDuration(value), text);
  for (const value of [null,undefined,'65',0,-1,NaN,Infinity,-Infinity,Number.MAX_VALUE]) { assert.equal(C.durationSeconds(value), null); assert.equal(C.formatVideoDuration(value), ''); }
});
test('card badges capture only the exact video; preview media durations never supply card lengths', () => {
  const f = fixture(); f.video.duration = 15; assert.equal(f.capture(A, true).durationSeconds, 65);
  f.badge('1:02:03'); assert.equal(f.capture(A, true).durationSeconds, 3723);
  f.links([B]); assert.equal(f.capture(A, true).durationSeconds, undefined);
  f.links([A,B]); assert.equal(f.capture(A, true).durationSeconds, undefined);
  f.links([A]); f.badge(''); assert.equal(f.capture(A, true).durationSeconds, undefined);
  for (const badge of ['LIVE','Upcoming','Premiere']) { f.badge(badge); assert.equal(f.capture(A, true).durationIsLive, true); }
  for (const badge of ['1:60','1:02:60','foo','0:00']) assert.equal(f.C.parse(badge), null);
});
test('native watch duration is tied to loaded metadata, page video ID and media source across SPA navigation', () => {
  const f = fixture(); assert.equal(f.capture().durationSeconds, 65);
  f.navigate(B,'alpha'); assert.equal(f.capture(B).durationSeconds, undefined);
  f.navigate(B,'beta'); assert.equal(f.capture(B).durationSeconds, undefined);
  f.video.currentSrc = 'blob:beta'; f.video.duration = 3661;
  assert.equal(f.capture(B).durationSeconds, undefined); f.event('loadedmetadata'); assert.equal(f.capture(B).durationSeconds, 3661);
  assert.equal(f.capture(A).durationSeconds, undefined);
  f.event('yt-navigate-start'); assert.equal(f.capture(B).durationSeconds, undefined);
  f.event('loadedmetadata'); f.event('popstate'); assert.equal(f.capture(B).durationSeconds, undefined);
});
test('live/DVR, ads, unavailable metadata and disconnected/recycled targets do not invent runtime', () => {
  const f = fixture(); f.live(true); assert.equal(f.capture().durationIsLive, true); assert.equal(f.capture().durationSeconds, undefined);
  f.live(false); f.classes.add('ad-showing'); assert.equal(f.capture().durationSeconds, undefined); f.event('loadedmetadata'); f.classes.clear();
  assert.equal(f.capture().durationSeconds, undefined); f.event('loadedmetadata'); assert.equal(f.capture().durationSeconds, 65);
  for (const value of [0, NaN, Infinity]) { f.video.duration = value; assert.equal(f.capture().durationSeconds, undefined); }
  f.video.duration = 80; f.video.readyState = 0; assert.equal(f.capture().durationSeconds, undefined);
  f.video.readyState = 4; f.video.isConnected = false; assert.equal(f.capture().durationSeconds, undefined);
});
test('content and YT Lists send the captured source URL with duration, without changing Reader API fields', () => {
  const content = fs.readFileSync(require.resolve('../content.js'), 'utf8'), feed = fs.readFileSync(require.resolve('../feed.js'),'utf8');
  assert.match(content, /MVSReaderDuration\?\.capture\(\{ source: getVideoCardContainer\(source\) \|\| source, videoUrl: pageUrl/);
  assert.match(feed, /durationVideoUrl: item.link,\s+durationSeconds: item.durationSeconds/);
});
