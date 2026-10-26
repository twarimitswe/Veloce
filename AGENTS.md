# Veloce — Agent Guide (format & link handling)

This file is the **source of truth for agents** working on Veloce download/format logic. When you add a site, fix a badge, or change extraction — follow these classifications and file locations.

---

## Core rule

**Every URL gets a platform signature first.** Listing formats, caching failures, error messages, and download routing must all use that signature — never one global path that mixes Instagram errors with YouTube URLs.

```
URL → normalizeFormatUrl() → detectMediaSource() → handler → MediaFormat[] → download by FormatKind
```

---

## Key files

| Layer | File | Role |
|-------|------|------|
| Signatures & errors | `backend/src/lib/server/formatSources.ts` | `MediaSource`, `FormatKind`, `detectMediaSource`, `failReasonForSource`, `isManifestFormatUrl` |
| Format listing | `backend/src/lib/server/extractor.ts` | `listFormats`, per-source yt-dlp races, MediaFire resolver, `normalizeFormatUrl` |
| Download jobs | `backend/src/lib/server/ws.ts` | `LIST_FORMATS`, `NEW_DOWNLOAD`, manifest re-extract, referer |
| Extension cache | `extension/static/background.js` | `normalizeFormatUrl`, format cache, prefetch vs user `force` |
| Badges & menu | `extension/static/content.js` | Badge scan, `normalizeBadgeKey`, format menu, manifest skip on `directUrl` |
| Page intercept | `extension/static/inject-intercept.js` | MAIN-world XHR/anchor hook (OmniSave / axios sites) |

Tests: `backend/tests/formatSources.test.ts`, `backend/tests/extractor.test.ts`

---

## Platform signatures (`MediaSource`)

Detected in `formatSources.ts` → `detectMediaSource(url)`:

| Signature | Host patterns | List formats | Download notes |
|-----------|---------------|--------------|----------------|
| `youtube` | `youtube.com`, `youtu.be` | yt-dlp + **`--js-runtimes node`** (required for YouTube JS challenges); Chrome → Chromium → player clients `android`/`web`/`ios` → no cookies | Progressive googlevideo URLs need **referer** = watch page |
| `instagram` | `instagram.com` | yt-dlp + cookies; try **Chrome first**, then Chromium; `/p/` and `/reel/` variants | Carousel = playlist; cookies must match browser user actually uses |
| `tiktok` | `tiktok.com` | Generic yt-dlp race | Login often required |
| `twitter` | `twitter.com`, `x.com` | Generic yt-dlp race | |
| `mediafire` | `mediafire.com`, `download*.mediafire.com` | Page scrape → CDN direct URL | **Re-resolve on every download** (tokens expire) |
| `direct` | `.mp4`, `.mkv`, etc. on any host | Single “Direct” row | Rust engine range download |
| `generic` | Everything else | yt-dlp Chrome → Chromium → no cookies | Fallback |

**Adding a new signature (e.g. `moviebox`, `vimeo`):**

1. Add to `MediaSource` union in `formatSources.ts`
2. Extend `detectMediaSource()` with hostname rules
3. Add `failReasonForSource()` message (platform-specific, never generic cross-site text)
4. In `extractor.ts` → `listFormatsBySource()`:
   - **yt-dlp social** → `raceGenericYtDlpFormats` or dedicated race (copy `raceYoutubeFormats` / `raceInstagramFormats`)
   - **API / HTML scrape** → dedicated async resolver (copy `resolveMediafireDownload`)
   - **Preloaded CDN from extension** → no backend list; extension passes formats (see OmniSave below)
5. Add tests in `backend/tests/formatSources.test.ts`
6. Update this table in `AGENTS.md`

---

## Format kinds (`FormatKind`)

Each `MediaFormat` should set `source` and `kind` when known:

| Kind | Meaning | Download path |
|------|---------|---------------|
| `direct` | Stable file URL (CDN, MediaFire, intercept) | `NEW_DOWNLOAD` with `directUrl` → Rust engine |
| `progressive` | Single HTTP stream (typical yt-dlp `formats[].url`) | `directUrl` + `referer` / `pageUrl` |
| `manifest` | `.m3u8`, `.mpd`, DASH/HLS | **Do not** pass `directUrl`; backend runs `extractMediaUrl(pageUrl)` in `ws.ts` |
| `adaptive` | Reserved for video-only / audio-only pairs | Prefer merged format or yt-dlp `-f b` on download |

Extension rule (`content.js` → `renderFormatButtons`): if `fmt.kind === 'manifest'` or URL matches `.m3u8`/`.mpd`, omit `directUrl` so coordinator re-extracts.

