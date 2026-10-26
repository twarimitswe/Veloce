# Veloce pipeline audit — changes applied

Companion to [`PIPELINE_AUDIT.md`](PIPELINE_AUDIT.md) (the issue catalogue) and
[`SITE_MODEL.md`](SITE_MODEL.md) (the cross-layer contract).

**Date:** 2026-08-31.
**Files changed:** `core_engine/src/io_uring_writer.rs`, `backend/src/lib/server/extractor.ts`,
`backend/src/lib/server/ws.ts`, `backend/tests/normalizeParity.test.ts` (new),
`extension/static/background.js`, `extension/static/content.js`,
`desktop/src-tauri/src/{scheduler.rs,download.rs,formats.rs,ws.rs}`, plus the three docs.

**Only `extension/static/` was edited** — `extension/build/*` is a checked-in build
artifact (already stale before this work) and must be regenerated with
`cd extension && pnpm build`.

---

## Verification run in this environment

| Suite | Command | Result |
|---|---|---|
| Node coordinator | `cd backend && node_modules/.bin/vitest run` | **72 passed** (was 58; +14 new parity cases) |
| Core engine | `cargo test --manifest-path core_engine/Cargo.toml --release` | **42 passed** (40 unit + 2 integration), builds clean |
| Node typecheck | `cd backend && npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Extension | `node -c background.js && node -c content.js` | syntax OK |
| Desktop coordinator | `cargo check --manifest-path desktop/src-tauri/Cargo.toml` | **not run** — this box lacks the GTK/WebKit system dev packages Tauri's `-sys` build scripts need (`pkg-config`, `gio-2.0`). Rust edits reviewed against surrounding code; must be confirmed in CI / on a dev box. |

---

## P0 — build / correctness

### B1 · `desktop` did not compile — `JobState` missing `threads`

**Before.** `desktop/src-tauri/src/download.rs` builds `JobState { …, threads: Some(job_threads) }`
(`:615`) and reads `job.threads` (`:803`), and `scheduler.rs`'s own tests pass
`threads: None`, but `JobState` (`scheduler.rs:8–24`) had no `threads` field. This
is the committed state at HEAD — `cargo build` fails.

**Change.** `desktop/src-tauri/src/scheduler.rs` — added the field:

```rust
/// Optional per-job connection count from the extension payload (`payload.threads`).
#[serde(default)]
pub threads: Option<u32>,
```

**After.** Struct matches every construction and read site. `#[serde(default)]`
keeps snapshot/serialised `JobState` blobs from older builds loadable.

---

## P1 — memory

### A1 · Extension SW format caches unbounded → `background.js`

**Before.** `formatCache` / `formatFailCache` were plain `Map`s; one entry per
video/post ever hovered, never evicted, each holding multi-KB signed CDN URLs.

**Change.** Added a `BoundedMap extends Map` (FIFO-evicts the oldest key past
`capacity`) and used it: `new BoundedMap(300)` for both. Per-entry TTL is still
enforced on read, so nothing stale surfaces — this only caps footprint (~300 ×
a few KB).

**After.** SW format-cache memory is bounded regardless of session length.

### A2 · Content-script caches unbounded → `content.js`

**Before.** `localFormatCache` (`Map`), `prefetchStarted` (`Set`),
`dismissedBadges` (`Set`) lived for the tab's lifetime; on infinite scroll they
grew per item forever.

**Change.** Added `BoundedMap` / `BoundedSet` inside the content IIFE:
`localFormatCache = new BoundedMap(200)`, `prefetchStarted = new BoundedSet(400)`,
`dismissedBadges = new BoundedSet(400)`. A re-prefetch or a re-shown dismissed
badge after hundreds of items is harmless.

**After.** Content-script cache growth is bounded on long feeds.

### A3 · yt-dlp process fan-out in the Node coordinator → `extractor.ts`

**Before.** `raceYoutubeFormats` (1 + 4 parallel), `raceInstagramFormats` (up to
5 parallel), `raceGenericYtDlpFormats` (3 parallel), plus best-URL extraction,
playlist listing and merge downloads — **no global cap**. A `force` click during
two prefetches plus a merge could run ~12 `yt-dlp` processes at once (~50–150 MB
RSS each), thrashing a low-RAM box into the 50 s SW timeout. `output += …` had no
length ceiling, so a pathological `-J` blob could balloon Node's heap.

