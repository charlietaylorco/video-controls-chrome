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

After updating the extension, reload it in `chrome://extensions` (also in Arc), then reload any open X tabs. While signed in, open/play a video and hover over it to use **Download highest-quality X video with audio**. The file is saved through the browser's normal downloads flow; check the browser's Downloads list for progress, completion, or an interrupted transfer.

Filenames use `@handle tweet-id Display Name Tweet text….mp4`. Tweet text is capped at 80 characters, with whole emoji preserved; invalid filename characters and line breaks become spaces. Very long names/text are shortened further to fit filesystem limits. The ID is always included, even for posts without text. Missing names/text are omitted; if post metadata cannot be identified, the filename falls back to `x-video media-<media-id>.mp4`. Metadata is matched to the selected video, including quoted/reposted videos, and duplicate downloads receive the browser's normal numbered suffix.

The extension reads only that player's available renditions and matching post metadata when clicked. It does not send posts to a downloader service, copy login credentials, or keep private video URLs or post text in extension storage. The browser uses the current profile's session for media requests. This adds the `downloads` permission and access to `https://video.twimg.com/*`; [Chrome's downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) handles saving the original file without re-encoding.

"Highest quality" means the largest complete MP4 rendition X supplies to the current player, not the original uploaded file or a potentially higher streaming-only rendition. The downloaded MP4 must contain both audio and video tracks. Silent GIFs, live streams, DRM media, HLS-only videos, unavailable/expired media, or files whose tracks cannot be verified produce an error instead of a misleading download. Access still depends on your signed-in account being able to view the post. X's internal player metadata can change; if detection stops working, reload the tab first.

## Subscription review

On desktop `https://www.youtube.com/feed/subscriptions`, use **Review subscriptions** in the bottom-right toolbar. Review follows YouTube's native newest-first page order; it does not sort approximate relative dates or fetch RSS feeds. It covers recognized video cards currently loaded on the page, deduplicating repeated videos. Scroll the normal feed to let YouTube load more, then start another review. "Loaded videos reviewed" does not mean your entire subscription history has been scanned. Mobile YouTube and Shorts shelves without an individual supported video card are outside this first version.

- Drag left or choose **← Hide** to hide that video from this subscriptions page. It stays hidden when you exit review, reload, or return. Home, search, channel pages, and YouTube account state are unaffected.
- Drag right or choose **Later →** to save a video snapshot to the independent **Later** queue. Saved videos remain visible in the normal subscriptions feed; they are excluded from subsequent review decks until removed from Later.
- **↓ Skip** leaves a video unchanged and skips it only for the current review. **Undo** reverses recent individual decisions; it refuses to overwrite a newer decision on the same video from another tab. Bulk actions require a second confirmation and clear the recent undo history.
- While review has focus, **← / ↓ / →** hide, skip, or save for later. **Cmd/Ctrl+Z** undoes and **Escape** closes. Typing, composing text, held keys, and modified arrow shortcuts do not trigger decisions. Buttons work without gestures or motion.
- **Later** offers Watch, Remove from Later, Hide from subscriptions, search, and Clear Later. Opening a video does not remove it or claim it was watched.
- **Hidden** offers search, Restore, and Restore all, including videos whose original cards are no longer loaded.

This feature is independent of YT Lists: it uses only its own `subscriptionsReviewV1` local storage key, never imports or changes lists or archives, and adds no permissions or credentials. Decisions are shared by YouTube accounts using the same browser extension profile, do not sync between browsers, and are removed when the extension is uninstalled. Storage is bounded at 5,000 decisions and 1.5 MB including recent undo records; reaching that budget or Chrome's shared storage quota produces a visible error without dropping existing decisions.

The existing **Focus mode** gate still applies. Subscription tools stay unavailable until Focus has evaluated the page and allowed the feed, including the existing unblock delay and allowance. The feature does not turn Focus off or spend an unblock on its own. YouTube renderer changes may require selector updates; no live account or installed-extension smoke test was performed for the initial implementation. See [fixture verification](tests/SUBSCRIPTIONS.md).

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
