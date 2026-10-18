# Recent saves verification

Checks ran on 18 October 2026 in Codex’s isolated in-app browser. The actual page, IndexedDB store, background routing and Reader transport ran against synthetic documents and a fake in-memory HTTP adapter. No extension was installed, real Reader credentials used, or real notes/library mutated. The fixture’s CSP blocks outbound connections and substitutes local thumbnail art.

The refined page has only a compact **Recent saves** title in the header (no YT Lists, Options or Theme controls), two substantial cards per desktop row, large 16:9 thumbnails, title, channel name and tags with visually hidden accessible field labels, a flat current-location dropdown containing a separate **Trash…** action, full inline summaries, and a bottom-right per-card refresh icon. Open in Reader is icon-only with a tooltip; Saved date and Checked share the bottom-left footer. It has no intro, default “Newest saves…” copy, redundant Trash button, summary disclosure, text clamp, or internal summary scroll area.

| Check | Observed result |
| --- | --- |
| Initial view and Next/Previous | At most 12 cards per page; zero Reader requests for cached browsing |
| Per-card Refresh | Exactly one `list/?id=mock-25` request supplied summary, tags and location; other cards were not fetched |
| Pending refresh and mock 401 | Actual first card height stayed **699.8203125px** before, during loading and after the error; error remained visible in the reserved feedback area |
| Dropdown move Later → Shortlist | Exact-ID preflight, location-only PATCH and readback; dropdown showed verified Shortlist |
| Dropdown Trash cancellation | Exact title/URL/ID confirmation, Cancel initially focused, no DELETE; dropdown retained the verified location |
| Confirmed dropdown Trash | Exact-ID preflight, one mock DELETE with HTTP 204, absent-ID readback; card removed and success remained visible |
| Metadata and summary HTML | `<img src=x onerror=alert(1)>` appeared as literal text in both tags and summary; no injected image elements |
| Tags | Cached names shown; unfetched and verified-empty tags stayed distinct; card refresh used the same document GET, with no tag/library lookup |
| Connection changed during slow card refresh | The late reply did not replace the connection-change message with success |
| Connection changed during slow Trash preparation | Confirmation stayed closed after the late reply |
| Theme and layout | Light/dark modes; desktop 1280px had two 538px columns and 16:9 image geometry; 390px and 280px had one column and no horizontal overflow |
| Final labels and footer | Channel/Tags/location labels remained in the accessibility tree but were visually clipped; channel text measured 13px; Reader icon had no visible text and retained its exact target, accessible name and tooltip; Saved/Checked fit the reserved 32px footer at 390px and 280px |
| Flat selector keyboard | Native menu opened with ArrowDown; Escape closed it and retained a solid visible focus outline. Resting background/border were transparent |
| Final Trash check | Flat dropdown still opened the exact-document dialog with Cancel focused; cancellation sent no DELETE |
| Full summary | No disclosure elements; computed maximum height `none` and overflow `visible` |

The latest bounded-player pass verified zero initial iframes, keyboard Enter to load, focus entering the frame, no autoplay in the synthetic player, replacement leaving exactly one frame, Close/Enter and Close/Escape restoring the corresponding thumbnail focus, and teardown on filter/page changes. A Reader refresh kept the same mock playback state and issued no second player request; a new save reordered cards and unmounted the player without another player request. A simulated unavailable/error-153 frame retained the usable Open on YouTube link. A 390px layout fit a 356×200.25 player; below the 200×200 minimum, resize unmounted it and retained the thumbnail/fallback, with no horizontal overflow. Light/dark preference support remains active without page controls. The browser error log was empty.

The visible **Later** text was verified in the rendered desktop screenshot against the title/channel edge, not only the select box. Appearance and internal leading padding were removed while retaining a native select, keyboard menu and focus outline; the content starts at x=113px in the recorded desktop layout. [Current thumbnail/alignment preview](recent-saves-desktop-mock.jpg), [single synthetic player preview](recent-saves-player-mock.jpg).

Visibility/pagehide teardown is covered by the Node lifecycle fixtures. The in-app browser's background-tab operation did not change document visibility, so no native hidden-tab test is claimed. Available browser surfaces were only IAB and MCP Apps, with no extension-loading capability: **real extension-origin YouTube playback was not tested**. These mock iframe checks do not establish whether YouTube accepts the extension's client identification. No real Reader data or normal Arc browser was used. Production permissions/CSP are unchanged; the offline fixture alone permits its own same-origin synthetic frame, never a live YouTube frame.

The original pass additionally checked a bounded 12-ID page refresh, new-save notifications, cancellation of the remaining slow refresh batch on page change, and empty/unlinked states. Current follow-up checks reconfirm these page controls and states. The full Node suite covers the unchanged history, paging, API budgets, quota, notes/playback and stale-target behavior.

[Refined desktop mock preview](recent-saves-desktop-mock.jpg), [dark mock preview](recent-saves-dark-mock.jpg), [narrow mock preview](recent-saves-narrow-mock.jpg), and a [captured refined interaction trace](recent-saves-native-trace.txt) are included. Layout previews intentionally use `?mode=layout`, with only two synthetic cards; normal mode retains the 27-save fixture and 12-card pagination. The [original 12-document refresh trace](watch-list-native-trace.txt) is retained as prior evidence. These are mock logs, not live Reader logs. The larger optional Chromium/Playwright suite was not rerun; its previous launch failure is documented in the README.

Run `npm ci --ignore-scripts --no-audit --no-fund` then `npm test` for Node regressions. Generate the offline browser fixture with `node tests/watch-browser-fixture.cjs` and serve only `output/watch-browser` on loopback. Use normal mode for synthetic saves/moves/deletes; `?mode=empty`, `?mode=unlinked`, or `?mode=layout` for those states. Reload resets only the fixture’s named synthetic database. The production database is not touched.

Live YouTube markup, authenticated Reader behavior (including account-specific Shortlist handling), browser-extension reload, and real thumbnail loading still need a manual smoke test before release. No live API validation is claimed. History is local to this extension/profile and is subject to browser data clearing/quota/eviction; there is no application history age/count cap or automatic Reader history import.