**Change.**
- Added a global counting semaphore `acquireYtdlpSlot()` with
  `YTDLP_MAX_CONCURRENT = 3`. Every yt-dlp spawn path acquires a slot before
  `spawn` and releases on completion / kill / timeout: `runYtDlpJson`,
  `runYtDlp` (`-g`), `runYtDlpPlaylistJson`, and each attempt inside
  `startMergedYtDlpDownload`. Extra attempts queue instead of spawning; a
  race that already won releases queued slots on `kill()`.
- Added `YTDLP_MAX_STDOUT_BYTES = 24 MiB`: any child whose stdout exceeds it is
  killed and treated as a failed attempt.
- Trimmed queued fallback breadth: YouTube `attempts.slice(1, 5)` → `slice(1, 4)`,
  Instagram `fallbackJobs.slice(0, 5)` → `slice(0, 4)`.
- `ytDlpErrorLogged` Set: `if (size > 500) clear()` before adding.

**After.** At most 3 concurrent yt-dlp processes across the whole coordinator;
peak extractor RSS is bounded and predictable. Under heavy load a click is
slower (queued) rather than OOM/timeout. `runYtDlpJson` was restructured so the
spawn happens inside the slot callback; `done()` always releases the slot, and a
`kill()` issued while an attempt is still queued abandons it without spawning.

### A4 · Node coordinator caches unbounded → `extractor.ts`

**Before.** `formatCache`, `failCache`, `bestUrlCache`, `mediafireCdnCache` were
plain `Map`s growing for the life of the process.

**Change.** All four now `new BoundedMap(N)` — `formatCache`/`failCache`/`bestUrlCache`
= 400, `mediafireCdnCache` = 200. `BoundedMap` is a 12-line `extends Map` with
FIFO eviction on insert.

**After.** Coordinator cache footprint is bounded; callers' TTL checks unchanged.

### A5 · Rust coordinator caches unbounded → `download.rs`, `formats.rs`

**Before.** `FORMAT_FAIL_CACHE` (static `HashMap`) and `FormatCache`
(TTL-only `HashMap`, used for `format_cache` and `best_url_cache`) grew for the
life of the always-on tray app.

**Change.**
- `download.rs` — new `record_format_fail(normalized, reason)` helper:
  `FORMAT_FAIL_CACHE_MAX = 500`; on overflow it sweeps entries older than a day,
  then evicts the single oldest by timestamp, then inserts. Both raw
  `.insert(...)` sites now call it.
- `formats.rs` — `FormatCache::set` gained the same guard:
  `FORMAT_CACHE_MAX_ENTRIES = 500`; sweep expired, then evict oldest by `ts`.

**After.** Both caches are hard-capped; long-running desktop memory is bounded.

### A7 · core_engine per-worker write buffers → `io_uring_writer.rs`

**Before.** `IoUringEngine.pending` was `Vec::with_capacity(BATCH_SIZE * 2)` (16),
but `write_at_owned` flushes at `len() >= BATCH_SIZE` (8), so the vector never
exceeds 8 entries — the 2× capacity just held ~`BATCH_SIZE × read_buffer_bytes`
of idle backing store per worker (≈ 2 MiB/worker at 64 threads × 256 KiB).

**Change.** `pending: Vec::with_capacity(BATCH_SIZE)`.

**After.** Worst-case per-worker write-buffer footprint roughly halved; 42
engine tests still pass, integration downloads unaffected.

### A6 · Blob save copies an 80 MB file 4–5× — **deferred**

Full fix (stream blob bytes to the coordinator instead of
base64-over-`chrome.runtime.sendMessage`) touches `content.js` + `background.js` +
both coordinators and needs manual testing of the AI-image / canvas-export paths.
Not done in this pass. Interim: no code change; the 80 MB cap and the multi-copy
path are documented in `PIPELINE_AUDIT.md` A6 for a follow-up.

---

## P1 — reliability

### C1 · Native download cancelled before the replacement menu is confirmed → `background.js`

**Before.** `chrome.downloads.onCreated` did `chrome.downloads.cancel(item.id)`
first, then `openInterceptFormatMenu` → `chrome.tabs.sendMessage`. If the content
script wasn't in that tab (just opened, or orphaned by an extension reload), the
message threw, a Chrome notification fired, and the user's download was gone.

**Change.** Reordered: build `listUrl`, call `openInterceptFormatMenu` **first**;
if it returns falsy, log "leaving native download running" and `return` without
cancelling; only on success do `chrome.downloads.cancel(item.id)`.

**After.** A tab that can't show the Veloce menu keeps its normal browser
download. Small window where the native download runs for the ~tens of ms until
the menu message lands — cancel still removes the partial `.crdownload`.

### C2 · `reconcileInterrupted` re-queues permanently-stuck rows every startup → `ws.ts`, `ws.rs`