---

## Cache & retry (do not break)

All three layers must use the **same normalized key** (`normalizeFormatUrl` / `normalizeBadgeKey`):

- YouTube: `https://www.youtube.com/watch?v=ID` (strip playlist params)
- Instagram: strip query + trailing slash
- One cache entry **per video/post** — resolving B must not delete A

| Event | Behavior |
|-------|----------|
| Background prefetch fails | Soft fail ~45s; **does not** block badge click |
| User clicks badge | `VELOCE_LIST_FORMATS` with **`force: true`** → clears fail cache, bypasses prefetch block, full platform retry |
| Backend fail cache | Stored with `source` + platform-specific `failReasonForSource`; TTL 90s (Instagram 5 min) |
| YouTube SPA navigate | `resetYoutubeCapture()` clears badges/scan attrs, **not** `localFormatCache` |

---

## Extension link behaviors (classifications)

### A — Social feed video (YouTube, Instagram, TikTok)

- **Problem:** `<video>` uses `blob:`; page URL is not the media URL.
- **Resolve:** Walk to card link (`findYoutubeWatchUrl`, `findPostUrl`).
- **Badge anchor:** YouTube thumbnail `<a>`, not shared hover-preview `<video>`.
- **Prefetch:** Skip Instagram prefetch on feed; YouTube sidebar uses per-card URL.
- **Files:** `content.js` (`processMediaElement`, `findYoutubeFeedCard`, `shouldBadgeYoutubeElement`)

### B — Direct file / CDN link

- **Detect:** `isDirectFileUrl`, `FILE_EXT` on `<a href>`.
- **Formats:** Single direct row from backend or `formatsFromDownloadAnchor`.
- **Download:** `directUrl` as-is; signed CDNs may need `referer` from `pageUrl`.

### C — MediaFire

- **Signature:** `mediafire`
- **List:** Scrape file page → CDN URL (`resolveMediafireDownload` in `extractor.ts`)
- **Download:** Always refresh CDN URL in `runDownloadJob` before engine spawn
- **Never** treat `www.mediafire.com/file/...` as direct

### D — OmniSave / MovieBox / netfilm (Class D intercept)

**Classification:** `intercept-preloaded` — formats come from the **site’s own API**, not yt-dlp.

| Piece | Location |
|-------|----------|
| Site registry | `extension/static/sites/registry.js` — `__veloceRegisterSite` / `__veloceCreateSiteHandlers` |
| YouTube handler | `extension/static/sites/youtube.js` — feed cards, watch/Shorts, playlists |
| Instagram handler | `extension/static/sites/instagram.js` — feed, post/reel, Stories |
| OmniSave / MovieBox | `extension/static/sites/omnisave.js` — download-modal intercept |
| MediaFire | `extension/static/sites/mediafire.js` — file page badge + CDN → page URL |
| Orchestrator | `extension/static/content.js` — badges, menu, scan loop; delegates to site handlers |
| XHR/fetch cache | `inject-intercept.js` hooks axios/fetch → `sessionStorage` key `veloce_omni_links` |
| Open menu | `openFormatMenu(..., preloadedFormats)` — skips `LIST_FORMATS` |
| Download | `directUrl` = API CDN link; `pageUrl` + `referer` = current tab |

**MovieBox flow (moviebox.ph, netfilm.world, videodownloader.site):**

1. Homepage — catalog only; **no download URLs**.
2. `/moviedetail/...` — metadata + “Watch Online”; still no CDN until player opens.
3. Player (`netfilm.world/spa/videoPlayPage/...`) — open **Download Options** modal; site calls `h5-api.aoneroom.com/wefeed-h5api-bff/subject/download`.
4. Veloce caches `list[]` → video qualities, `captions`/`extCaptions[]` → subtitles.
5. Click quality or subtitle in modal → Veloce menu with filename `{Title}_{720p|English}.ext`.

**Adding a new well-known site:**

1. Create `extension/static/sites/<name>.js` exporting `create<Name>Site(ctx)` via `__veloceRegisterSite`
2. Add the file to `manifest.json` `content_scripts` **before** `content.js`
3. Implement handler methods used by `content.js` (`isHost`, `scan`, `processMediaElement`, etc. — copy from YouTube/Instagram)
4. Document in the site registry table below

**API response shape (v2):** `{ list: [{ resourceLink, resolution }], captions: [{ lanName, url }] }` or `{ downloads, captions }`.

### E — Trap / redirect URLs

