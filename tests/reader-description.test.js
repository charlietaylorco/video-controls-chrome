const test = require('node:test');
const assert = require('node:assert/strict');
require('../reader-core.js');
const { capture } = require('../reader-description.js');
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const fixture = (id = 'abcdefghijk', text = '  A description <script> is plain text.  ') => ({ querySelector: () => ({ getAttribute: () => id, hasAttribute: () => false, querySelector: () => ({ textContent: text }) }) });
test('description is captured only when URL and mounted watch identity match', () => {
 assert.deepEqual(capture({ videoUrl: url, location: { href: url + '&t=30' }, document: fixture() }), { description: 'A description <script> is plain text.', descriptionVideoUrl: url });
 assert.deepEqual(capture({ videoUrl: url, location: { href: url }, document: fixture('previous-id') }), {});
 assert.deepEqual(capture({ videoUrl: url, location: { href: 'https://www.youtube.com/watch?v=different' }, document: fixture() }), {});
 assert.deepEqual(capture({ videoUrl: url, location: { href: url }, document: { querySelector: () => null } }), {});
});
test('description capture remains bounded and ignores absent text', () => {
 assert.equal(capture({ videoUrl: url, location: { href: url }, document: fixture('abcdefghijk', 'x'.repeat(30000)) }).description.length, 20000);
 assert.deepEqual(capture({ videoUrl: url, location: { href: url }, document: fixture('abcdefghijk', '   ') }), {});
});