**Before.** On boot, every `downloading` / `queued` row was re-queued. A dead URL
or missing engine binary re-failed on every restart; a row that never wrote a
byte churned forever.

**Change (both coordinators).** Before re-queuing, check for real progress:
`downloadedBytes > 0 || hasResumeState(savePath) || savePath exists`. Rows with
none of those are set to `error` / `failed` once, with
*"Interrupted before any data downloaded — click Retry."*, and skipped.

**After.** Only genuinely resumable jobs auto-resume; broken jobs surface for a
deliberate retry instead of silently re-failing each launch.

### C3 · Warm-cache `directUrl` can be an expired signed CDN URL → `ws.ts`

**Before.** The extension seeds `localFormatCache` and sends `directUrl` on a
"Best" click. Minutes-old `expire=` → engine 403 / range-ignored →
`FailureKind::Permanent` → job errors *"CDN token expired, cancel and retry"*.
`bestUrlCache` could re-serve the same stale URL on the manual retry.

**Change.** `JobSpec` gained `cdnRetried?: boolean`. Added
`looksLikeStaleCdnFailure(log)` (matches `ignored Range` / `CDN token expired` /
`ranges disabled` / `403` / `forbidden`). In `runDownloadJob`'s engine-`close`
handler, when the job used `spec.directUrl`, hasn't retried yet, and the failure
matches: evict `bestUrlCache` for the page URL (`removeBestUrlCache`, now
imported) and re-run `runDownloadJob({ …spec, directUrl: undefined,
cdnRetried: true })` **in the same scheduler slot** (no extra concurrency), then
`return` without surfacing the error. The nested attempt has `cdnRetried: true`
so it can't loop.

**After.** A stale direct URL self-heals once via fresh page extraction before
the user ever sees an error. The desktop-side equivalent is noted as a
follow-up in `PIPELINE_AUDIT.md` C3.

### C4 · Multi-hop click→formats path stalls on "Loading formats…" — partially addressed

The dominant cause (yt-dlp thrash → 50 s SW timeout) is removed by A3. The
separate "menu keeps its pending request across a re-anchor" change is still a
follow-up.

---

## P2 — modularity / drift

### B2 · `normalizeFormatUrl` drift → `backend/tests/normalizeParity.test.ts` (new), `SITE_MODEL.md`

**Before.** Four independent implementations (content script, SW, Node, Rust)
with nothing pinning them together. Found divergences: the Rust `normalize_url`
rewrites `youtube.com/shorts/ID` → `watch?v=ID` (extension + Node keep `/shorts/`)
and drops the query string for generic URLs (extension + Node keep it).

**Change.**
- New `normalizeParity.test.ts` pins the Node/reference output for 13 URL shapes
  (YouTube watch/shorts, Instagram p/reel/reels, generic CDN with query,
  trailing slash, non-URL) plus an idempotence check. 14 assertions, all green.
- `SITE_MODEL.md` §1 writes the canonical rules and flags the Rust deviation as a
  decision the maintainer must resolve (change `normalize_url` + its test, or
  change the spec).

**After.** A future edit that drifts the Node normaliser fails CI. The Rust
divergence is documented, not silently "fixed" blind (its own test pins the
current behaviour and the desktop suite can't run here).

### B3 · Site knowledge split between `content.js` and handlers → `SITE_MODEL.md`

Documented the full "adding a new site" checklist (6 files) and the target
(one declarative descriptor per platform consumed by all three runtimes).
No code moved in this pass — extracting the literals out of `content.js` is a
behavioural-risk refactor of the YouTube/Instagram handlers.

### B4 (ctx façade), B5 (merge the two coordinators), C5 (delete the legacy SW socket), C6 (engine-side mux), C7 (single job state machine)

**Deferred.** Each is an architectural change needing cross-browser or
cross-platform manual testing. Rationale and a starting point for each are in
`PIPELINE_AUDIT.md`. B5 is the highest-leverage: it's the root cause of B1 and
of the ongoing "change one, break the other" tax.

---

## Follow-ups (recommended order)

1. On a dev box: `cargo check` + `cargo test` the `desktop/` crate to confirm the
   B1 / A5 / C2 Rust edits, then add CI that runs it (would have caught B1).
2. Resolve the `normalize_url` shorts/query divergence (`SITE_MODEL.md` §1) and
   add the Rust mirror of `normalizeParity`.
3. Desktop-side C3 (stale-CDN re-extract in `start_engine_for_job`).
4. A6 blob streaming.
5. B5 coordinator unification.
