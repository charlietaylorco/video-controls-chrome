/* Small, credential-free history rules shared by the worker and Watch list. */
(() => {
  const C = globalThis.MVSReaderCore;
  const PAGE_SIZE = 12, CACHE_SIZE = 200, SUMMARY_LIMIT = 64000;
  const filters = Object.freeze({ watch: 'To watch', later: 'Later', shortlist: 'Shortlist', archive: 'Archive', all: 'All saves' });
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const tags = value => Array.isArray(value) ? value.filter(tag => typeof tag === 'string' && tag.trim()).slice(0, 100).map(tag => text(tag, 200)) : [];
  const decorate = row => ({ ...row, active: row.status === 'deleted' ? 0 : 1,
    queue: !['deleted', 'missing'].includes(row.status) && !['archive', 'feed'].includes(row.location) ? 1 : 0,
    filterLocation: row.status === 'saved' ? row.location : '' });
  const seeds = ({ readerSavedUrls = {}, readerDocuments = {}, readerDeletedVideos = {} }) => {
    const rows = new Map();
    for (const [value, at] of Object.entries(readerSavedUrls || {})) {
      const videoUrl = C.canonical(value), savedAt = Number(at);
      if (!videoUrl || !Number.isFinite(savedAt) || savedAt <= 0) continue;
      const previous = rows.get(videoUrl);
      if (previous && previous.savedAt >= savedAt) continue;
      const mapped = readerDocuments?.[videoUrl], deleted = readerDeletedVideos?.[videoUrl];
      const replacement = C.validId(mapped?.id) && mapped.id !== deleted?.id && mapped.at >= (deleted?.at || 0);
      rows.set(videoUrl, decorate({ videoUrl, readerId: C.validId(mapped?.id) ? mapped.id : null,
        savedAt, firstSavedAt: previous?.firstSavedAt || savedAt, title: '', author: '', location: '', checkedAt: 0,
        status: C.validId(deleted?.id) && !replacement ? 'deleted' : 'saved', provenance: 'retained' }));
    }
    return [...rows.values()];
  };
  const indexFor = filter => filter === 'watch' ? ['queueRecent', 1] : filter === 'all' ? ['activeRecent', 1]
    : Object.hasOwn(filters, filter) ? ['locationRecent', filter] : null;
  const cursor = row => [row.savedAt, row.videoUrl];
  const validCursor = value => value == null || Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && value[0] > 0 && C.canonical(value[1]) === value[1];
  const api = { PAGE_SIZE, CACHE_SIZE, SUMMARY_LIMIT, filters, text, tags, decorate, seeds, indexFor, cursor, validCursor };
  globalThis.MVSReaderWatchCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