- **Detect:** `isTrapDownloadUrl`, `isInterceptTrapUrl` (redirect, `/api/`, graphql)
- **Behavior:** Fail with message to use in-page badge/intercept, not raw URL

---

## Site registry (maintain this)

| Site / family | Signature | Behavior class | Format source | Notes |
|---------------|-----------|----------------|---------------|-------|
| YouTube | `youtube` | A | yt-dlp `-J` | Card-scoped watch URL; **watch page** badge on `#movie_player video`; SPA `v=` changes reset badges + prefetch focus; **no sidebar prefetch** on watch (main player only); radio `list=RD…` stripped to `watch?v=ID` |
| Instagram | `instagram` | A | yt-dlp + cookies | **Feed:** `main article`. **Post/reel page** (`/p/ID`, `/reel/ID`): badge on main viewer `video` (URL from address bar). **Stories:** `/stories/user/ID`. Photo-only = no badge. **No prefetch** on feed. |
| TikTok | `tiktok` | A | yt-dlp | Dedicated handler `sites/tiktok.js`: card-scoped permalink anchor (not center hit-testing, which TikTok's overlay UI blocks); feed-scroll prefetch like YouTube sidebar |
| X/Twitter | `twitter` | A | yt-dlp | Dedicated `sites/twitter.js` resolves `blob:`-sourced timeline/permalink video to the tweet's `/status/ID` URL |
| MediaFire | `mediafire` | C | HTML scrape | Re-resolve each download |
| OmniSave / videodownloader.site | — | D | Site API (XHR/fetch) | `inject-intercept.js` + modal |
| MovieBox / netfilm.world | — | D | `subject/download` API | Same as OmniSave; player page + Download Options modal |
| Generic CDN `.mp4` | `direct` | B | Direct | |

When you implement a new row, **save the link behavior class and handler here** before merging.

---

## Site DOM layouts (fetch before changing handlers)

Agents working on a site should **inspect the live DOM** (DevTools → Elements, including shadow roots) and note anchors here. URLs in the table are canonical Veloce keys (`normalizeBadgeKey` / `normalizeFormatUrl`).

### YouTube (`extension/static/sites/youtube.js`)

| Page | DOM anchor | Badge target | Resolved URL |
|------|------------|--------------|--------------|
| Homepage / feed | `ytd-rich-item-renderer`, `ytd-video-renderer`, `yt-lockup-view-model`, … | Thumbnail `<a id="thumbnail">` inside card (shadow DOM) | `https://www.youtube.com/watch?v=ID` or `/shorts/ID` |
| Watch | `#movie_player` → `video.html5-main-video` | Main player `<video>` | `watch?v=ID` — **strip** `list`, `start_radio`, `index` |
| Watch sidebar | `ytd-watch-next-secondary-results-renderer` cards | Same feed-card rules as homepage | Per-card `watch?v=OTHER` (not playlist URL) |
| Shorts | `ytd-shorts` → `#shorts-container` video | Main shorts player | `/shorts/ID` |
| Radio / mix | `watch?v=X&list=RDX&start_radio=1` | Main player only for prefetch | Always `watch?v=X` for yt-dlp |

**SPA navigation:** YouTube updates `history` and fires `yt-navigate-finish` when the `v` param changes (sidebar click, autoplay next). Veloce must reset badges and prefetch the new `v` — see `onWatchVideoChanged()` + `hookNavigation()`.

**Do not badge:** `ytd-video-preview` hover previews, miniplayer, sandboxed ad iframes.

### Instagram (`extension/static/sites/instagram.js`)

| Page | DOM anchor | Badge target | Resolved URL |
|------|------------|--------------|--------------|
| Feed | `main article` | Primary `video` or post link | `/p/ID`, `/reel/ID` |
| Post/reel | `video` in viewer | Main `video` | From address bar |
| Reels tab | `/reels/` or `/reels/ID` | Playing reel `video` | `/reel/ID` (normalize `reels` → `reel`) |
| Stories | `/stories/user/ID` | Largest story `video` | `/stories/user/ID` |

**Prefetch:** Reels/post viewer only when reel **starts playing**; keep previous reel in prefetch window (2 slots).

### TikTok (`extension/static/sites/tiktok.js`)

| Page | DOM anchor | Badge target | Resolved URL |
|------|------------|--------------|--------------|
| For You / profile feed | `[data-e2e="recommend-list-item-container"]`, `[data-e2e="explore-item"]`, `[data-e2e="user-post-item"]`, or (markup-drift fallback) nearest ancestor holding exactly one `a[href*="/video/"]` | Card's `video` element | `https://www.tiktok.com/@user/video/ID` |
| Video permalink page | `/@user/video/ID` | Main `video` | From address bar |

**Badge anchor is resolved structurally** (walk to the card's own permalink `<a>`), never by hit-testing a point in the card — TikTok's like/comment/share rail and caption overlay sit over the center of the card and block point hit-testing (see "Feed tiles" note in `content.js` `isElementForeground`).

**Prefetch:** feed cards get the standard scroll-near-viewport prefetch (same as YouTube sidebar); SPA route changes (`pushState`/`popstate`) reset badges and refocus prefetch on the new permalink via `tt?.hookNavigation?.()` (wired alongside the `yt`/`ig`/`mf` handlers in `content.js`).

### X/Twitter (`extension/static/sites/twitter.js`)

| Page | DOM anchor | Badge target | Resolved URL |
|------|------------|--------------|--------------|
| Timeline | `[data-testid="tweet"]` / `article[role="article"]` card | Card's `video` (blob-sourced) | `https://x.com/user/status/ID` (prefers the tweet's own timestamp-linked status anchor over a nested quote-tweet's) |
| Single-tweet permalink | `/user/status/ID` | Main `video` | From address bar |

**Badge anchor is resolved structurally** (walk up from the `<video>` to its tweet article, then find the best `a[href*="/status/"]` inside it — scored higher if it wraps a `<time>` element, to prefer the real tweet's timestamp link over a nested quote-tweet's), not by reading `video.src` — X streams via `blob:`/MSE so the element's own `src` is never the real media URL.

### MediaFire (`extension/static/sites/mediafire.js`)

| Page | DOM anchor | Badge target | Resolved URL |
|------|------------|--------------|--------------|
| File page | `www.mediafire.com/file/{key}/{name}/file` | `#downloadButton`, `#click_download`, `.download_link`, or `.dl-info` | Same file page URL (backend scrapes CDN) |
| CDN link | `download{N}.mediafire.com/...` | N/A (intercept only) | Map back to file page URL |

**Note:** Download button appears after "Preparing Download" — poll every 600ms until visible. Do not treat CDN URLs as the badge key.

---

## Backend API quick reference

### `LIST_FORMATS`

```json
{ "type": "LIST_FORMATS", "requestId": "uuid", "payload": { "url": "https://...", "force": true } }
```

- `force: true` — user badge click; ignore fail cache, run full platform retry
- Response: `{ "type": "FORMATS_LIST", "formats": [{ "id", "label", "url", "ext", "source?", "kind?" }] }`

### `NEW_DOWNLOAD`

```json
{
  "type": "NEW_DOWNLOAD",
  "payload": {
    "url": "page or canonical URL",
    "directUrl": "optional — omit for manifest or page-only extract",
    "pageUrl": "tab URL for referer",
    "referer": "same as pageUrl for CDNs",
    "fileName": "name.mp4",
    "ext": ".mp4"
  }
}
```

---

## Checklist for agents

- [ ] New hostname added to `detectMediaSource` + `failReasonForSource`
- [ ] Cache key uses `normalizeFormatUrl` in backend **and** extension
- [ ] Prefetch failures marked `prefetch: true` (background.js) — never 5‑min block
- [ ] User click sends `force: true`
- [ ] Error text matches **URL platform**, not last failed site
- [ ] Manifest formats omit `directUrl` in extension
- [ ] MediaFire / expiring CDN re-resolved in `runDownloadJob`
- [ ] Intercept sites documented in **Site registry** above
- [ ] Tests added/updated in `backend/tests/`

---

## Desktop Native App (Phase 3 — Tauri 2 + Rust coordinator)

> **CRITICAL RULE**: Any logic change made in the `backend/` (Node.js) MUST also be replicated and tested in the `desktop/` (Tauri/Rust) app so that both coordinators stay perfectly in sync. Always test changes thoroughly in both environments!


### Architecture (`desktop/`)

```
desktop/
├── src/                         # Svelte 5 frontend
│   ├── main.ts                  #   Entry point
│   ├── app.css                  #   Veloce design tokens
│   └── App.svelte               #   Dashboard + History + Settings
└── src-tauri/                   # Rust backend
    ├── tauri.conf.json          #   Window + bundle config
    ├── capabilities/default.json
    ├── icons/                   #   App icons (32, 128, 256px)
    └── src/
        ├── main.rs              # Binary entry
        ├── lib.rs               # Tauri commands :: list_formats, start_download, cancel, pause
        ├── config.rs            # Env-based Config (VELOCE_PORT, etc.)
        ├── db.rs                # SQLite (rusqlite bundled): devices, downloads, playlist_jobs
        ├── engine.rs            # core_engine process spawn + progress reader
        ├── formats.rs           # MediaSource enum, MediaFire resolver, FormatCache, Lazy<Regex>
        ├── scheduler.rs         # FIFO queue with concurrency cap
        ├── state.rs             # AppState: active_engines, cancellation_flags, progress
        ├── util.rs              # format_bytes, find_core_engine, find_ytdlp (runtime paths)
        └── ytdlp.rs             # yt-dlp list_formats, extract_best_url, parse_playlist
```

### IPC: Tauri Commands (invoke) + Events (emit/listen)

| Command | Purpose |
|---------|---------|
| `list_formats` | List yt-dlp formats for a URL (cached 10 min) |
| `start_download` | Spawn engine, insert into `active_engines`, monitor in bg thread |
| `cancel_download` | Set cancellation flag + kill child process |
| `pause_download` | Kill child (state preserved for resume) |
| `get_statuses` | Snapshot of all active downloads |
| `get_history` | Last 50 completed/failed downloads |
| `get_settings` / `update_settings` | Device settings CRUD (merged desktop+extension; folder picker via `select_directory`) |
| `select_directory` | Native zenity/kdialog folder picker; syncs Save-to for extension |
| `queue_playlist` / `list_playlists` | Start playlist from desktop UI; hydrate playlist panel |
| `get_config` | Runtime config (port, threads, etc.) |

**Events:** `download-progress` (id, downloaded, total, speed, eta, pct), `download-status` (id, status, error?)

### Engine Lifecycle (race-safe)

1. `start_download` spawns core_engine, inserts into `active_engines` (std Mutex), adds `cancellation_flags`
2. Monitoring thread takes ownership, calls `engine.wait()` (blocks)
3. `cancel_download` sets AtomicBool flag + kills child (if still in map)
4. After `wait()` returns, monitoring thread checks flag → "cancelled" vs "completed"/"failed"
5. Engine removed from map only after `wait()` returns

### Platform Independence

- Binary discovery: `std::env::current_exe()` → sibling `binaries/` → Tauri sidecar → project build → PATH
- All deps cross-platform (tokio, rusqlite bundled, reqwest, tauri)
- Frontend uses Tauri IPC — no WebSocket dependency
- Linux: GTK3 + WebKitGTK; Windows: WebView2; macOS: WKWebView

### Key Design Decisions

- **Engine not in map during wait**: Monitoring thread owns the engine; cancellation uses separate flag map
- **Std Mutex for engines**: Accessed from both async commands and blocking threads
- **Tokio Mutex for progress**: Only accessed from async context
- **Runtime handle captured before spawn_blocking**: Avoids `Handle::current()` panic
- **Runtime binary paths**: `find_core_engine()` / `find_ytdlp()` use `current_exe()` first, fall back to `env!("CARGO_MANIFEST_DIR")` for dev builds

---

## Core engine (`core_engine/`)

Range downloader binary spawned by desktop + Node. Full notes: [`core_engine/README.md`](core_engine/README.md).

| Guard / feature | Detail |
|-----------------|--------|
| Redirect SSRF | `safety::safe_redirect_policy` — no private/loopback/metadata hosts |
| URL check | `safety::is_safe_download_url` on CLI URL; coordinators re-check **post-extract** (yt-dlp / MediaFire) |
| Threads | Clamped **1..=64** in engine `normalize()` and desktop/backend spawn |
| Size / pieces | Max **512 GiB**, max **1M** pieces |
| Piece writes | Stream clamped to piece end (no neighbour overrun) |
| `--base-dir` | Save path must resolve under download root |
| Sidecar / resume | Hidden `{parent}/.veloce/{name}.state|.done` (legacy adjacent files migrated); soft ETag/LM (tokenized CDNs); delete state on complete |
| Quiet / origin | `--quiet` via `elog!`; `--origin` from referer (desktop + backend) |
| Auto-tune | Sequential probe + historic max speed memory (no permanent decay); skip for MediaFire/Direct/GitHub at coordinator |

**Key modules:** `safety.rs`, `logutil.rs`, `discover.rs`, `probe.rs`, `download.rs`, `resume.rs`, `io_uring_writer.rs`

---

## Version

Extension manifest version and notable behavior changes should be noted in commit messages. Current format-handling architecture: **v1.4.7+** (platform signatures in `formatSources.ts`).

Desktop native app (Phase 3): **v0.1.0** (Tauri 2 + Rust coordinator rewrite).

Core engine hardening: **redirect SSRF, thread clamp, base-dir, size caps, quieter logs** (see `core_engine/README.md`).
