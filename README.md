# Minimal Video Speed

Minimal Chrome extension that injects a compact hover-only speed controller into the top-left corner of each HTML5 video.

## Controls

- The controls appear only while the pointer is over a video
- Hovering configurable center bands on the video can temporarily preview it at lower speeds
- `-` decreases playback speed by the configured overlay step for that specific video
- `1x`, `2x`, `3x` jump that video to preset speeds
- `+` increases playback speed by the configured overlay step for that specific video
- The picture-in-picture button toggles PiP for that specific video when the site allows it
- The speed readout shows the current saved speed for that video
- The Downie icon opens the current video or page in Downie when possible
- The cloud icon saves YouTube videos and embeds to Raindrop.io's Unsorted collection and highlights videos already saved by the extension
- On X/Twitter, the separate download-to-tray icon saves the highest-resolution complete MP4 exposed by that player, using bitrate to break ties. It verifies both audio and video tracks before downloading and never silently falls back to a lower quality

## X/Twitter downloads

X Broadcasts offer both the direct MP4 download button and **Open in Downie** in the same hover controls. The direct button uses the existing MP4 detection and audio verification; if the player does not expose a complete MP4, it reports an error. The Downie button sends the Broadcast page URL so Downie can resolve its stream and title. Downie manages its download and filename.

If the controls do not appear, check the extension's **Site access** in `chrome://extensions`. With **On click** access, activate the extension from its toolbar button on the X tab and reload the page if prompted. Hover controls require access to that page.

After updating the extension, reload it in `chrome://extensions` (also in Arc), then reload any open X tabs. Open/play an accessible video, signed in or logged out, and hover over it to use **Download highest-quality X video with audio**. The file is saved through the browser's normal downloads flow; check the browser's Downloads list for progress, completion, or an interrupted transfer.

Filenames use `@handle tweet-id Display Name Tweet text….mp4`. Tweet text is capped at 80 characters, with whole emoji preserved; invalid filename characters and line breaks become spaces. Very long names/text are shortened further to fit filesystem limits. The ID is always included, even for posts without text. Missing names/text are omitted; if post metadata cannot be identified, the filename falls back to `x-video media-<media-id>.mp4`. Metadata is matched to the selected video, including quoted/reposted videos, and duplicate downloads receive the browser's normal numbered suffix.

