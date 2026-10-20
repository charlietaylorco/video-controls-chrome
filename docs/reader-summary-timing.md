# New-save summary timing

## Causal findings

Before this change, `background.js` POSTed to Reader's save endpoint, retained the ID/flags, and recorded local history. It never requested a summary after saving. `reader-card-preview.js`, `reader-peek.js`, and `reader-panel.js` requested the document on first open/hover without checking save age. Empty results were cached in individual hover controllers for 15 seconds. There was no timer that retried an empty summary or refreshed a still-open hover. `watch.js` loaded IndexedDB history; Reader reads happened only through explicit per-card/page refresh. A manual refresh was therefore needed to populate the new card's summary.

These findings come from tracing the actual production routes and synthetic transport tests. No authenticated Reader save/delete or live Reader inspection was performed.

## Implementation

- `reader-summary-service.js` wraps the existing authenticated Reader service. HTTP 201 saves register a job before publishing saved flags. HTTP 200 existing saves, ready memory content, and matching ready IndexedDB summaries bypass registration.
- First check: save success +15 seconds. Empty/transient failures use +15/+30/+60/+120-second backoff (nominal checks at +15/+30/+60/+120/+240 seconds). At most five attempts and five minutes from the original save. Reopen, hover, and repeated notifications cannot restart the budget. Up to 200 job metadata entries are retained.
- One shared scheduler runs one request at a time; simultaneously due jobs are spaced by at least 3.5 seconds. Existing persisted API budgets and Reader `Retry-After` remain authoritative. Authentication/storage failures stop automatic work. Error codes remain distinct from a successful empty summary.
- Attempts/deadlines are persisted before requests. An awake worker uses a timer; a named one-shot Chrome alarm covers suspension. A late wake checks the original horizon and does not start a fresh five-minute poll. Worker startup and visible reads resume retained work. A killed in-flight attempt is consumed, preventing repeated immediate requests.
- Automatic ID checks retain successful-save markers if Reader has not indexed the document yet. ID-less saves use the existing bounded discovery path (one page per minute); there is no library sweep.
- Ready document replies are shared in memory for up to one minute across panel/card/Watch surfaces, with per-consumer identity checks. Full notes/credentials are never persisted in job metadata or sent to Recent saves. IndexedDB continues to hold its existing bounded summary cache. Explicit Refresh bypasses the ready memory cache; it respects pending new-save delay/backoff. Note/location/delete actions invalidate document replies so a cached note cannot undo a later edit.
- Job changes notify visible card/launcher hovers and open panels. Only readiness causes a new shared read; pending/error/finished states update text without per-surface polling. Recent saves rereads local history on job/cache notifications. Note drafts/tab selection stay intact. Navigation, replaced/deleted documents, and token changes reject stale work.

## Validation

`npm test`: fake clock, mock HTTP, mock Chrome messaging/storage/alarms, DOM controllers, and fake IndexedDB. New cases cover 14,999/15,000ms boundaries; repeated hover/panel/Watch requests; successful delayed summary; empty/missing documents; bounded retries; 429 cooldown; API/network/auth failures; suspension/reopen/expired jobs; concurrent saves; shared requests with a navigated first or second consumer; stale replacements; 201 versus 200/failed saves; explicit refresh; note cache invalidation; automatic hover/panel/Recent saves updates; and retained dirty notes. Existing playback, save, deletion, tags/search and shortcut regressions also run.

No browser tabs or the extension were reloaded. Real Reader generation timing and live YouTube layout remain untested. To try the updated preview, first copy any unsaved Reader note drafts, reload only this extension in Arc's extensions page, then reload the YouTube/Recent saves tabs you choose to test. The code update alone does not refresh already-injected scripts.
