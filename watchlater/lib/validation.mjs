
const canonical = value => {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(u.hostname)) {
      id = u.pathname.match(/^\/([\w-]{1,100})\/?$/)?.[1];
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname)) {
      id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{1,100})\/?$/)?.[1];
    }
    return /^[\w-]{1,100}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
};
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const normalize = value => text(value, 64000).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const validCursor = value => value == null || Array.isArray(value) && value.length === 2 && timestamp(value[0]) && canonical(value[1]) === value[1];
const tags = value => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()).slice(0, 100).map(x => x.slice(0, 200)) : [];

function importedItem(value, now) {
  if (!value || typeof value !== 'object' || canonical(value.videoUrl) !== value.videoUrl || !timestamp(value.savedAt) || value.savedAt > now + 300000) return null;
  if (value.readerId != null && !validId(value.readerId)) return null;
  if (!['saved', 'deleted', 'missing'].includes(value.status || 'saved')) return null;
  const checkedAt = timestamp(value.checkedAt) && value.checkedAt <= now + 300000 ? value.checkedAt : 0;
  const updatedAt = timestamp(value.updatedAt) && value.updatedAt <= now + 300000 ? value.updatedAt : Math.max(value.savedAt, checkedAt);
  return {
    videoUrl: value.videoUrl, readerId: value.readerId || null, savedAt: value.savedAt,
    firstSavedAt: timestamp(value.firstSavedAt) ? Math.min(value.firstSavedAt, value.savedAt) : value.savedAt,
    title: text(value.title, 500), author: text(value.author, 300), location: text(value.location, 100), tags: tags(value.tags),
    status: value.status || 'saved', checkedAt, updatedAt, provenance: text(value.provenance, 100) || 'extension',
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 64000) : null,
    summaryCheckedAt: timestamp(value.summaryCheckedAt) && value.summaryCheckedAt <= now + 300000 ? value.summaryCheckedAt : checkedAt,
    summaryTruncated: value.summaryTruncated === true || typeof value.summary === 'string' && value.summary.length > 64000,
    durationSeconds: value.durationIsLive === true ? null : Number.isFinite(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds < 31536000 ? Math.round(value.durationSeconds) : null,
    durationIsLive: value.durationIsLive === true,
    description: text(value.description, 64000), notes: text(value.notes, 64000)
  };
}

function cleanDocument(doc, videoUrl, id) {
  if (!doc || doc.id !== id || !validId(doc.id) || doc.is_deleted || doc.parent_id || canonical(doc.source_url) !== videoUrl) return null;
  const rawTags = Array.isArray(doc.tags) ? doc.tags : Object.entries(doc.tags || {}).map(([key, tag]) => typeof tag?.name === 'string' ? tag.name : key);
  return {
    id, videoUrl, title: text(doc.title, 500), author: text(doc.author, 300), location: text(doc.location, 100),
    summary: text(doc.summary, 64000), summaryTruncated: typeof doc.summary === 'string' && doc.summary.length > 64000,
    tags: doc.tags && typeof doc.tags === 'object' ? tags(rawTags) : null, readerTitle: typeof doc.title === 'string' ? doc.title : '',
    readerNotes: typeof doc.notes === 'string' ? doc.notes : '', updatedAt: text(doc.updated_at, 100)
  };
}

export { canonical, validId, text, normalize, timestamp, validCursor, tags, importedItem, cleanDocument };
