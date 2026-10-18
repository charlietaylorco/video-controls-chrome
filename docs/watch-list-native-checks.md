# Watch list verification

Checks ran on 18 October 2026 in Codex’s isolated in-app browser. The actual Watch list UI, IndexedDB store, background routing and Reader transport ran against synthetic documents and a fake in-memory HTTP adapter. No extension was installed, real Reader credentials used, or real notes/library mutated. The fixture’s CSP blocks outbound connections and substitutes local thumbnail art.

| Check | Observed result |
| --- | --- |
| Initial view and Next/Previous | 12 cards per page; zero Reader requests for browsing |
| Explicit Refresh | Exactly 12 direct `list/?id=…` requests, no discovery/pagination; completed status remained visible after local notifications |
| Move Later → Shortlist | Exact-ID preflight, location-only PATCH and readback; verified Shortlist chip |
| Trash cancellation | Exact title/URL/ID confirmation, Cancel initially focused, no DELETE |
| Confirmed Trash | Exact-ID preflight, one mock DELETE with HTTP 204, absent-ID readback; card removed and success remained visible |
| New mock save | Actual background POST/save hook recorded metadata; local notification put the new video first without a refresh GET |
| Mock 401 | Batch stopped on its first rejected request; authorization error remained visible |
| Slow refresh → Next | Page changed while the first request was pending; only one request was issued and its late reply did not replace page 2 |
| Summary HTML | `<img src=x onerror=alert(1)>` appeared as literal text; no remote markup was inserted |
| Unlinked retained saves | Refresh made zero Reader requests; explicit linking explanation and disabled mutations |
| Empty history | Empty state, zero requests, Previous/Next disabled |
| Theme and layout | Light/dark modes; desktop 1280×720 and narrow 390×844, one narrow column and no horizontal overflow |
| Final integration check | Refreshed 12 cards with completed feedback; browser error log empty |

[Desktop mock preview](watch-list-desktop-mock.jpg), [narrow mock preview](watch-list-narrow-mock.jpg), and a [captured mock request trace](watch-list-native-trace.txt) are included. The trace records the final explicit 12-document refresh; it is not a live Reader log. The larger optional Chromium/Playwright suite was not rerun; its previous launch failure is documented in the README.

Run `npm ci --ignore-scripts --no-audit --no-fund` then `npm test` for all Node regressions. Generate the offline browser fixture with `node tests/watch-browser-fixture.cjs` and serve only `output/watch-browser` on loopback. Use normal mode for synthetic saves/moves/deletes; `?mode=empty` or `?mode=unlinked` for those states. Reload resets only the fixture’s named synthetic database. The production database is not touched.

Live YouTube markup, authenticated Reader behavior (including account-specific Shortlist handling), browser-extension reload, and real thumbnail loading still need a manual smoke test before release. No live API validation is claimed. History is local to this extension/profile and is subject to browser data clearing/quota/eviction; there is no application history age/count cap or automatic Reader history import.
