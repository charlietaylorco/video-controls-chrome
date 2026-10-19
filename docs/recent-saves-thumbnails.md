# Recent saves thumbnail quality

The existing cards always requested `https://i.ytimg.com/vi/<video-id>/mqdefault.jpg`: normally 320×180, despite a larger displayed image and a 480×270 HTML size hint. The user-provided screenshot was materialized with its Library identity and visually inspected privately; enlarged thumbnail text/faces are visibly soft. The screenshot is not committed or uploaded to GitHub.

The current CSS gives the media a 16:9 ratio. At the 1160px maximum app width, padding leaves 1100px, the 24px grid gap leaves two 538px cards, and their borders leave **536×301.5 CSS-pixel** images. At a 740px single-column viewport, the image can reach **706×397.1 CSS pixels**; a 390px viewport gives 356×200.3. These are calculations from the stylesheet, not live browser measurements. On a 2× display, the largest desktop card needs about 1072×603 source pixels, so 320×180 visibly upscales.

## Source selection

Each existing lazy `<img>` starts with just `maxresdefault.jpg`. Fallback is sequential and only follows an image error or inadequate decoded dimensions:

| Candidate | Typical source size | Minimum decoded size accepted |
| --- | --- | --- |
| `maxresdefault.jpg` | 1280×720 | 640×360 |
| `sddefault.jpg` | 640×480 | 480×270 |
| `hqdefault.jpg` | 480×360 | 320×180 |
| `mqdefault.jpg` | 320×180 | 160×90 |

[YouTube’s official thumbnail reference](https://developers.google.com/youtube/data/reference/rest/v3/thumbnails) documents these size classes and notes that availability/dimensions vary. A public read-only probe of Google’s documented iframe sample video `M7lc1UVf-VE` returned actual JPEG dimensions **320×180 for mqdefault** and **1280×720 for maxresdefault**, verified with macOS `sips`. No Reader credentials, API reads or library mutations were involved. The new preferred source has four times the width and sixteen times the pixels when available.

Unavailable sizes can decode as a tiny placeholder even when an image load succeeds. The helper checks natural width/height, so a 120×90 placeholder, or an undersized 320×180 “maxres”, cannot prematurely stop fallback. Thresholds allow nonstandard but sufficiently detailed images without fetching another resolution unnecessarily. This is a dimensional heuristic; it cannot identify an arbitrary full-size placeholder or improve an originally blurry upload.

The chain assigns at most four URLs, one at a time, and stops at the first usable image. There are no HEAD requests, parallel probes, offscreen `Image` preloads, Reader reads, automatic retry loops or new permissions. Browser-native lazy loading determines when the first URL is fetched. Removing a row detaches its image handlers, preventing late events from starting fallback requests for discarded cards; stale candidate events are ignored.

The image keeps a 1280×720 layout hint, while media/link/image keep the same 16:9 CSS ratio and existing cover crop. Standard/high 4:3 assets are cover-cropped into that area. If all candidates fail, the broken image is hidden and a restrained unavailable label appears; the thumbnail link keeps its full reserved area and accessible Watch label. No card dimensions are changed by success, fallback or terminal failure.

## Verification

- `npm test`: **242 tests pass**, including seven source/fallback/placeholder/error/cleanup/URL-safety tests and a real-card controller test proving fallback/removal adds no Reader messages.
- Existing playback, save, notes, pacing, search, toast and floating-shortcut regressions remain passing.
- Root/test JavaScript syntax, Watch script/style references, manifest assets, unchanged manifest/permissions/CSP and diff whitespace checked. No configured build/lint script exists.
- Public source JPEG dimensions checked as above. No live private Reader documents or user-browser extension state were modified for tests.
- Offline browser fixture supports `?mode=layout&thumbnail=available`, `thumbnail=placeholder` (tiny maxres followed by a usable standard image) and `thumbnail=unavailable` (all sizes tiny). It intercepts image sources into local synthetic SVG data, logs the chosen source/size, and blocks outbound network/navigation.

Native browser layout/visual validation is not claimed unless an isolated browser becomes available. In particular, high-resolution availability on the two screenshot videos and every saved video is not verified; fallback quality depends on what YouTube supplies.
