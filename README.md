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
- The download icon opens the current video or page in Downie when possible

## Settings

- Open the extension details page in `chrome://extensions` and use **Extension options**
- Overlay step can be set to any value from `0.01` to `16`
- Hover preview defaults to center `20%` at `1x`, then `10%` per side at `1.5x`, then another `10%` per side at `2x`
- Each hover band width can be set from `0%` to `100%`
- Each hover band speed can be set from `0` to `16`
- The options page supports direct number input plus `-0.25` and `+0.25` adjustments
- Reader saving requires a Readwise access token in **Extension options**
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
