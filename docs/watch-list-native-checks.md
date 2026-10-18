# Recent saves verification

Checks ran on 18 October 2026 in Codex’s isolated in-app browser. The actual page, IndexedDB store, background routing and Reader transport ran against synthetic documents and a fake in-memory HTTP adapter. No extension was installed, real Reader credentials used, or real notes/library mutated. The fixture’s CSP blocks outbound connections and substitutes local thumbnail art.

The refined page has a compact **Recent saves** title, two substantial cards per desktop row, large 16:9 thumbnails, title and Channel/Tags/Saved date metadata, a current-location dropdown containing a separate **Trash…** action, full inline summaries, and a bottom-right per-card refresh icon. It has no intro, default “Newest saves…” copy, redundant Trash button, summary disclosure, text clamp, or internal summary scroll area.

| Check | Observed result |
| --- | --- |
| Initial view and Next/Previous | At most 12 cards per page; zero Reader requests for cached browsing |
| Per-card Refresh | Exactly one `list/?id=mock-25` request supplied summary, tags and location; other cards were not fetched |
| Pending refresh and mock 401 | Actual first card height stayed **685.21875px** before, during loading and after the error; error remained visible in the reserved feedback area |
| Dropdown move Later → Shortlist | Exact-ID preflight, location-only PATCH and readback; dropdown showed verified Shortlist |
| Dropdown Trash cancellation | Exact title/URL/ID confirmation, Cancel initially focused, no DELETE; dropdown retained the verified location |
| Confirmed dropdown Trash | Exact-ID preflight, one mock DELETE with HTTP 204, absent-ID readback; card removed and success remained visible |
| Metadata and summary HTML | `<img src=x onerror=alert(1)>` appeared as literal text in both tags and summary; no injected image elements |
| Tags | Cached names shown; unfetched and verified-empty tags stayed distinct; card refresh used the same document GET, with no tag/library lookup |
| Connection changed during slow card refresh | The late reply did not replace the connection-change message with success |
| Connection changed during slow Trash preparation | Confirmation stayed closed after the late reply |
| Theme and layout | Light/dark modes; desktop 1280px had two 538px columns and 16:9 image geometry; 390px and 280px had one column and no horizontal overflow |
| Full summary | No disclosure elements; computed maximum height `none` and overflow `visible` |

The original pass additionally checked a bounded 12-ID page refresh, new-save notifications, cancellation of the remaining slow refresh batch on page change, and empty/unlinked states. Current follow-up checks reconfirm these page controls and states. The full Node suite covers the unchanged history, paging, API budgets, quota, notes/playback and stale-target behavior.

[Refined desktop mock preview](recent-saves-desktop-mock.jpg), [dark mock preview](recent-saves-dark-mock.jpg), [narrow mock preview](recent-saves-narrow-mock.jpg), and a [captured refined interaction trace](recent-saves-native-trace.txt) are included. Layout previews intentionally use `?mode=layout`, with only two synthetic cards; normal mode retains the 27-save fixture and 12-card pagination. The [original 12-document refresh trace](watch-list-native-trace.txt) is retained as prior evidence. These are mock logs, not live Reader logs. The larger optional Chromium/Playwright suite was not rerun; its previous launch failure is documented in the README.

Run `npm ci --ignore-scripts --no-audit --no-fund` then `npm test` for Node regressions. Generate the offline browser fixture with `node tests/watch-browser-fixture.cjs` and serve only `output/watch-browser` on loopback. Use normal mode for synthetic saves/moves/deletes; `?mode=empty`, `?mode=unlinked`, or `?mode=layout` for those states. Reload resets only the fixture’s named synthetic database. The production database is not touched.

Live YouTube markup, authenticated Reader behavior (including account-specific Shortlist handling), browser-extension reload, and real thumbnail loading still need a manual smoke test before release. No live API validation is claimed. History is local to this extension/profile and is subject to browser data clearing/quota/eviction; there is no application history age/count cap or automatic Reader history import.
