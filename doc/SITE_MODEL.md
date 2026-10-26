# Veloce site model — the contract every layer must agree on

Veloce touches a URL in four places: the extension **content script**, the extension
**service worker**, the **Node coordinator** (`backend/`), and the **Rust coordinator**
(`desktop/`). Each re-derives the same facts about that URL. When their answers
disagree, downloads fail in ways that look random (see [`PIPELINE_AUDIT.md`](PIPELINE_AUDIT.md)
issues B1–B5, C4).

This file is the single description of that shared contract. Treat it as the spec;
the four implementations are supposed to match it.

---

## 1. Canonical cache key — `normalizeFormatUrl`

Every layer keys its format cache, fail cache and dedup on a *normalized* URL. A
prefetch started by the content script and a click handled by a coordinator only
share a cache entry if both produce the **same string**.

| Implementation | File / symbol |
|---|---|
| content script | `extension/static/content.js` → `normalizeBadgeKey` |
| service worker | `extension/static/background.js` → `normalizeFormatUrl` |
| Node coordinator | `backend/src/lib/server/extractor.ts` → `normalizeFormatUrl` (exported) |
| Rust coordinator | `desktop/src-tauri/src/formats.rs` → `normalize_url` |

### Rules (reference: the Node implementation, pinned by `backend/tests/normalizeParity.test.ts`)

1. Strip the URL fragment (`#…`) always.
2. **YouTube watch:** `youtu.be/ID`, `youtube.com/watch?v=ID&…`, `m.youtube.com/watch?v=ID`
   → `https://www.youtube.com/watch?v=ID`. All other query params (`list`, `index`,
   `start_radio`, …) are dropped.
3. **YouTube Shorts:** `youtube.com/shorts/ID?…` → `https://www.youtube.com/shorts/ID`.
   The `/shorts/` form is **kept**, not rewritten to `watch?v=`.
4. **Instagram:** drop the entire query string, drop the trailing slash, and map
   `/reels/` → `/reel/`. `…/p/ABC/?igsh=x` → `https://www.instagram.com/p/ABC`.
5. **Everything else (generic / direct CDN):** drop the fragment only. Query string
   and trailing slash are **preserved** (`…/v.mp4?token=abc#f` → `…/v.mp4?token=abc`).
6. A string that does not parse as a URL is returned unchanged.
7. `normalize(normalize(x)) === normalize(x)` for every input.

### Known deviation (fix before relying on cross-layer key equality)

`desktop/src-tauri/src/formats.rs` `normalize_url` currently rewrites
`youtube.com/shorts/ID` → `https://www.youtube.com/watch?v=ID` (pinned by its own
test `test_normalize_url_youtube_shorts`), and drops the query string for the
generic case. The extension and Node keep `/shorts/` and keep the query. Each layer
re-normalises on entry so this is self-consistent *within* a layer, but it violates
rule 3/5 above. Decision needed: either change `normalize_url` (and its test) to
match rules 3 and 5, or change the Node/extension implementations and this spec.
Until then, do not assume a raw normalized key from one layer is byte-equal to
another's.

---

## 2. Platform signature — `MediaSource`

Detected from the hostname. Drives which extractor path runs and which
platform-specific error text is shown. Never mix one platform's error with
another platform's URL.

| Signature | Hosts | List path | Download path |
|---|---|---|---|
| `youtube` | `youtube.com`, `youtu.be` | yt-dlp `-J`, cookies (chrome→chromium→firefox) then player clients `android`/`web`/`ios` then none; `--js-runtimes node` always | muxed progressive URL for the range engine; DASH split → yt-dlp+ffmpeg merge |
| `instagram` | `instagram.com` | yt-dlp `-J` + cookies, `/p/` and `/reel/` variants, carousel = playlist expand | merge via yt-dlp+ffmpeg (CDN often has no Content-Length); audio-only keeps a direct CDN path |
| `tiktok` | `tiktok.com` | generic yt-dlp race | direct/muxed |
| `twitter` | `twitter.com`, `x.com` | generic yt-dlp race | direct/muxed |
| `mediafire` | `mediafire.com`, `download*.mediafire.com` | HTML scrape → CDN URL | **re-scrape on every download** (tokens expire) |
| `direct` | file extension in path on any host | single "Direct" row, no yt-dlp | range engine |
| `generic` | anything else | yt-dlp chrome→chromium→none | range engine / muxed |

Reference implementations: `backend/src/lib/server/formatSources.ts` `detectMediaSource`
and `desktop/src-tauri/src/formats.rs` `detect_source`.

---

## 3. Format kind — how the engine fetches a row

| Kind | Meaning | Download |
|---|---|---|
| `direct` | stable file URL (CDN, MediaFire, intercept) | `NEW_DOWNLOAD` with `directUrl` → range engine |
| `progressive` | single HTTP stream (`formats[].url`) | `directUrl` + `referer` |
| `manifest` | `.m3u8` / `.mpd` / `manifest.googlevideo` | **no `directUrl`** — coordinator re-extracts from the page URL |
| `adaptive` | video-only / audio-only pair | prefer merged; yt-dlp `-f bv*+ba` on download |

Extension rule (`content.js` `renderFormatButtons`): if `fmt.kind` is `manifest`
or the URL matches `.m3u8` / `.mpd`, omit `directUrl` so the coordinator re-extracts.

A signed CDN `progressive` URL from a warm cache can be **expired** by the time the
job runs. The coordinator re-extracts once from the page URL on an
expired-CDN-looking failure before surfacing the error (Node: `runDownloadJob`
`looksLikeStaleCdnFailure`; the desktop side is the follow-up in PIPELINE_AUDIT C3).

---

## 4. Adding a new site

Because the contract lives in four places, a new platform touches all of them.
This is the cost B5 in the audit is about; until the coordinators are merged, the
checklist is:

1. **`backend/src/lib/server/formatSources.ts`** — add to the `MediaSource` union,
   extend `detectMediaSource`, add a `failReasonForSource` message.
2. **`backend/src/lib/server/extractor.ts`** — add a `listFormatsBySource` branch
   (yt-dlp race, HTML scrape, or "extension supplies formats").
3. **`desktop/src-tauri/src/formats.rs`** + **`ytdlp.rs`** — mirror 1 and 2.
4. **`extension/static/sites/<name>.js`** — `createXSite(ctx)` via
   `__veloceRegisterSite`; implement the handler methods `content.js` calls.
5. **`extension/static/manifest.json`** — list the new file in `content_scripts`
   **before** `content.js`.
6. **This file** — add the row to §2, and any normalization rule to §1.
7. **Tests** — `backend/tests/formatSources.test.ts`, and a normalize case in
   `backend/tests/normalizeParity.test.ts` if the URL shape is new.

### Target (not yet built)

One declarative descriptor per platform — `{ match, normalizeKey, listStrategy,
downloadStrategy, failReason }` — emitted as data that all three runtimes read,
so §1–§3 stop being hand-copied. Tracked as B3/B5 in the audit.
