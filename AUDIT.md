# Security and performance audit — 2026-09-04

Scope: Manifest V3 permissions, background message handling and network requests,
feed imports/rendering/loading, options storage, and content-script event lifecycles.
This was a source audit with Node regression tests, not a browser penetration test
or a measured Core Web Vitals audit.

## Fixed

- **YouTube URL validation:** unrelated domains with `/shorts/` or `/live/` paths
  could pass the Reader video check and trigger background metadata fetching.
  Require an approved YouTube hostname, HTTPS and the standard port. Reject
  malformed URLs and embedded credentials before background actions.
- **Untrusted feed/channel URLs:** restrict channel resolution and rendered video
  links to HTTPS YouTube URLs; encode IDs in paths and query parameters. Validate
  imported channel records so malformed entries cannot crash channel processing.
- **Network stalls and redirects:** set a 15-second abort deadline on metadata,
  RSS, duration, channel resolution and Readwise requests. Reject redirects so
  requests cannot silently leave their validated destination. Existing error and
  cached-feed fallbacks handle failures.
- **Request fan-out:** cap each feed load at four concurrent channel requests;
  skip queued work from superseded loads and prevent stale cache writes. Active
  requests from an older load finish or hit their deadline.
- **Duplicate duration work:** share one pending promise per video, retaining the
  existing four-request duration pool and cache. Failed requests free worker slots.
- **Offscreen images:** load feed thumbnails lazily and decode asynchronously.
- **Panel listener retention:** detach the document click listener on every panel
  close path, and tolerate the channel button disappearing during navigation.

## Verification

`node --test tests/regressions.test.js`: 12 passing tests, including hostile URL
cases, Reader message rejection without network access, import validation,
concurrency bounds and result ordering, duration deduplication/failure recovery,
request deadline configuration and listener cleanup.

All application and test JavaScript passes `node --check`; `git diff --check`
passes. No dependencies were added or installed.

## Limits and follow-ups

- Live authenticated YouTube, Readwise and Downie flows need a Chrome smoke test.
  Rejecting redirects intentionally fails closed; regional/consent redirects may
  now result in cached feed data or unavailable metadata. AbortSignal.timeout
  requires a current Chrome version.
- The Readwise token remains in local extension storage, which is not encrypted
  and is accessible to the extension's content scripts. Ordinary page JavaScript
  cannot directly read it. Moving persistent secrets to trusted-only storage
  requires separating shared settings/list storage and migrating existing tokens.
- Broad content-script access is retained for the promised all-site video and
  embedded-player support. No remote scripts or dynamic code evaluation were found;
  inspected HTML templates use static markup or internally derived values.
- Duration/history cache growth, mutation-driven YouTube initialization and
  pointer-move layout work warrant profiling on a large real library. No numerical
  speedup is claimed. Saved-history read/modify/write operations can still race
  across simultaneous actions; this audit did not redesign storage coordination.

Reference: [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)
and [AbortSignal timeout behavior](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static).