The extension reads only that player's available renditions and matching post metadata when clicked. It does not send posts to a downloader service, copy login credentials, or keep private video URLs or post text in extension storage. The browser uses the current profile's session for media requests. This adds the `downloads` permission and access to `https://video.twimg.com/*`; [Chrome's downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) handles saving the original file without re-encoding.

"Highest quality" means the largest complete MP4 rendition X supplies to the current player, not the original uploaded file or a potentially higher streaming-only rendition. The newer logged-out player exposes one complete MP4 through its download URL; the extension uses that file and reads matching Relay post metadata for the same filename format as signed-in downloads. If post text is unavailable, it is omitted. The downloaded MP4 must contain both audio and video tracks. Silent GIFs, live streams, DRM media, HLS-only videos, unavailable/expired media, or files whose tracks cannot be verified produce an error instead of a misleading download. Access depends on the post and its media being available in your current browser session. X's internal player metadata can change; if detection stops working, reload the tab first.

## Settings

- Open the extension details page in `chrome://extensions` and use **Extension options**
- Overlay step can be set to any value from `0.01` to `16`
- Hover preview defaults to center `20%` at `1x`, then `10%` per side at `1.5x`, then another `10%` per side at `2x`
- Each hover band width can be set from `0%` to `100%`
- Each hover band speed can be set from `0` to `16`
- The options page supports direct number input plus `-0.25` and `+0.25` adjustments
- Reader saving requires a Readwise access token in **Extension options**
- Raindrop saving requires a Test token from your Raindrop.io app in **Extension options**; the token is stored locally in this browser
- **Icon order** lets you move overlay actions left or right; unavailable actions stay hidden
- **Focus mode** hides YouTube Home and Subscriptions feeds; toggle it on/off in **Extension options** or YT Lists' filters
- **Daily unblocks** defaults to `3` and can be set from `0` to `100`; `0` disables unblocking while focus mode is on. Changes apply to open YouTube tabs, preserving today's usage
- Each unblock keeps the 30-second delay. **Day ends at** controls when the allowance resets (default: `02:00`, local time)
- The chosen setting applies globally, including embedded videos

## Embeds

- The content script runs in all frames, including related `about:`, `blob:`, and embedded iframe contexts, so embedded players get their own overlay too
- Picture-in-picture availability still depends on the browser API and the site or embed permissions policy, so some videos may not expose the PiP button
- The Reader icon saves the top-level page URL, while the Downie icon prefers the direct video URL when one is available

## Load In Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the extension folder you cloned or downloaded locally

## Reader panel on YouTube

In **Extension options → Reader**, enable **Reader panel on YouTube**. It defaults to off. On a YouTube watch/live page, click the collapsed **Reader** row below the video details to see its existing Reader summary, tags, and Document Note. The playback overlay and its one-click save work independently. No new permissions are required.

- **Refresh** fetches the current Reader document. Missing summaries mean no summary has been returned yet; Reader may still be processing the video or automatic summaries may be disabled. This extension does not generate summaries or invoke Ghostreader.
- **Save note** explicitly replaces the Document Note. Saving an empty note clears it. Tags are display-only. Reader content is shown as plain text, including any Markdown/HTML markup.
- Unsaved drafts are retained per video in this tab through YouTube navigation, collapse, metadata remounts, refresh, and pending requests. Edits typed during a save remain unsaved after that save completes. Drafts are held in memory: copy or save them before a full page reload, tab close, browser crash, or extension reload. The tab requests the browser's leave-page warning when drafts are dirty; the browser controls whether that warning is shown.
- Every save first re-reads the captured Reader document, verifies its source video, and compares its note with the editing baseline. If it changed, compare the Reader note and choose **Use Reader note** or **Keep my draft for next save**, then save explicitly. Reader's public API has no atomic conditional update: another client can still change the note between this check and the PATCH. Concurrent saves through this extension are serialized.
- Newly saved videos retain a canonical video URL → Reader document ID mapping. Existing/externally saved videos are matched by source URL in one page of up to 100 Reader `video` documents per explicit action. **Search next 100 videos** continues manually. There is no automatic full-library scan or save on navigation/panel open. Older videos can require multiple clicks; documents Reader classified outside `video` are found only if their ID was retained by this extension. Deleted/stale IDs are verified and discarded before discovery.
- Panel reads are capped locally below Reader's list limit. HTTP 429 cooldowns honor `Retry-After` (at least one minute) and survive service-worker restarts; there are no automatic retries. A failed or timed-out note write may have reached Reader: the draft stays intact, and **Refresh** checks the actual note before another attempt.

![Reader panel with mock summary, tags, and Document Note](docs/reader-panel-mock.png)

The preview uses a mock YouTube layout and mock Reader data.

The panel currently targets standard desktop/mobile watch and live pages. Shorts, embeds, and layouts without a stable video-details surface retain the existing save/playback controls. Summary polling, tag editing, transcript/highlights, and Ghostreader chat are outside this version.

### Development checks

No build step or lint configuration is required for this plain JavaScript extension. Run syntax and regression checks with Node.js:

```sh
for file in *.js tests/*.js tests/*.cjs; do node --check "$file" || exit; done
node --test tests/*.test.js
git diff --check
```

Optional browser checks use Playwright with a fresh headless Chromium profile. Every page/network response and Reader operation is mocked; they do not install the extension into your browser or use real Reader credentials/notes. Install Playwright locally if needed (keep `node_modules` untracked), then run:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node --test tests/reader-panel.browser.cjs
```

An existing Playwright module/browser can be supplied with `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Browser checks cover SPA drafts, late fetch/save responses, external note conflicts, explicit clearing, inert remote HTML, metadata remounts, light/dark/mobile flow layout, and existing playback/one-click save. Fixture screenshots are written under `output/playwright/`. These checks do not validate YouTube's live DOM or Reader's live authenticated responses; a manual smoke test in a separate test profile is still needed before release.
