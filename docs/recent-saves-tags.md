# Inline Reader tags in Recent saves

Recent saves (`watch.html`) displays cached Reader document tags beside the channel, with one decorative tag icon before the group. Missing, unknown, empty and missing-document tags render no group or icon. Tag labels use text nodes. Existing Reader reads provide tags; rendering, typing and filtering never fetch Reader.

Each native button applies a separate exact whole-tag filter. Unicode/case/whitespace normalization follows the existing channel filter. Tag, channel, text query and location intersect across retained history with existing pagination. Tags also participate in ordinary text search. The removable Tag chip restores input focus; Clear removes query/channel/tag criteria, and Reset also chooses All saves. Repeated clicks do not stack filters or issue duplicate page loads. Tag clicks prevent navigation and bubbling. Controls retain busy/deletion guards and stale-result rejection.

Tags remain in retained metadata independently of the bounded summary cache. A refresh omitting tag metadata preserves known tags only for the same saved document; an explicit empty list/object clears them. Failed reads keep cached metadata. Missing/deleted/replacement documents cannot contribute stale tag matches. No schema or permission changes are needed.

## Checks

- `npm test`: 280 passing tests on main-based implementation, including six new service/store/page cases covering multiword and Unicode tags, exact matching, pagination beyond one page, query/channel/location intersections, empty/missing data, failed refreshes, explicit empty versus omitted metadata, replacement identities, literal hostile text, input bounds, repeated clicks, clear/reset, loading/error states and stale replies. Existing Reader note/deletion/location/rate-limit regressions pass. All service traffic is mocked; no real Reader mutations.
- Root JavaScript syntax, Watch script/style references, manifest assets and `git diff --check` pass. Manifest, permissions and CSP are unchanged.
- Isolated cached Chromium with the offline fixture: desktop light screenshot inspected; tags appear inline beside channel and unchecked cards have no tag symbol. Clicking Creativity returns exactly 10 cached matches; removing the chip restores 12 cards. Mock Reader request count remains zero.
- At 390 × 844 in dark mode, a stress fixture containing a multiword tag, 200-character tag and 50 additional tags stays inside the card, with a bounded scroll area (at most 92px) and no horizontal page overflow. Multiword tag selection and Clear pass; screenshot inspected. Reproduce with `node tests/watch-browser-fixture.cjs`, serve only its generated directory on loopback, and open `?tags=stress&theme=dark`.

No real Reader API, deletion, note editing, extension reload or existing-tab reload was used. Screen-reader speech and real-account tag availability were not tested.
