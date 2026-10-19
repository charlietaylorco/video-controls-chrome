# Recent saves verification

Checks used Codex’s isolated in-app browser, native browser IndexedDB and the actual page/background/Reader service against synthetic documents. No real Reader credentials/data or normal Arc browser were used. The fixture blocks outbound connections and link navigation; thumbnail artwork is local.

Current layout: two large cards per desktop row, one when narrow; title and channel separated by 6px, no visible tags, full inline summary, flat custom location trigger, Reader icon, Saved/Checked footer and both Refresh/Trash icons. Only YT Lists appears at the header’s right. Thumbnails/titles are direct YouTube links; no iframe or “player opened” feedback remains after the confirmed real Error 153 failure.

| Check | Observed result |
| --- | --- |
| Custom menu | Correct menu/menuitemradio roles, checked location, distinct destructive Trash; arrow wrap, Home/End/typeahead, Escape and outside dismissal |
| Tab/focus | Tab closed the menu and moved to Reader link; Escape restored the trigger; move/refresh completion restored the initiating control |
| Verified move | Menu Later issued exact-ID preflight, location-only PATCH and readback; trigger showed verified Later |
| Menu Trash | Correct title/URL/ID confirmation with Cancel focused; cancellation sent no DELETE and restored trigger focus |
| Footer Trash | Same confirmation; Cancel restored icon focus and sent no DELETE; confirmation sent one exact DELETE, required HTTP 204 plus absent-ID readback, removed the card and focused the current filter |
| Trigger hover/alignment | Hovered trigger had transparent background and filter `none`. Rendered Later text aligned with title/channel, not merely element bounds |
| Compact metadata | No visible tag field; measured title-to-channel gap was 6px; title and thumbnail had the same canonical YouTube destination |
| Narrow layout | Actual viewport 280px: menu x=35…219, fully in bounds, no horizontal overflow; Saved/Checked fit the reserved 48px footer. At 390px: one 358px column, no horizontal overflow |
| Theme | Light/dark styling inherited the stored Reader preference; no Options/Theme controls were restored |
| Header icon | Enter and pointer activation sent the shared open-watch-list route; header remount and navigation left exactly one icon and preserved native Search/Account controls |

The header uses a native button in both production and the browser fixture, so keyboard events retain an interactive button target and the tooltip/accessible name is Recent saves. Live YouTube header markup/mobile placement is not claimed as verified. The observer tests confirm that healthy unrelated mutations cause no selector queries or polling timers. Toolbar tests verify new-tab creation, exact own-tab reuse/window focus, pending/lookalike/private/stale rejection and rapid-activation deduplication; real browser-toolbar activation remains a manual smoke test.

Earlier passes additionally checked cached zero-request pagination, bounded 12-ID refresh, new-save notifications, visible auth/rate errors, stale responses, XSS-safe summary text, empty/unlinked states, quota failures and note/playback preservation. Existing regression tests retain these checks. The earlier synthetic player trial did not validate real playback; Charlie later confirmed Error 153. [Limitation and references](recent-saves-embed-feasibility.md).

[Current layout](recent-saves-desktop-mock.jpg), [styled menu](recent-saves-menu-mock.jpg), [dark menu](recent-saves-dark-mock.jpg), [narrow layout](recent-saves-narrow-mock.jpg), [header fixture](recent-saves-header-mock.jpg). Layout previews use two synthetic cards; normal mode keeps 27 saves/12-card paging. Original mock request traces are retained as historical evidence, not live Reader logs.

Run `npm test`; generate browser fixtures with `node tests/watch-browser-fixture.cjs`, then serve only `output/watch-browser` on loopback. The optional full Chromium suite was not rerun. Live authenticated Reader behavior and actual YouTube DOM still require a manual smoke test before release. No permissions or security settings were expanded.
