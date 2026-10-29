# Hosted Recent saves

Recent saves can run as a private website on Vercel Hobby with Supabase Free.
The extension remains the video capture surface; the website reads its own durable
cloud records and works without the extension after import. No frontend framework
or new production dependency is required.

## Free-tier design

As checked on 29 October 2026, Vercel Hobby is for personal, non-commercial use.
Supabase Free includes a 500 MB Postgres database, 5 GB egress, authentication,
and up to two active projects. It pauses after a week of inactivity and does not
include automatic backups or database preview branches. The implementation uses
neither paid branching nor paid scheduled jobs. Video playback and thumbnails load
from YouTube; video files are not stored in the database or proxied through Vercel.

- [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase backups](https://supabase.com/docs/guides/platform/backups)

Descriptions, personal notes, Reader summaries and retained history live in
Postgres. Text fields have explicit size bounds (64,000 characters for cloud
text); there is no 200-document cloud summary eviction. Existing locally truncated
summaries remain labelled as excerpts until refreshed. Search includes durable
metadata, descriptions, personal notes and available summaries.

## Provisioning

1. Create a **Free** Supabase project. Run `web/supabase/schema.sql` once in its SQL
   editor. For subsequent schema changes, append migrations rather than rerunning
   this initial schema.
2. In Supabase Authentication, disable public signup and create the sole allowed
   user with an email and a strong password. Record its UUID. The application uses
   Supabase password sign-in with server-managed HttpOnly cookies. It does not
   require SMTP or an additional OAuth application. Password recovery is handled
   through the Supabase dashboard; no public signup/reset endpoints are exposed.
3. Create a **Hobby** Vercel project from this repository. Keep the project root at
   the repository root. `vercel.json` runs `node web/scripts/build.mjs` and serves
   only `web/dist`; `api/recent-saves.js` is the server entry point.
4. Configure server environment variables from `web/.env.example` in Vercel:
   `APP_ORIGIN` (the exact canonical HTTPS origin), `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_USER_ID`,
   and optional `READER_TOKEN` / `RAINDROP_TOKEN` for integration actions. The existing extension tokens are
   never silently uploaded. No secrets belong in source, static files or a PR.
5. Deploy, sign in, and check Settings. Never point a preview deployment at live
   Reader credentials or production data. Free-tier previews can use a second
   isolated Supabase project; mocked/local checks need no hosted project. Set
   `APP_ORIGIN` separately for any preview that needs authenticated operations.
6. In website Settings, generate an extension device token. In Extension Options
   under Recent saves website, paste the exact origin and token,
   connect, then import retained history. Grant only that website origin when
   Chrome asks. Verify the import completes before relying on the hosted route.

The normal page and every API operation authorize the sole allowed account on
the server. The service-role key is server-only; table and RPC permissions are
revoked for anonymous/authenticated browser database clients, with RLS enabled as
an additional boundary. Browser writes require the exact configured Origin.
Device tokens are random, stored hashed server-side, expire after 90 days and can
be revoked in website Settings. They permit metadata import/status only (plus
restricted timer reads), never Reader deletion or arbitrary server API access.

## Migration and ongoing capture

Migration streams all retained IndexedDB history in bounded batches, including
missing/deleted markers and available summary excerpts. It verifies the owner
scope and acknowledged URLs. Repeating a failed import is safe. No local data is
deleted. Only after a verified complete import do extension Recent saves entry
points open the website. Disconnecting restores the extension route.

Every local history mutation records a dirty marker in the same IndexedDB
transaction. Background sync uploads dirty records in bounded batches, acknowledges
only the captured versions, and retries idempotent metadata uploads with backoff.
Failures remain visible in Options. Account/token changes invalidate an in-flight
sync. The website protects its own edits and newer Reader state from stale imports.

The import contains only retained extension history. It never imports the whole
Reader library or reconstructs previously discarded saves. Reader refresh still
uses exact retained document IDs. An offline or older browser cannot restore a
cloud tombstone with its old Reader identity.

Where the current YouTube watch URL and mounted player identity agree, saving
captures text already present in the visible description component (up to 20,000
characters). It makes no additional requests and cannot promise the full original
description when YouTube has not rendered it. Cards on feeds/embeds usually have no
description to capture. Descriptions can be edited in the website independently
of Reader summaries. Website personal notes are independent of Reader Document
Notes; editing one does not overwrite the other.

## Reader actions, playback and timer

Reader refresh/moves/deletion run on the server. Moves PATCH only location and
read back the result. Deletion uses an expiring single-use snapshot, rechecks
identity/title/Reader note/update time, requires HTTP 204, and verifies absence.
No destructive operation is automatically retried. Hosted operations share a
persisted rate budget and respect Reader 429 cooldowns. Existing extension Reader
panels still have their own budget; all clients share Reader's upstream quota.

Embeds load on click from YouTube's privacy-enhanced domain with a real HTTPS
referrer. Only one player stays active. External YouTube links remain available.
The former real extension-origin Error 153 is documented in
[the embed investigation](recent-saves-embed-feasibility.md). Real HTTPS playback
must still be verified after deployment; restricted or embedding-disabled videos
can remain unavailable.

The website timer uses a persisted cloud deadline and displays a reminder while
the page is open. The existing extension timer and its closed-page YouTube
reminders remain a separate timer. This release does not promise a web timer
notification after closing the website. Downie is a user-clicked protocol handoff;
the site cannot verify app installation or download completion. Raindrop uses the
optional server token. Its on-page success indicator is not a cross-device history.

## Recovery and verification

Settings exports all records (including tombstones) through bounded cloud pages to
JSON. Keep regular independent exports on the Free plan; Supabase recommends
regular database dumps for off-site recovery. A JSON export preserves library
content, while a Supabase SQL dump also preserves database configuration. Import
from another browser's retained extension history is not a substitute for a backup.

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, then `npm run build:web`.
Follow the SSD storage preflight before installs, builds or tests. Server tests use
fake credentials and deterministic API responses. `web/supabase/smoke.sql` can be
run against an isolated PostgreSQL test database after the schema (never against
production). Live sign-in, real extension permission prompts, hosted migration and
YouTube playback require the configured Vercel/Supabase projects.
