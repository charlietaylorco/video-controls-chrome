# YouTube watch speed keys

`Shift+,` and `Shift+.` change the current watch video's speed by 0.25x on
`youtube.com`, `www.youtube.com` and `m.youtube.com` `/watch?v=…` pages.
For example, `1.75 → 2 → 2.25` and `3 → 2.75 → 2.5 → 2.25 → 2 → 1.75`.
Off-grid rates keep their offset: `3.1 → 2.85`. Held keys repeat normally.

[YouTube's shortcut reference](https://support.google.com/youtube/answer/7631406?hl=en)
documents `>`/`<` for speed and unshifted punctuation for frame stepping. The
extension handles shifted punctuation, shifted base-key variants and missing-key
events with Comma/Period codes or legacy 188/190 key codes. Explicit unrelated
layout characters, other modifiers, composition and editable fields pass through.

The small isolated-world listener registers at `document_start`, before page
listeners. Once the normal controller is ready, it consumes a handled keydown
and its keypress/keyup sequence to prevent native double changes or snapping
back to YouTube's supported menu rates. It reuses `content.js`'s rate rounding,
0.01x–16x clamp, saved hover-preview rate and UI. The configurable overlay step
and presets are unchanged. Browser-rejected rates retain the previous speed and
saved state; Chromium rejects rates below 0.0625x even inside the extension clamp.

Each key resolves the live main video inside `#movie_player`, checks the watch
route and optional `ytd-watch-flexy` video identity, skips navigation gaps and
hidden/missing/disconnected videos, and supports the current player in fullscreen.
Other routes, frames, music.youtube.com and other sites keep their existing keys.

## Validation

Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm test`.
For the actual unpacked-extension checks, use an installed Playwright/Chromium:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium \
node --test tests/youtube-speed.browser.cjs
```

The browser suite loads this extension in a fresh temporary headless profile,
serves offline fixtures at test URLs, blocks real page requests and never plays
media. It checks native capture/bubble listeners installed during page parsing,
crossing 2x both directions, repeats, bounds/browser rejection, editing and shadow
fields, modifiers/frame keys, SPA transitions and replacement videos, fullscreen,
other sites, hover-preview state and the configurable overlay step. Unit tests
also cover event variants, composition, duplicate injection and iframe exclusion.
These fixtures model native listeners; they do not validate live YouTube internals
or change the user's Arc profile, notes, extension settings or tabs.

Existing Reader browser regression `late save stays on its captured video and
preserves edits made while saving` fails its status-label assertion (`Review
conflict` versus `Unsaved draft`) on unchanged main `00e3062` as well. The actual
draft text is preserved. This work leaves that separate behavior unchanged.

When ready, save any note drafts, reload the extension in Arc's extension manager,
then reload only the YouTube watch tab where the new keys are needed. The early
listener requires a fresh page load. No reload is performed by this change.
