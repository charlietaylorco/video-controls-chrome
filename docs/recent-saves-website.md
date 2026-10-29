# Watchlater on Sites

Watchlater uses ChatGPT Sites with managed ChatGPT sign-in and durable D1 storage.
Its registered origin is https://watchlater.chimping.chatgpt.site. The Site is
owner-private. The earlier Vercel/Supabase setup is superseded; no separate
Supabase account, database password or application login is needed.

## Source and publishing

The extension and website source remain in this GitHub repository and PR. The
standalone Sites app is under `watchlater/`. Run `npm run prepare:site` at the
repository root to copy the shared UI assets into its generated source. The
Sites starter owns compilation, auth integration and D1 migrations. Keep the
`sites()` Vite integration and `app/chatgpt-auth.ts` helpers intact.

`watchlater/.openai/hosting.json` records the registered Site ID and `DB` D1
binding. `watchlater/db/schema.ts` and committed Drizzle migrations define the
storage schema. Generate schema changes using the starter's `db:generate` script.
Never create or alter migration-owned tables in request handling.

Publish from a sanitized, separate checkout outside the GitHub repository. Include
`watchlater/` source and generated UI assets, and exclude node_modules, runtime
state, credentials, environment files and the parent repository's Git metadata.
The Sites source helper must push the exact source used to build the artifact;
publish its resulting SHA/archive with the native owner-private deployment tool.

## Durable records and privacy

D1 stores retained video metadata, descriptions, personal notes, Reader summaries,
location/tags and deletion markers. There is no 200-document cloud summary eviction.
Text fields are bounded at 64,000 characters; local cached excerpts remain labelled
until refreshed. Twelve-card pages return bounded previews, while opening the
text editor fetches the full record and revision. Exports retrieve all records in
bounded pages. Editorial conflicts preserve the in-tab draft.

All requests require the platform's authenticated visitor identity. Browser writes
also require the exact request Origin. The Site's owner-private platform policy is
the audience boundary; the app uses one owner partition. Keep the Site private.
This implementation does not expose service-bypass credentials or implement a
second OAuth/session stack. The reserved platform sign-in/out routes use ordinary
top-level navigation links.

## Extension migration and automatic sync

Reload the extension after updating it. On the signed-in website, open Settings
and generate a device token. In Extension Options → Recent saves website, connect
the exact Site origin and token, grant access only to that origin, then import
retained history. The extension keeps its local route until import completes.
Local history is retained, and disconnecting restores the local route.

A durable dirty marker is written atomically with each local history update.
The extension copies metadata in small idempotent batches, verifies the owner scope
and every acknowledged URL, and retains newer changes made during an upload.
Worker restarts resume an unfinished import; network failures use bounded backoff.
Old uploads cannot overwrite edited cloud text or restore an old deleted identity.
An explicit new Reader save can advance to a newer identity.

Private Sites require a normal browser session. Automatic sync opens a temporary,
inactive `/extension-sync` tab in the same browser as the extension. An isolated
content script on that exact origin performs same-origin requests using the
existing ChatGPT session and narrow device token. It never sends credentials to
page scripts or uses a platform service-bypass token. Only extension-created tabs
with the captured URL/document identity are closed. A sign-in redirect pauses sync
with an explicit sign-in message. Sign into Watchlater in the same browser before
resuming. Chrome documents content-script requests as made on behalf of the web
origin: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

For initial migration or recovery without pairing, export retained local history
from Extension Options, then select the JSON file in website Settings. Import
validates records before uploading and reports skipped deletion markers. It never
sends Reader deletion actions. Saved website records work independently once
imported. This imports retained extension history, not the entire Reader library.

## Descriptions and integrations

A save captures description text already rendered on an exactly matched YouTube
watch page (up to 20,000 characters). It makes no extra requests and cannot recover
text that YouTube has not rendered. Feed cards/embeds often have no description.
Website descriptions are editable separately from summaries. Website personal
notes are independent of Reader Document Notes.

Optional `READER_TOKEN` and `RAINDROP_TOKEN` server secrets can be configured in
Sites environment settings; they are never copied automatically from extension
storage. Browsing, importing, editing and exporting work without them. Reader
refresh/moves/deletion require its token. Moves update only location and verify
the result. Deletion uses a single-use expiring snapshot, rechecks the exact source,
identity, title, Document Note and update time, requires HTTP 204 and verifies
absence. Destructive requests never retry automatically. Hosted Reader operations
share a persisted rate budget and 429 cooldown. Other Reader clients still share
the upstream token quota.

Embeds load on click from YouTube's privacy-enhanced domain with a real HTTPS
referrer. One player remains active; ordinary YouTube links remain available.
Restricted or embedding-disabled videos may not play. The website timer stores a
cloud deadline and reminds while the page is open; the extension's existing
YouTube reminders remain a separate timer. Downie is a user-initiated protocol
handoff, not proof of a completed download.

## Verification and recovery

Follow the SSD preflight before installs, builds or tests. Run `npm test` and
`npm run prepare:site`, then the Sites build helper against `watchlater/`.
The server tests exercise actual SQLite with the generated D1 migration, API
identity/conflict guards, device scope, concurrent quotas and editorial changes.
Use the portable starter's local mock ChatGPT sign-in for local browser testing;
it is excluded from production. Local and hosted D1 databases are separate.

Settings exports records to JSON, including descriptions, notes, summaries and
markers. Keep an independent export before account/project changes. Publication
provisions and migrates hosted D1. Real Chrome permission prompts, session-based
sync and platform sign-in should be verified in the browser carrying the extension.
