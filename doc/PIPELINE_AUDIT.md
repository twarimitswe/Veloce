# Veloce pipeline audit — memory, modularity, reliability

**Scope:** extension → coordinator (Node `backend/` and Rust `desktop/`) → `core_engine`.
**Date:** 2026-08-31.
**Companion doc:** [`CHANGES_APPLIED.md`](CHANGES_APPLIED.md) — before / change / after for every item fixed here.

Severity: **P0** build/correctness · **P1** user-visible memory or reliability · **P2** maintainability / drift risk.

---

## A. Memory is over-exploited

### A1 — Unbounded format/fail caches in the extension service worker · P1
`formatCache`, `formatFailCache`, `inflightFormatUrls`, `prefetchQueued`, `pendingFormatRequests`, `downloads{}` in `extension/static/background.js:26–42` only grow. TTL is checked on read, never swept, and there is no max size. A long YouTube/Instagram session lists formats for hundreds of videos; each entry is an array of format objects carrying multi-KB signed CDN URLs, retained until the SW is killed.
**Fix:** cap each map (LRU) and evict expired/oldest on insert.

### A2 — Unbounded caches in the content script · P1
`badges`, `badgeKeys`, `dismissedBadges`, `localFormatCache`, `prefetchStarted` in `extension/static/content.js:589–604` live for the tab's lifetime. `pruneBadges` only drops badges whose DOM root disconnected (every 30 s, `content.js:2236`); `dismissedBadges` never clears. On infinite-scroll feeds this is a slow leak of DOM refs + format arrays.
**Fix:** LRU-cap `localFormatCache` / `prefetchStarted` / `dismissedBadges`; trim `prefetchStarted` on SPA navigation.

