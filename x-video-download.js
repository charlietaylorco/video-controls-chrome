// Service-worker helpers. URLs from the page are untrusted, even on X.
const XVideoDownload = (() => {
  const X_HOSTS = ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"];
  const fail = (code) => { throw new Error(code); };
  const isXPage = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && X_HOSTS.includes(url.hostname) &&
        !url.port && !url.username && !url.password;
    } catch { return false; }
  };

  const parseVariant = (variant) => {
    if (!variant || variant.type !== "video/mp4" || typeof variant.url !== "string" || variant.url.length > 4096) return null;
    try {
      const url = new URL(variant.url);
      if (url.protocol !== "https:" || url.hostname !== "video.twimg.com" ||
          url.port || url.username || url.password || url.hash) return null;
      // Only complete, progressive renditions. In particular /vid/avc1/0/0/...
      // is an HLS initialization fragment and /aud/... is audio alone.
      const match = url.pathname.match(/^\/(ext_tw_video|amplify_video)\/(\d{1,25})\/(?:pu\/)?vid\/(?:avc1\/)?(\d+)x(\d+)\/([\w-]+)\.mp4$/);
      if (!match) return null;
      const width = Number(match[3]);
      const height = Number(match[4]);
      if (!width || !height || width > 16384 || height > 16384) return null;
      return {
        url: url.href, mediaId: match[2], width, height,
        bitrate: Number.isFinite(variant.bitrate) ? Math.max(0, variant.bitrate) : 0
      };
    } catch { return null; }
  };

  const selectBest = (variants) => {
    if (!Array.isArray(variants) || variants.length > 32) fail("no_mp4");
    const candidates = variants.map(parseVariant).filter(Boolean);
    if (!candidates.length) fail("no_mp4");
    if (new Set(candidates.map((variant) => variant.mediaId)).size !== 1) fail("ambiguous_video");
    candidates.sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate);
    return candidates[0];
  };

  const cleanFilenameText = (value) => typeof value === "string"
    ? value.slice(0, 10000).normalize("NFC")
      .replace(/[<>:"/\\|?*\[\]\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "")
    : "";
  const graphemes = (value) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment);
  const truncate = (value, maxCharacters, maxBytes = Infinity) => {
    const parts = graphemes(value);
    const kept = [];
    let bytes = 0;
    for (const part of parts) {
      const size = new TextEncoder().encode(part).length;
      if (kept.length >= maxCharacters || bytes + size > maxBytes) break;
      kept.push(part);
      bytes += size;
    }
    if (kept.length === parts.length) return value;
    // Keep the ellipsis within both limits, without splitting emoji or accents.
    while (kept.length && (kept.length >= maxCharacters || bytes + 3 > maxBytes)) {
      bytes -= new TextEncoder().encode(kept.pop()).length;
    }
    return kept.join("").trimEnd() + (maxBytes >= 3 ? "…" : "");
  };

  const makeFilename = (metadata, best) => {
    const handle = typeof metadata?.handle === "string" ? metadata.handle.replace(/^@/, "") : "";
    const tweetId = typeof metadata?.tweetId === "string" && /^\d{1,25}$/.test(metadata.tweetId)
      ? metadata.tweetId : `media-${best.mediaId}`;
    const author = /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `@${handle}` : "x-video";
    const name = truncate(cleanFilenameText(metadata?.displayName), 50, 80);
    const prefix = `${author} ${tweetId}${name ? ` ${name}` : ""}`;
    // Leave space for the separator, extension, and Chrome's duplicate-file suffix.
    const textBytes = 230 - new TextEncoder().encode(`${prefix} .mp4`).length;
    const text = truncate(cleanFilenameText(metadata?.text), 80, textBytes);
    return `${prefix}${text ? ` ${text}` : ""}.mp4`;
  };

  const boxType = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const boxHeader = (bytes, offset, end) => {
    if (offset + 8 > bytes.length) fail("invalid_mp4");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) fail("invalid_mp4");
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) fail("invalid_mp4");
    return { type: boxType(bytes, offset + 4), size, headerSize };
  };

  const childBoxes = (bytes, start, end) => {
    const result = [];
    for (let offset = start; offset < end;) {
      if (result.length >= 4096) fail("invalid_mp4");
      const box = boxHeader(bytes, offset, end);
      result.push({ ...box, start: offset + box.headerSize, end: offset + box.size });
      offset += box.size;
    }
    return result;
  };

  const inspectMovie = (bytes) => {
    const root = boxHeader(bytes, 0, bytes.length);
    if (root.type !== "moov" || root.size !== bytes.length) fail("invalid_mp4");
    const children = childBoxes(bytes, root.headerSize, bytes.length);
    if (children.some((box) => box.type === "mvex")) fail("fragmented_mp4");
    const tracks = new Set();
    for (const track of children.filter((box) => box.type === "trak")) {
      const media = childBoxes(bytes, track.start, track.end).find((box) => box.type === "mdia");
      if (!media) continue;
      const mediaChildren = childBoxes(bytes, media.start, media.end);
      const handler = mediaChildren.find((box) => box.type === "hdlr");
      const minf = mediaChildren.find((box) => box.type === "minf");
      const stbl = minf && childBoxes(bytes, minf.start, minf.end).find((box) => box.type === "stbl");
      const stsd = stbl && childBoxes(bytes, stbl.start, stbl.end).find((box) => box.type === "stsd");
      if (stsd) {
        if (stsd.end - stsd.start < 8) fail("invalid_mp4");
        const descriptions = childBoxes(bytes, stsd.start + 8, stsd.end);
        if (descriptions.some((box) => box.type === "encv" || box.type === "enca")) fail("encrypted_mp4");
      }
      if (handler && handler.end - handler.start >= 12) tracks.add(boxType(bytes, handler.start + 8));
    }
    if (!tracks.has("vide")) fail("no_video");
    if (!tracks.has("soun")) fail("no_audio");
  };

  // Inspect only MP4 metadata using bounded byte ranges; skip the large mdat
  // payload. This also supports files whose moov box is at the end of the file.
  const verifyAudioVideo = async (url, signal) => {
    let fileSize = null;
    const read = async (start, length) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${start + length - 1}` },
        credentials: "include", redirect: "error", cache: "no-store", signal
      });
      const cancel = async () => { try { await response.body?.cancel(); } catch {} };
      const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (response.status !== 206 || !range || Number(range[1]) !== start ||
          Number(range[2]) < start || Number(range[2]) >= start + length ||
          !Number.isSafeInteger(Number(range[3])) || Number(range[3]) <= Number(range[2])) {
        await cancel();
        fail(response.status === 401 || response.status === 403 ? "access_denied" : "range_failed");
      }
      if (fileSize !== null && fileSize !== Number(range[3])) {
        await cancel();
        fail("changed_file");
      }
      fileSize = Number(range[3]);
      const expected = Number(range[2]) - start + 1;
      if (!response.body) fail("invalid_mp4");
      const reader = response.body.getReader();
      const bytes = new Uint8Array(expected);
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.length > expected) fail("invalid_mp4");
          bytes.set(value, received);
          received += value.length;
        }
      } finally {
        try { await reader.cancel(); } catch {}
      }
      if (received !== expected) fail("invalid_mp4");
      return bytes;
    };

    let offset = 0;
    let movie = null;
    let hasMedia = false;
    for (let count = 0; count < 64; count++) {
      const header = await read(offset, 16);
      const box = boxHeader(header, 0, fileSize - offset);
      if (offset === 0 && box.type !== "ftyp") fail("invalid_mp4");
      if (box.type === "moof") fail("fragmented_mp4");
      if (box.type === "moov") {
        if (box.size > 4 * 1024 * 1024) fail("metadata_too_large");
        movie = await read(offset, box.size);
        inspectMovie(movie);
      }
      if (box.type === "mdat" && box.size > box.headerSize) hasMedia = true;
      if (movie && hasMedia) return;
      offset += box.size;
      if (offset >= fileSize) break;
    }
    fail("invalid_mp4");
  };

  const start = async (variants, metadata) => {
    const best = selectBest(variants);
    // No silent quality fallback: failure of the best rendition is reported.
    await verifyAudioVideo(best.url, AbortSignal.timeout(20000));
    const downloadId = await chrome.downloads.download({
      url: best.url,
      filename: makeFilename(metadata, best),
      conflictAction: "uniquify"
    });
    return { ok: true, downloadId, width: best.width, height: best.height };
  };

  return { isXPage, selectBest, makeFilename, inspectMovie, verifyAudioVideo, start };
})();