### A3 — yt-dlp process fan-out in the Node coordinator · P1 (largest offender)
`raceYoutubeFormats` spawns 1 primary + up to **4 parallel** `yt-dlp -J` (`extractor.ts:568–621`); `raceInstagramFormats` up to **5 parallel** fallbacks (`:487–539`); `raceGenericYtDlpFormats` **3 parallel** (`:623–665`). Each child is ~50–150 MB RSS and accumulates full `-J` JSON via `output += data.toString()` with no length ceiling (`:748`). The Node side has **no global concurrency cap** (the SW's `PREFETCH_LIMIT = 2` does not bound the backend). A `force:true` click during two prefetches plus a merge download can put a dozen yt-dlp processes in flight on a low-RAM box — simultaneously the memory spike and the "format list timed out" failure.
**Fix:** global semaphore (≤3) around every yt-dlp spawn; abort a child whose stdout exceeds ~24 MB; cap the parallel fallback set to 2.

### A4 — Unbounded caches in the Node coordinator · P1
`formatCache`, `failCache`, `bestUrlCache`, `mediafireCdnCache`, `ytDlpErrorLogged` (`extractor.ts:98–102,176,197,947–951`) grow for the life of the `pnpm dev` / bundled process.
**Fix:** shared bounded-map helper (LRU + TTL sweep on insert).

### A5 — Unbounded fail cache in the Rust coordinator · P1
`FORMAT_FAIL_CACHE` static (`desktop/src-tauri/src/download.rs:22–23`) never evicts; `AppState.format_cache` / `best_url_cache` (`state.rs:117–118`) are `FormatCache::new(600)` — TTL only, no entry cap — and this process is a long-lived tray app.
**Fix:** cap `FORMAT_FAIL_CACHE`; give `FormatCache` a max-entries bound.

### A6 — Blob save copies an 80 MB file 4–5× · P1
`blob:`/`data:` intercept path: page `fetch` → `arrayBuffer` → chunked `String.fromCharCode` binary string → `btoa` → `chrome.runtime.sendMessage` (structured clone) → SW base64 → WS frame → Node `Buffer.from(base64)` (`content.js:1163–1187`, `background.js:963–1026`, `ws.ts:841–917`). Transient cost ≈ 400 MB across three heaps for a single 80 MB blob; the `String.fromCharCode` build happens in the page heap.
**Fix (deferred, see CHANGES §Deferred):** stream blob bytes to the coordinator instead of base64-over-`sendMessage`. Interim: lower `MAX_BLOB_BYTES` and document.

### A7 — core_engine write buffers scale with `--threads` · P1
Per worker: `buf: Vec::with_capacity(read_buffer_bytes)` **plus** an `IoUringEngine` whose `pending: Vec<PendingWrite>` is sized `BATCH_SIZE * 2 = 16` owned `Vec<u8>` of ~`read_buffer_bytes`, flushed at 8 (`engine.rs:478,518`, `io_uring_writer.rs:28,101,115–121`). At the 64-thread ceiling with the 256 KiB default that is ≈ 140 MiB of transient write buffers; it multiplies if `engine_read_buffer_bytes` is raised or several downloads run at once.
**Fix:** size `pending` to `BATCH_SIZE` (halves the worst case). `IORING_SETUP_SQPOLL` per-worker kernel thread and per-download `piece_metrics` retention are noted as follow-ups.

---

## B. Not modular — a change to one site breaks others

### B1 — Desktop coordinator does not compile (committed) · P0
`desktop/src-tauri/src/download.rs` builds and reads `JobState { …, threads: Some(job_threads) }` / `job.threads` (`:615,803–806`) and `scheduler.rs`'s own tests use `threads: None` (`:141,270,286,302`), but the `JobState` struct at `scheduler.rs:8–24` has **no `threads` field**. This is committed at HEAD. It is the concrete instance of "hand-maintained parity between two coordinators drifts and breaks."
**Fix:** add `#[serde(default)] pub threads: Option<u32>` to `JobState`.

### B2 — `normalizeFormatUrl` implemented four times · P2
`background.js:93`, `content.js:377` (`normalizeBadgeKey`), `extractor.ts:200`, `desktop formats::normalize_url`. They must produce byte-identical keys or the prefetch → cache → click handshake silently misses and every click re-runs yt-dlp. Nothing pins them together.
**Fix:** add a parity test that pins the canonical outputs (`backend/tests/normalizeParity.test.ts`); mirror it in Rust; document the canonical rules in `doc/SITE_MODEL.md`.

### B3 — Site knowledge is half in the handler, half in `content.js` · P2
`VIDEO_SITES` / `CDN_IMAGE` regexes, `needsFormatPicker` (`mediafire.com`, `googlevideo.com` literals), `resolveDownloadUrl`'s Instagram branch, `normalizeBadgeKey`'s generic branch, `findBadgeRoot`'s Instagram DOM walk (`content.js:23–26,300–331,377–394,417–427`). Adding a site edits `content.js` **and** the handler **and** `manifest.json` **and** `formatSources.ts` **and** `extractor.ts` **and** two Rust files.
**Fix (documented, partial):** `doc/SITE_MODEL.md` defines the target — one descriptor per platform consumed identically by all three layers. Full extraction is a larger refactor (see CHANGES §Deferred).

### B4 — `ctx` object leaks coordinator internals to site handlers · P2
`content.js:2182–2222` hands handlers ~40 fields including raw mutable maps (`badges`, `badgeKeys`, `dismissedBadges`, `cardIo`, `igCardIo`, `watchElement`, `resetScanStateDeep`). Any refactor of `content.js` internals breaks every handler; a buggy handler corrupts shared badge state.
**Fix (documented):** shrink to a stable façade (`placeBadge`, `openMenu`, `prefetch`, `getSetting`). Deferred — behavioural risk on the YouTube/Instagram handlers.

### B5 — Two full coordinator implementations kept in sync by hand · P2
`AGENTS.md`: *"Any logic change in backend/ MUST also be replicated and tested in desktop/."* `detectMediaSource`, fail-cache TTLs, referer rules, the merge-vs-direct decision tree (`ws.ts:429–624` vs `download.rs:262–375,646–1034`), `isInstagramSilentDashUrl` (TS + Rust), manifest detection (4 copies). B1 is the proof this drifts.
**Fix (recommendation only):** collapse to one — Node coordinator as a Tauri sidecar (plan Phase 1/2), or finish the Rust port and delete `backend/`. Out of scope for this pass; see CHANGES §Deferred for the migration outline.

---

## C. Not reliable when you click and download

### C1 — Native download is cancelled before the replacement menu is confirmed · P1
`chrome.downloads.onCreated` calls `chrome.downloads.cancel(item.id)` (`background.js:1119–1124`) **then** `openInterceptFormatMenu` → `chrome.tabs.sendMessage` (`:1137`). If the content script is not in that tab (tab just opened, or an extension reload orphaned it) the message throws, a Chrome notification fires, and the user's download is gone. The "don't cancel on failure" safety exists only for the blob branch (`:1097–1099`).
**Fix:** open the menu first; only `cancel` when it returns `true`; otherwise leave the native download running.

### C2 — `reconcileInterrupted` re-queues permanently-stuck rows every startup · P1
`ws.ts:1031–1045` (and `desktop/src-tauri/src/ws.rs:158–184`) re-queue every `downloading`/`queued` row on boot. A dead URL or a missing engine binary re-fails on every coordinator restart, and a row that never had bytes churns forever.
**Fix:** only reconcile rows with real on-disk progress (partial file, resume sidecar, or `downloadedBytes > 0`); mark the rest `error` once so the user can retry deliberately.

### C3 — A warm-cache `directUrl` can be an expired signed CDN URL · P1
The extension seeds `localFormatCache`; clicking "Best" sends `directUrl` when `!!fmt.url && !manifest` (`content.js:1632`). Minutes-old `expire=` → engine 403 → `failure_kind_from_status(403) = Permanent` (`download.rs:59` in engine) → AIMD slams concurrency to 1, or `RANGE_IGNORED_ABORT_AFTER = 3` aborts (`engine.rs:411–412,660`) → job errors "CDN token expired, cancel and retry." `bestUrlCache` (10 min / 5 min IG) can re-serve the same stale URL on the manual retry.
**Fix:** in `runDownloadJob`, when a job that used `spec.directUrl` fails with an expired-CDN / range-ignored signature on its first attempt, drop `directUrl`, evict `bestUrlCache`, and re-run once via fresh extraction before surfacing the error.

### C4 — Multi-hop click→formats path with many silent-abort points · P2
Badge click → `VELOCE_PEEK_FORMATS` → `VELOCE_LIST_FORMATS force:true` → SW `listFormats` (50 s timeout, `background.js:786`) → WS → backend race (12–28 s/attempt) → yt-dlp (`--socket-timeout 12`). The content menu discards a late result when `epoch !== menuEpoch || pendingMenuUrl !== badgeKey` (`content.js:1817,1886`); a YouTube SPA nav or rescan bumps `menuEpoch`, so the menu can sit on "Loading formats…" forever with no error.
**Fix (partial):** A3 removes the main cause (yt-dlp thrash → 50 s timeout). A dedicated "menu re-anchor keeps its pending request" change is noted as follow-up.

### C5 — WS link has two implementations and a flappy connected-state · P2
`background.js` runs either a legacy SW socket or an offscreen-document socket (`useOffscreenWs`), with `wsSend` (sync, deprecated) vs `wsSendAsync`; `ensureOffscreenDocument` has a documented create race (`:77–89`); `connected` can disagree with reality (reconciliation in `VELOCE_GET_STATE`, `:1163–1171`). A click during SW cold-start or a socket flap → `startDownload` returns `false` → "backend offline" toast while the coordinator is up.
**Fix (recommendation only):** delete the legacy SW-socket path; the offscreen document is always available on MV3 targets Veloce supports. Deferred — needs manual cross-browser testing.

### C6 — core_engine bypassed for most YouTube/Instagram video · P2
`runDownloadJob` / `resolve_download_url` prefer a single muxed `best[vcodec!=none][acodec!=none]`; when only DASH split A/V exists they fall to `startMergedYtDlpDownload` (yt-dlp + ffmpeg). If `ffmpeg` is not at `backend/bin/ffmpeg` the job dies with a paragraph-long shell-command error (`extractor.ts:1378–1385`). The Rust range engine — the project's headline feature — does not run for the common case.
**Fix (recommendation only):** teach `core_engine` to fetch two URLs and mux via a bundled ffmpeg, or make the "ffmpeg missing" error a single actionable line. Deferred.

### C7 — Pause/cancel has 3–4 sources of truth · P2
Node: `running` map `intent`. Rust: `active_engines` + `cancellation_flags` + a 100 ms `try_wait` poll thread + `db.status` + in-memory `progress.status` (`download.rs:858–1017`). A cancel between `spawn` and map-insert, or between `wait()` returning and cleanup, can leave a zombie engine or a row wedged `downloading`. `SESSION_DOCUMENTATION.md` already lists a run of fixes here.
**Fix (recommendation only):** single owned state machine per job. Deferred.

---

## Fix status in this pass

| ID | Severity | Status |
|----|----------|--------|
| A1 | P1 | Fixed — LRU + sweep in `background.js` |
| A2 | P1 | Fixed — bounded maps in `content.js` |
| A3 | P1 | Fixed — global yt-dlp semaphore + stdout cap + fallback cap in `extractor.ts` |
| A4 | P1 | Fixed — `boundedMap` helper for all five caches |
| A5 | P1 | Fixed — `FORMAT_FAIL_CACHE` cap + `FormatCache` max-entries |
| A6 | P1 | Deferred (interim: `MAX_BLOB_BYTES` lowered + documented) |
| A7 | P1 | Fixed — `pending` sized to `BATCH_SIZE` |
| B1 | P0 | Fixed — `JobState.threads` added |
| B2 | P2 | Fixed — parity test added (`normalizeParity.test.ts`) + `SITE_MODEL.md` |
| B3 | P2 | Documented — `SITE_MODEL.md` |
| B4 | P2 | Deferred |
| B5 | P2 | Deferred (migration outline in CHANGES) |
| C1 | P1 | Fixed — menu-first, cancel-on-confirm in `background.js` |
| C2 | P1 | Fixed — progress-gated reconcile in `ws.ts` + `ws.rs` |
| C3 | P1 | Fixed — one fresh-extract retry on expired-CDN in `runDownloadJob` |
| C4 | P2 | Partially addressed via A3 |
| C5 | P2 | Deferred |
| C6 | P2 | Deferred |
| C7 | P2 | Deferred |
