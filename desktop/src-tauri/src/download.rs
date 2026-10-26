use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tokio::sync::{Mutex as TokioMutex, broadcast};
use uuid::Uuid;

use crate::config::Config;
use crate::db;
use crate::engine::EngineProcess;
use crate::formats::{self, MediaFormat};
use crate::state::{AppState, DownloadStatus};
use crate::util;
use crate::ytdlp;

static FORMAT_INFLIGHT: Lazy<
    TokioMutex<HashMap<String, broadcast::Sender<Result<Vec<MediaFormat>, String>>>>,
> = Lazy::new(|| TokioMutex::new(HashMap::new()));

static FORMAT_FAIL_CACHE: Lazy<TokioMutex<HashMap<String, (String, u64)>>> =
    Lazy::new(|| TokioMutex::new(HashMap::new()));

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

/// Hard cap on `FORMAT_FAIL_CACHE`. This process is a long-lived tray app; without
/// a bound the fail cache grows one entry per failed URL forever.
const FORMAT_FAIL_CACHE_MAX: usize = 500;

/// Record a soft-fail with an entry cap: sweep entries older than a day, then
/// evict the single oldest if still full, before inserting.
async fn record_format_fail(normalized: &str, reason: &str) {
    let mut map = FORMAT_FAIL_CACHE.lock().await;
    if map.len() >= FORMAT_FAIL_CACHE_MAX && !map.contains_key(normalized) {
        let now = now_secs();
        map.retain(|_, (_, ts)| now.saturating_sub(*ts) < 24 * 3600);
        if map.len() >= FORMAT_FAIL_CACHE_MAX {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, (_, ts))| *ts)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
    }
    map.insert(normalized.to_string(), (reason.to_string(), now_secs()));
}

/// List formats with the same routing as the Tauri command (MediaFire, direct, GitHub, yt-dlp).
pub async fn list_formats_for_url(
    state: &AppState,
    url: &str,
    force: bool,
) -> Result<Vec<MediaFormat>, String> {
    if url.is_empty() {
        return Err("No URL provided".to_string());
    }
    if url.starts_with("blob:") || url.starts_with("data:") || url.starts_with("mediastream:") {
        return Err(
            "Browser-only blob URL — refresh the page and use the Veloce badge on the post link."
                .to_string(),
        );
    }
    if !util::is_safe_download_url(url) {
        return Err("Blocked: URL points to a private or local network address".to_string());
    }

    let source = formats::detect_source(url);
    let normalized = formats::normalize_url(url);

    // Trap/redirect URLs never yield media — fail fast with a page-intercept hint.
    if formats::is_trap_download_url(url) && source == formats::MediaSource::Generic {
        return Err(
            "Redirect/API link — use the Veloce intercept format picker on the page instead of this URL directly."
                .to_string(),
        );
    }

    // Success cache always wins — matching backend listFormats().
    // force only means "ignore a recent soft-fail and retry yt-dlp", not "throw away
    // a warm prefetch that already succeeded". Badge clicks send force:true; without
    // this, every click re-spawns yt-dlp even when formats were listed seconds ago.
    if let Some(cached) = state.format_cache.get(&normalized) {
        if let Ok(formats) = serde_json::from_str::<Vec<MediaFormat>>(&cached) {
            if !formats.is_empty() {
                return Ok(formats);
            }
        }
    }

    // Fail cache: soft-block repeats of known-bad URLs. force clears / bypasses it
    // so the user can retry after login, cookie, or network fixes.
    let fail_ttl = formats::fail_cache_ttl_secs(source);
    if force {
        FORMAT_FAIL_CACHE.lock().await.remove(&normalized);
    } else if let Some((reason, ts)) = FORMAT_FAIL_CACHE.lock().await.get(&normalized).cloned() {
        if now_secs().saturating_sub(ts) < fail_ttl {
            return Err(reason);
        }
    }

    // Deduplicate concurrent LIST_FORMATS for the same URL (backend `inflight` map).
    let waiter = {
        let mut map = FORMAT_INFLIGHT.lock().await;
        if let Some(tx) = map.get(&normalized) {
            Some(tx.subscribe())
        } else {
            let (tx, _) = broadcast::channel(1);
            map.insert(normalized.clone(), tx);
            None
        }
    };

    if let Some(mut rx) = waiter {
        return rx
            .recv()
            .await
            .unwrap_or_else(|_| Err("Format list request was cancelled".to_string()));
    }

    let result = list_formats_uncached(state, url, &normalized, source, force).await;

    if let Some(tx) = FORMAT_INFLIGHT.lock().await.remove(&normalized) {
        let _ = tx.send(result.clone());
    }

    result
}

async fn list_formats_uncached(
    state: &AppState,
    url: &str,
    normalized: &str,
    source: formats::MediaSource,
    force: bool,
) -> Result<Vec<MediaFormat>, String> {
    let formats = match source {
        formats::MediaSource::MediaFire => {
            let info = formats::resolve_mediafire(url).await?;
            let mut file_name = util::sanitize_filename(&info.file_name);
            let ext_from_cdn = url::Url::parse(&info.direct_url)
                .ok()
                .and_then(|u| {
                    std::path::Path::new(u.path())
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                });
            let ext = ext_from_cdn
                .or_else(|| {
                    std::path::Path::new(&file_name)
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                })
                .unwrap_or_else(|| ".mp4".to_string());
            if std::path::Path::new(&file_name).extension().is_none() {
                file_name = format!("{file_name}{ext}");
            }
            let label = if let Some(n) = info.size_bytes.filter(|n| *n > 0) {
                format!("{} — {}", file_name, formats::format_bytes(n))
            } else {
                file_name.clone()
            };
            vec![formats::MediaFormat {
                id: "0".to_string(),
                label,
                url: info.direct_url,
                ext,
                filesize: info.size_bytes,
                file_name: Some(file_name),
                source: Some("mediafire".to_string()),
                kind: Some("direct".to_string()),
            }]
        }
        formats::MediaSource::Direct | formats::MediaSource::GitHub => {
            let list_url = formats::resolve_list_url(url);
            let name = url::Url::parse(&list_url)
                .ok()
                .and_then(|u| {
                    std::path::Path::new(u.path())
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| "download".into());
            let file_name = util::sanitize_filename(&name);
            let ext = std::path::Path::new(&file_name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_else(|| ".mp4".to_string());
            vec![formats::MediaFormat {
                id: "0".to_string(),
                label: file_name.clone(),
                url: list_url,
                ext,
                filesize: None,
                file_name: Some(file_name),
                source: Some(if source == formats::MediaSource::GitHub {
                    "github".to_string()
                } else {
                    "direct".to_string()
                }),
                kind: Some("direct".to_string()),
            }]
        }
        formats::MediaSource::Instagram => {
            // Parallel variant×browser race + carousel playlist expand (list_instagram_formats).
            let page = url.to_string();
            match tokio::task::spawn_blocking(move || ytdlp::list_instagram_formats(&page, force))
                .await
                .map_err(|e| format!("yt-dlp task failed: {e}"))?
            {
                Ok(formats) => formats,
                Err(last_err) => {
                    record_format_fail(normalized, &last_err).await;
                    return Err(last_err);
                }
            }
        }
        _ => {
            let normalized = normalized.to_string();
            tokio::task::spawn_blocking(move || ytdlp::list_formats(&normalized, force))
                .await
                .map_err(|e| format!("yt-dlp task failed: {e}"))??
        }
    };

    if formats.is_empty() {
        let reason = formats::fail_reason_for_source(source, None);
        record_format_fail(normalized, &reason).await;
        return Err(reason);
    }

    if let Ok(json) = serde_json::to_string(&formats) {
        state.format_cache.set(normalized, &json);
    }

    // Also seed best_url_cache from the Best (or first) progressive URL so a
    // download that omits directUrl still avoids a second yt-dlp extract.
    if let Some(seed) = formats
        .iter()
        .find(|f| f.id == "best" && !f.url.is_empty())
        .or_else(|| formats.iter().find(|f| !f.url.is_empty()))
    {
        state.best_url_cache.set(normalized, &seed.url);
    }

    Ok(formats)
}

pub struct StartDownloadRequest {
    pub url: String,
    pub direct_url: Option<String>,
    pub file_name: String,
    pub referer: Option<String>,
    pub device_id: String,
    pub download_id: Option<String>,
    pub save_path: Option<String>,
    /// Optional override from extension payload.baseDirectory (popup folder picker).
    pub base_directory: Option<String>,
    /// Optional override from extension payload.threads.
    pub threads: Option<u32>,
}

/// How the engine (or yt-dlp) should fetch media after URL resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedFetch {
    /// Single CDN/progressive URL for core_engine.
    Url(String),
    /// Split A/V — download+merge with yt-dlp + ffmpeg.
    Merge,
}

/// Resolve the HTTP URL the engine should fetch.
pub async fn resolve_download_url(
    state: &AppState,
    page_url: &str,
    direct_url: Option<&str>,
) -> Result<ResolvedFetch, String> {
    log::info!("[Step 1: Resolve URL] Page URL: {}, Direct URL: {:?}", page_url, direct_url);
    if formats::detect_source(page_url) == formats::MediaSource::MediaFire {
        log::info!(" -> Detected MediaFire, resolving direct link via scrape...");
        let info = formats::resolve_mediafire(page_url).await?;
        if !util::is_safe_download_url(&info.direct_url) {
            return Err("Blocked: MediaFire CDN URL points to a private or local network address".to_string());
        }
        return Ok(ResolvedFetch::Url(info.direct_url));
    }

    if let Some(direct) = direct_url.filter(|u| !u.is_empty()) {
        if formats::is_manifest_format_url(direct) {
            log::info!(" -> Omitting manifest/HLS direct URL; will re-extract or merge");
        } else if ytdlp::is_instagram_silent_dash_url(direct) {
            log::info!(" -> Direct URL is silent Instagram DASH; will merge via yt-dlp");
            return Ok(ResolvedFetch::Merge);
        } else {
            if !util::is_safe_download_url(direct) {
                return Err("Blocked: direct URL points to a private or local network address".to_string());
            }
            return Ok(ResolvedFetch::Url(direct.to_string()));
        }
    }

    if formats::is_direct_file_url(page_url) || formats::is_github_raw_url(page_url) {
        let resolved = formats::resolve_list_url(page_url);
        if !util::is_safe_download_url(&resolved) {
            return Err("Blocked: URL points to a private or local network address".to_string());
        }
        return Ok(ResolvedFetch::Url(resolved));
    }

    // OmniSave / MovieBox: formats come from the site API (extension intercept), not yt-dlp.
    // Without a CDN direct_url, extraction on the catalog page hangs and never yields a file.
    if formats::is_intercept_catalog_url(page_url) {
        return Err(
            "This site needs the in-page download link (open Download Options on the player, then use the Veloce badge). Resume keeps the CDN URL from the original job."
                .to_string(),
        );
    }

    let source = formats::detect_source(page_url);
    let normalized = formats::normalize_url(page_url);
    if let Some(cached) = state.best_url_cache.get(&normalized) {
        if !formats::is_manifest_format_url(&cached)
            && !ytdlp::is_instagram_silent_dash_url(&cached)
            && util::is_safe_download_url(&cached)
        {
            log::info!(" -> Using cached extraction for {}", normalized);
            return Ok(ResolvedFetch::Url(cached));
        }
    }

    // Prefer a single muxed URL (range engine). Never use bare `b` — Instagram DASH
    // falls back to silent video-only.
    let norm_clone = normalized.clone();
    let muxed = tokio::task::spawn_blocking(move || {
        ytdlp::extract_url_with_format(&norm_clone, "best[vcodec!=none][acodec!=none]")
    })
    .await
    .map_err(|e| format!("yt-dlp task failed: {}", e))?;

    if let Ok(extracted) = muxed {
        if !formats::is_manifest_format_url(&extracted)
            && !ytdlp::is_instagram_silent_dash_url(&extracted)
            && util::is_safe_download_url(&extracted)
        {
            log::info!(" -> yt-dlp muxed extraction successful");
            state.best_url_cache.set(&normalized, &extracted);
            return Ok(ResolvedFetch::Url(extracted));
        }
    }

    if matches!(
        source,
        formats::MediaSource::Instagram | formats::MediaSource::YouTube
    ) {
        if source == formats::MediaSource::Instagram
            && !formats::is_instagram_media_page_url(page_url)
        {
            return Err(
                "Instagram download needs a post, reel, or story URL (/p/…, /reel/…, /stories/…), not the homepage. Open the video and use the Veloce badge."
                    .to_string(),
            );
        }
        log::info!(" -> No muxed URL; will merge via yt-dlp+ffmpeg ({:?})", source);
        return Ok(ResolvedFetch::Merge);
    }

    // Other sites: legacy best-URL extract.
    log::info!(" -> Running yt-dlp extraction for {}", normalized);
    let norm_clone = normalized.clone();
    let extracted = tokio::task::spawn_blocking(move || {
        ytdlp::extract_best_url(&norm_clone)
    }).await.map_err(|e| format!("yt-dlp task failed: {}", e))??;

    log::info!(" -> yt-dlp extraction successful");
    if formats::is_manifest_format_url(&extracted) {
        return Err(
            "Cannot download a stream manifest as a file. Open the video page and retry from the Veloce badge."
                .to_string(),
        );
    }
    if !util::is_safe_download_url(&extracted) {
        return Err("Blocked: extracted media URL points to a private or local network address".to_string());
    }
    state.best_url_cache.set(&normalized, &extracted);
    Ok(ResolvedFetch::Url(extracted))
}

/// Enqueue a download job (shared by Tauri IPC and WebSocket).
pub async fn enqueue_download_job(
    state: Arc<AppState>,
    req: StartDownloadRequest,
) -> Result<String, String> {
    let config = Config::from_env();
    let mut download_id = req.download_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    log::info!("[Step 2: Enqueue Job] ID: {}, URL: {}", download_id, req.url);
    let (runtime_dir, _, runtime_threads) = state.get_runtime_settings();
    let save_dir = req
        .base_directory
        .as_ref()
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(runtime_dir);
    let job_threads = req.threads.filter(|t| *t > 0).unwrap_or(runtime_threads);

    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;

    // Already complete on disk for this URL — ACK without re-downloading.
    if req.save_path.is_none() && req.download_id.is_none() {
        if let Ok(Some(done)) = state.db.find_completed_on_disk_by_url(&req.url) {
            let tot = done
                .total_bytes
                .or(done.downloaded_bytes)
                .unwrap_or(0)
                .max(0) as u64;
            let dl = done.downloaded_bytes.unwrap_or(tot as i64).max(0) as u64;
            let final_dl = if tot > 0 { tot } else { dl };
            state
                .ws_clients
                .broadcast_ack(&done.id, &done.file_name, "completed");
            state.emit_download_added(
                &done.id,
                &done.url,
                &done.file_name,
                &done.save_path,
                "completed",
            );
            {
                let mut progress = state.progress.lock().await;
                progress.insert(
                    done.id.clone(),
                    DownloadStatus {
                        id: done.id.clone(),
                        url: done.url.clone(),
                        file_name: done.file_name.clone(),
                        save_path: done.save_path.clone(),
                        status: "completed".to_string(),
                        downloaded: final_dl,
                        total: final_dl,
                        speed_bps: 0,
                        eta_secs: 0,
                        progress_pct: 100.0,
                        error: None,
                        source: None,
                    },
                );
            }
            log::info!(
                "[Step 2] Reusing completed download {} at {}",
                done.id,
                done.save_path
            );
            return Ok(done.id);
        }
    }

    let page_source = formats::detect_source(&req.url);
    let is_resume = req.save_path.is_some() || req.download_id.is_some();

    // MediaFire: scrape ONLY at engine start (tokens expire + saves ~2s on enqueue/resume).
    let (download_url, merge_via_ytdlp) = if page_source == formats::MediaSource::MediaFire {
        log::info!(" -> MediaFire: deferring CDN scrape until engine start (fast enqueue)");
        (req.url.clone(), false)
    } else {
        match resolve_download_url(&state, &req.url, req.direct_url.as_deref()).await? {
            ResolvedFetch::Url(u) => (u, false),
            ResolvedFetch::Merge => (req.url.clone(), true),
        }
    };

    let mut safe_name = util::sanitize_filename(&req.file_name);
    if !is_resume
        && page_source != formats::MediaSource::MediaFire
        && (safe_name.starts_with("file") || safe_name.starts_with("download_file"))
        && req.direct_url.is_none()
    {
        if let Ok(u) = url::Url::parse(&download_url) {
            if let Some(segments) = u.path_segments() {
                if let Some(last) = segments.last() {
                    if last.contains('.') {
                        let decoded = percent_encoding::percent_decode_str(last).decode_utf8_lossy();
                        let new_name = decoded.replace('+', " ");
                        if !new_name.is_empty() {
                            safe_name = util::sanitize_filename(&new_name);
                        }
                    }
                }
            }
        }
    }

    // Reuse existing incomplete path for this URL instead of creating (1)/(2).
    let mut reused_row: Option<db::DownloadRow> = None;
    let save_path = if let Some(path) = req.save_path.as_ref() {
        let p = std::path::PathBuf::from(path);
        util::migrate_legacy_sidecars(&p);
        p
    } else if let Ok(Some(row)) = state.db.find_resumable_by_url(&req.url) {
        download_id = row.id.clone();
        safe_name = row.file_name.clone();
        let p = std::path::PathBuf::from(&row.save_path);
        util::migrate_legacy_sidecars(&p);
        log::info!(
            "[Step 2] Reusing resumable path {} (id {})",
            row.save_path,
            row.id
        );
        reused_row = Some(row);
        p
    } else {
        let desired = save_dir.join(&safe_name);
        util::reuse_or_unique_save_path(&desired)
    };
    let save_path_str = save_path.to_string_lossy().to_string();
    if safe_name.is_empty() {
        safe_name = save_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".into());
    }

    let min_free_bytes = config.min_free_disk_mb * 1024 * 1024;
    if let Some(free) = util::free_space(&save_dir) {
        if free < min_free_bytes {
            return Err(format!(
                "Insufficient disk space: {} free, need at least {} MB reserved",
                util::format_bytes(free),
                config.min_free_disk_mb,
            ));
        }
    }

    let (prev_downloaded, prev_total) = if let Some(row) = reused_row.as_ref() {
        (
            row.downloaded_bytes.unwrap_or(0).max(0) as u64,
            row.total_bytes.unwrap_or(0).max(0) as u64,
        )
    } else if let Ok(Some(row)) = state.db.get_download(&download_id) {
        (
            row.downloaded_bytes.unwrap_or(0).max(0) as u64,
            row.total_bytes.unwrap_or(0).max(0) as u64,
        )
    } else {
        (0, 0)
    };
    let prev_pct = if prev_total > 0 {
        (prev_downloaded as f64 / prev_total as f64) * 100.0
    } else {
        0.0
    };

    if let Ok(Some(_)) = state.db.get_download(&download_id) {
        let _ = state.db.update_download_status(&download_id, "queued");
    } else {
        let row = db::DownloadRow {
            id: download_id.clone(),
            device_id: req.device_id.clone(),
            url: req.url.clone(),
            direct_url: if page_source == formats::MediaSource::MediaFire || merge_via_ytdlp {
                None
            } else {
                Some(download_url.clone())
            },
            referer: req.referer.clone(),
            file_name: safe_name.clone(),
            save_path: save_path_str.clone(),
            status: "queued".to_string(),
            total_bytes: if prev_total > 0 {
                Some(prev_total as i64)
            } else {
                None
            },
            downloaded_bytes: Some(prev_downloaded as i64),
        };
        state
            .db
            .insert_download(&row)
            .map_err(|e| format!("DB error: {}", e))?;
    }

    state.emit_download_added(
        &download_id,
        &req.url,
        &safe_name,
        &save_path_str,
        "queued",
    );

    let source = formats::detect_source(&req.url);
    let status = DownloadStatus {
        id: download_id.clone(),
        url: req.url.clone(),
        file_name: safe_name.clone(),
        save_path: save_path_str.clone(),
        status: "queued".to_string(),
        downloaded: prev_downloaded,
        total: prev_total,
        speed_bps: 0,
        eta_secs: 0,
        progress_pct: prev_pct,
        error: None,
        source: Some(format!("{:?}", source).to_lowercase()),
    };
    state.track_download(status).await;
    state
        .ws_clients
        .broadcast_ack(&download_id, &safe_name, "queued");

    let job_state = crate::scheduler::JobState {
        id: download_id.clone(),
        url: req.url.clone(),
        direct_url: if page_source == formats::MediaSource::MediaFire || merge_via_ytdlp {
            None
        } else {
            Some(download_url.clone())
        },
        file_name: safe_name.clone(),
        save_path: save_path_str.clone(),
        status: "queued".to_string(),
        downloaded: prev_downloaded,
        total: prev_total,
        speed_bps: 0,
        eta_secs: 0,
        is_playlist: false,
        error: None,
        threads: Some(job_threads),
        merge_via_ytdlp,
    };

    state.scheduler.enqueue(job_state);
    log::info!(
        " -> Job {} enqueued successfully. Pumping scheduler...",
        download_id
    );
    pump_scheduler(state.clone());

    Ok(download_id)
}

pub fn pump_scheduler(state: Arc<AppState>) {
    let mut dequeued_count = 0;
    while let Some(job) = state.scheduler.dequeue() {
        dequeued_count += 1;
        let state_clone = state.clone();
        tokio::spawn(async move {
            let referer = state_clone.db.get_download(&job.id).ok().flatten().and_then(|r| r.referer);
            if let Err(e) = start_engine_for_job(state_clone, job, referer).await {
                log::error!("[Step 3: Pump Scheduler] Engine spawn error: {}", e);
            }
        });
    }
    if dequeued_count > 0 {
        log::info!("[Step 3: Pump Scheduler] Dequeued {} jobs", dequeued_count);
    }
}

async fn start_engine_for_job(state: Arc<AppState>, job: crate::scheduler::JobState, referer: Option<String>) -> Result<(), String> {
    let config = Config::from_env();
    let download_id = job.id.clone();
    let save_path_str = job.save_path.clone();
    let merge_via_ytdlp = job.merge_via_ytdlp;

    // Instagram/YouTube DASH split — yt-dlp + ffmpeg (core_engine cannot mux two URLs).
    if merge_via_ytdlp {
        if formats::detect_source(&job.url) == formats::MediaSource::Instagram
            && !formats::is_instagram_media_page_url(&job.url)
        {
            return Err(
                "Instagram download needs a post, reel, or story URL (/p/…, /reel/…, /stories/…), not the homepage. Open the video and use the Veloce badge."
                    .to_string(),
            );
        }
        let _ = state.db.update_download_status(&download_id, "downloading");
        let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut flags = state.cancellation_flags.lock().unwrap();
            flags.insert(download_id.clone(), cancel_flag.clone());
        }
        let page_url = job.url.clone();
        let save_path = save_path_str.clone();
        let id = download_id.clone();
        let state_merge = state.clone();
        let result = tokio::task::spawn_blocking(move || {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }
            ytdlp::download_merged_to_file(&page_url, &save_path)
        })
        .await
        .map_err(|e| format!("yt-dlp merge task failed: {e}"))?;

        {
            let mut flags = state.cancellation_flags.lock().unwrap();
            flags.remove(&id);
        }
        state.scheduler.finish(&id);

        match result {
            Ok(()) => {
                let size = std::fs::metadata(&save_path_str)
                    .map(|m| m.len())
                    .unwrap_or(0);
                let _ = state.db.update_download_progress(&id, size as i64, size as i64);
                let _ = state.db.update_download_status(&id, "completed");
                state.emit_progress(&id, size, size, 0, 0, 100.0);
                state.emit_status(&id, "completed", None).await;
                state.remove_active(&id).await;
                pump_scheduler(state.clone());
                Ok(())
            }
            Err(e) if e == "cancelled" => {
                let _ = std::fs::remove_file(&save_path_str);
                util::remove_resume_sidecars(std::path::Path::new(&save_path_str));
                let _ = state.db.update_download_status(&id, "cancelled");
                state.emit_status(&id, "cancelled", None).await;
                state.remove_active(&id).await;
                pump_scheduler(state.clone());
                Ok(())
            }
            Err(e) => {
                let _ = state.db.update_download_status(&id, "failed");
                state.emit_status(&id, "failed", Some(e.clone())).await;
                state.remove_active(&id).await;
                pump_scheduler(state.clone());
                Err(e)
            }
        }
    } else {
    // MediaFire CDN tokens expire while jobs wait in the queue — re-scrape at engine
    // start (backend runDownloadJob parity), not only at enqueue time.
    let download_url = if formats::detect_source(&job.url) == formats::MediaSource::MediaFire {
        log::info!("[MediaFire] Re-resolving CDN URL at engine start for {}", download_id);
        match formats::resolve_mediafire(&job.url).await {
            Ok(info) => info.direct_url,
            Err(e) => {
                // Token refresh failed (network blip) — fall back to URL from enqueue scrape.
                if let Some(cached) = job.direct_url.clone().filter(|u| !u.is_empty()) {
                    log::warn!(
                        "[MediaFire] Re-resolve failed ({e}); using cached CDN URL from enqueue"
                    );
                    cached
                } else {
                    return Err(e);
                }
            }
        }
    } else {
        job.direct_url.unwrap_or(job.url.clone())
    };
    let download_url = util::sanitize_download_media_url(&download_url);
    if formats::is_manifest_format_url(&download_url) {
        return Err(
            "Cannot download a stream manifest as a file. Open the video page and retry from the Veloce badge."
                .to_string(),
        );
    }
    let save_path_str = job.save_path;

    let _ = state.db.update_download_status(&download_id, "downloading");

    let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut flags = state.cancellation_flags.lock().unwrap();
        flags.insert(download_id.clone(), cancel_flag.clone());
    }

    let state_spawn = state.clone();
    let id_spawn = download_id.clone();
    let last_engine_error = Arc::new(Mutex::new(None::<String>));

    let on_progress = {
        let state_prog = state.clone();
        let id_prog = download_id.clone();
        let last_err = last_engine_error.clone();
        move |prog: crate::engine::EngineProgress| {
            if prog.msg_type == "fatal" {
                if let Some(ref e) = prog.error {
                    *last_err.lock().unwrap() = Some(e.clone());
                }
                return;
            }
            if prog.msg_type == "done" || prog.msg_type == "already_exists" {
                let total = prog.total.or(prog.downloaded).unwrap_or(0);
                let downloaded = prog.downloaded.unwrap_or(total).max(total);
                if prog.msg_type == "done" {
                    log::info!(
                        "[Engine Stats] id={} host={:?} session={}B baseline={}B session={:.2}MB/s peak={:.2}MB/s retries={:?} stalls={:?} busy={:?} workers={:?} elapsed={:.1}s",
                        id_prog,
                        prog.host,
                        prog.session_bytes.unwrap_or(0),
                        prog.baseline_bytes.unwrap_or(0),
                        prog.avg_speed_mbps.unwrap_or(0.0),
                        prog.peak_speed_mbps.unwrap_or(0.0),
                        prog.retries,
                        prog.stalls,
                        prog.busy_responses,
                        prog.workers,
                        prog.elapsed_secs.unwrap_or(0.0),
                    );
                }
                state_prog.emit_progress(&id_prog, downloaded, total.max(downloaded), 0, 0, 100.0);
                return;
            }
            let pct = match (prog.downloaded, prog.total) {
                (Some(d), Some(t)) if t > 0 => (d as f64 / t as f64) * 100.0,
                _ => 0.0,
            };
            state_prog.emit_progress(&id_prog, prog.downloaded.unwrap_or(0), prog.total.unwrap_or(0), prog.speed_bps.unwrap_or(0), prog.eta_secs.unwrap_or(0), pct);
        }
    };

    let (save_dir_runtime, _, default_threads) = state.get_runtime_settings();
    let base_dir = save_dir_runtime.to_string_lossy().into_owned();
    let threads = job
        .threads
        .filter(|t| *t > 0)
        .unwrap_or(default_threads)
        .clamp(1, 64);
    let page_source = formats::detect_source(&job.url);
    // MediaFire CDN often requires Referer = the file page. Prefer stored referer,
    // else fall back to the page URL we scraped.
    let referer = referer.or_else(|| {
        if page_source == formats::MediaSource::MediaFire {
            Some(job.url.clone())
        } else {
            None
        }
    });
    let auto_tune = config.engine_auto_tune
        && !matches!(
            page_source,
            formats::MediaSource::MediaFire
                | formats::MediaSource::Direct
                | formats::MediaSource::GitHub
        );

    if !util::is_safe_download_url(&download_url) {
        return Err("Blocked: download URL points to a private or local network address".to_string());
    }

    match EngineProcess::spawn(
        download_id.clone(),
        &download_url,
        &save_path_str,
        threads,
        config.max_rate_bytes,
        config.engine_quiet,
        config.engine_read_buffer_bytes,
        auto_tune,
        referer.as_deref(),
        Some(&base_dir),
        on_progress,
        Some(last_engine_error.clone()),
    ) {
        Ok((engine, _reader)) => {
            log::info!("[Step 4: Spawn Engine] Engine spawned for ID: {}", download_id);
            {
                let mut engines = state.active_engines.lock().unwrap();
                engines.insert(download_id.clone(), engine);
            }

            let state_mon = state_spawn.clone();
            let id_mon = id_spawn.clone();
            let cancel_mon = cancel_flag.clone();
            let runtime_handle = state_spawn.runtime_handle.clone();
            let save_path_mon = save_path_str.clone();
            let last_err_mon = last_engine_error.clone();

            std::thread::spawn(move || {
                let waiter = {
                    let engines = state_mon.active_engines.lock().unwrap();
                    engines.get(&id_mon).map(|eng| eng.waiter())
                };

                let (exit_status, error) = match waiter {
                    Some((child_arc, cancel_mon)) => {
                        let mut code_opt = None;
                        loop {
                            {
                                let mut lock = child_arc.lock().unwrap();
                                if let Some(child) = lock.as_mut() {
                                    if let Ok(Some(status)) = child.try_wait() {
                                        code_opt = Some(status.code().unwrap_or(-1));
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        let code = code_opt;
                        let db_status = state_mon
                            .db
                            .get_download(&id_mon)
                            .ok()
                            .flatten()
                            .map(|r| r.status)
                            .unwrap_or_default();
                        if db_status == "paused" {
                            log::info!(
                                "[Step 5: Engine Exit] {} paused (engine code {:?})",
                                id_mon,
                                code
                            );
                            ("paused".to_string(), None)
                        } else if cancel_mon.load(Ordering::SeqCst) || db_status == "cancelled" {
                            log::info!("[Step 5: Engine Exit] {} was cancelled", id_mon);
                            ("cancelled".to_string(), None)
                        } else if code == Some(0) {
                            // Cross-check on-disk size vs last progress total — catches
                            // rare engine exit-0 with a truncated file.
                            let expected = state_mon
                                .db
                                .get_download(&id_mon)
                                .ok()
                                .flatten()
                                .map(|r| {
                                    r.total_bytes
                                        .unwrap_or(0)
                                        .max(r.downloaded_bytes.unwrap_or(0))
                                        as u64
                                })
                                .unwrap_or(0);
                            let disk = std::fs::metadata(&save_path_mon)
                                .map(|m| m.len())
                                .unwrap_or(0);
                            if expected > 1_048_576 && disk > 0 && disk < ((expected as f64) * 0.98) as u64
                            {
                                log::error!(
                                    "[Step 5: Engine Exit] {} incomplete on disk: {} / {} bytes",
                                    id_mon,
                                    disk,
                                    expected
                                );
                                (
                                    "failed".to_string(),
                                    Some(format!(
                                        "Download incomplete ({disk} / {expected} bytes). Try again."
                                    )),
                                )
                            } else {
                                log::info!("[Step 5: Engine Exit] {} completed successfully", id_mon);
                                ("completed".to_string(), None)
                            }
                        } else {
                            let detail = last_err_mon
                                .lock()
                                .unwrap()
                                .clone()
                                .unwrap_or_else(|| {
                                    format!("Engine exited with code {}", code.unwrap_or(-1))
                                });
                            log::error!("[Step 5: Engine Exit] {} failed: {}", id_mon, detail);
                            ("failed".to_string(), Some(detail))
                        }
                    }
                    None => {
                        log::warn!("[Step 5: Engine Exit] Engine process lost for {}", id_mon);
                        let db_status = state_mon
                            .db
                            .get_download(&id_mon)
                            .ok()
                            .flatten()
                            .map(|r| r.status)
                            .unwrap_or_default();
                        if db_status == "paused" {
                            ("paused".to_string(), None)
                        } else if cancel_mon.load(Ordering::SeqCst) || db_status == "cancelled" {
                            ("cancelled".to_string(), None)
                        } else {
                            ("failed".to_string(), Some("Engine process lost".to_string()))
                        }
                    }
                };

                {
                    let mut engines = state_mon.active_engines.lock().unwrap();
                    engines.remove(&id_mon);
                }

                let current_status = state_mon.db.get_download(&id_mon).ok().flatten().map(|r| r.status).unwrap_or_default();

                runtime_handle.block_on(async {
                    if current_status == "paused" || exit_status == "paused" {
                        log::info!("[Step 5: Engine Exit] {} is paused, keeping state", id_mon);
                        // Keep last progress in memory so UI / get_statuses don't jump to 0.
                        {
                            let mut progress = state_mon.progress.lock().await;
                            if let Some(entry) = progress.get_mut(&id_mon) {
                                entry.status = "paused".to_string();
                                entry.error = None;
                                entry.speed_bps = 0;
                                entry.eta_secs = 0;
                            }
                        }
                        state_mon.scheduler.finish(&id_mon);
                        {
                            let mut engines = state_mon.active_engines.lock().unwrap();
                            engines.remove(&id_mon);
                        }
                        {
                            let mut flags = state_mon.cancellation_flags.lock().unwrap();
                            flags.remove(&id_mon);
                        }
                        pump_scheduler(state_mon.clone());
                    } else if current_status == "cancelled" || exit_status == "cancelled" {
                        log::info!("[Step 5: Engine Exit] {} is cancelled, cleaning up files", id_mon);
                        if let Ok(Some(row)) = state_mon.db.get_download(&id_mon) {
                            let save = std::path::Path::new(&row.save_path);
                            let _ = std::fs::remove_file(save);
                            util::remove_resume_sidecars(save);
                        }
                        if current_status != "cancelled" {
                            let _ = state_mon.db.update_download_status(&id_mon, "cancelled");
                            state_mon.emit_status(&id_mon, "cancelled", None).await;
                        }
                        state_mon.scheduler.finish(&id_mon);
                        state_mon.remove_active(&id_mon).await;
                        pump_scheduler(state_mon.clone());
                    } else {
                        let _ = state_mon.db.update_download_status(&id_mon, &exit_status);
                        state_mon.scheduler.finish(&id_mon);
                        state_mon.emit_status(&id_mon, &exit_status, error.clone()).await;
                        state_mon.remove_active(&id_mon).await;
                        pump_scheduler(state_mon.clone());
                    }
                });
            });

            Ok(())
        }
        Err(e) => {
            {
                let mut flags = state.cancellation_flags.lock().unwrap();
                flags.remove(&download_id);
            }
            state.scheduler.finish(&download_id);
            let _ = state.db.update_download_status(&download_id, "failed");
            state.emit_status(&download_id, "failed", Some(e.clone())).await;
            pump_scheduler(state.clone());
            Err(format!("Failed to start engine: {}", e))
        }
    }
    } // end else !merge_via_ytdlp
}

/// Save base64 blob bytes from the extension (blob:/data: intercept).
pub async fn save_blob_download(
    state: &AppState,
    base64_data: &str,
    file_name: &str,
    _mime: Option<&str>,
    source_url: &str,
) -> Result<String, String> {
    const MAX_BLOB_BYTES: usize = 80 * 1024 * 1024;
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("Invalid base64: {}", e))?;
    if bytes.is_empty() {
        return Err("Empty blob".to_string());
    }
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(format!("Blob too large (max {} MB)", MAX_BLOB_BYTES / 1024 / 1024));
    }

    let config = Config::from_env();
    let save_dir = config.base_directory();
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;

    let download_id = Uuid::new_v4().to_string();
    let safe_name = util::sanitize_filename(file_name);
    let save_path = util::unique_save_path(&save_dir.join(&safe_name));
    std::fs::write(&save_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    let save_path_str = save_path.to_string_lossy().to_string();
    let row = db::DownloadRow {
        id: download_id.clone(),
        device_id: "extension".to_string(),
        url: source_url.to_string(),
        direct_url: None,
        referer: None,
        file_name: safe_name.clone(),
        save_path: save_path_str.clone(),
        status: "completed".to_string(),
        total_bytes: Some(bytes.len() as i64),
        downloaded_bytes: Some(bytes.len() as i64),
    };
    state
        .db
        .insert_download(&row)
        .map_err(|e| format!("DB error: {}", e))?;

    state
        .ws_clients
        .broadcast_ack(&download_id, &safe_name, "completed");
    state.ws_clients.broadcast_completed(
        &download_id,
        "completed",
        bytes.len() as u64,
        bytes.len() as u64,
    );

    Ok(download_id)
}

pub async fn cancel_download_job(state: &AppState, id: &str) -> Result<(), String> {
    {
        let flags = state.cancellation_flags.lock().unwrap();
        if let Some(flag) = flags.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    {
        let mut engines = state.active_engines.lock().unwrap();
        if let Some(engine) = engines.get_mut(id) {
            engine.cancel();
        }
    }
    let _ = state.db.update_download_status(id, "cancelled");
    state.scheduler.finish(id);
    state.emit_status(id, "cancelled", None).await;
    state.ws_clients.broadcast_removed(id);
    Ok(())
}

pub async fn pause_download_job(state: &AppState, id: &str) -> Result<(), String> {
    {
        let mut engines = state.active_engines.lock().unwrap();
        if let Some(engine) = engines.get_mut(id) {
            engine.pause();
        }
    }
    let _ = state.db.update_download_status(id, "paused");
    // Clear sticky error; keep downloaded/total already in progress + DB.
    {
        let mut progress = state.progress.lock().await;
        if let Some(entry) = progress.get_mut(id) {
            entry.status = "paused".to_string();
            entry.error = None;
            entry.speed_bps = 0;
            entry.eta_secs = 0;
        }
    }
    state.emit_status(id, "paused", None).await;
    Ok(())
}

pub async fn resume_download_job(state: Arc<AppState>, id: &str) -> Result<(), String> {
    let row = state
        .db
        .get_download(id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| "Download not found".to_string())?;

    // Extension UI uses "error"; desktop DB uses "failed" — both must be retryable.
    if !["paused", "error", "failed", "queued", "cancelled"].contains(&row.status.as_str()) {
        return Err(format!("Cannot resume download in status {}", row.status));
    }

    {
        let engines = state.active_engines.lock().unwrap();
        if engines.contains_key(id) {
            return Err("Download already running".to_string());
        }
    }

    let downloaded = row.downloaded_bytes.unwrap_or(0) as u64;
    let total = row.total_bytes.unwrap_or(0) as u64;
    let pct = if total > 0 {
        (downloaded as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    // Drop sticky failure immediately and restore last known byte counts.
    {
        let mut progress = state.progress.lock().await;
        if let Some(entry) = progress.get_mut(id) {
            entry.status = "queued".to_string();
            entry.error = None;
            entry.downloaded = downloaded;
            entry.total = total;
            entry.progress_pct = pct;
            entry.speed_bps = 0;
            entry.eta_secs = 0;
        } else {
            progress.insert(
                id.to_string(),
                DownloadStatus {
                    id: id.to_string(),
                    url: row.url.clone(),
                    file_name: row.file_name.clone(),
                    save_path: row.save_path.clone(),
                    status: "queued".to_string(),
                    downloaded,
                    total,
                    speed_bps: 0,
                    eta_secs: 0,
                    progress_pct: pct,
                    error: None,
                    source: None,
                },
            );
        }
    }
    // Drop a stale queue entry so we don't double-start the same id.
    let _ = state.scheduler.remove_queued(id);

    let _ = state.db.update_download_status(id, "queued");
    state.ws_clients.broadcast_ack(id, &row.file_name, "queued");
    state.emit_status(id, "queued", None).await;
    state.emit_download_added(
        id,
        &row.url,
        &row.file_name,
        &row.save_path,
        "queued",
    );

    // MediaFire tokens expire — clear so resolve/engine start re-scrapes.
    // OmniSave / intercept CDNs must keep the stored direct_url (page URL is not downloadable).
    let page_source = formats::detect_source(&row.url);
    let direct_url = if page_source == formats::MediaSource::MediaFire {
        None
    } else {
        row.direct_url.clone().filter(|u| !u.is_empty())
    };

    if let Err(e) = enqueue_download_job(
        state.clone(),
        StartDownloadRequest {
            url: row.url.clone(),
            direct_url,
            file_name: row.file_name.clone(),
            referer: row.referer.clone(),
            device_id: row.device_id.clone(),
            download_id: Some(id.to_string()),
            save_path: Some(row.save_path.clone()),
            base_directory: None,
            threads: None,
        },
    )
    .await
    {
        let _ = state.db.update_download_status(id, "failed");
        state
            .emit_status(id, "failed", Some(e.clone()))
            .await;
        return Err(e);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Database;
    use crate::scheduler::Scheduler;
    use crate::ws::WsClients;

    fn test_state() -> Arc<AppState> {
        let db = Database::open_in_memory().expect("db");
        let ws = Arc::new(WsClients::new());
        let handle = tokio::runtime::Handle::current();
        Arc::new(AppState::new(
            db,
            Scheduler::new(Config::from_env()),
            ws,
            handle,
        ))
    }

    #[tokio::test]
    async fn rejects_empty_url() {
        let state = test_state();
        let err = list_formats_for_url(&state, "", false).await.unwrap_err();
        assert!(err.contains("No URL"));
    }

    #[tokio::test]
    async fn rejects_blob_urls() {
        let state = test_state();
        let err = list_formats_for_url(&state, "blob:https://x", false)
            .await
            .unwrap_err();
        assert!(err.contains("Browser-only blob URL"));
    }

    #[tokio::test]
    async fn rejects_private_hosts_when_blocked() {
        let state = test_state();
        let err = list_formats_for_url(&state, "http://127.0.0.1/secret.mp4", false)
            .await
            .unwrap_err();
        assert!(err.contains("Blocked"));
    }

    #[tokio::test]
    async fn direct_file_url_returns_single_format_without_ytdlp() {
        let state = test_state();
        let formats = list_formats_for_url(
            &state,
            "https://cdn.example.com/video.mp4",
            false,
        )
        .await
        .expect("direct formats");
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].id, "0");
        assert!(formats[0].label.contains("Direct"));
        assert_eq!(formats[0].url, "https://cdn.example.com/video.mp4");
        assert_eq!(formats[0].source.as_deref(), Some("direct"));
    }

    #[tokio::test]
    async fn github_blob_url_resolves_to_raw() {
        let state = test_state();
        let formats = list_formats_for_url(
            &state,
            "https://github.com/o/r/blob/main/readme.md",
            false,
        )
        .await
        .expect("github formats");
        assert_eq!(
            formats[0].url,
            "https://raw.githubusercontent.com/o/r/main/readme.md"
        );
        assert_eq!(formats[0].source.as_deref(), Some("github"));
    }

    #[tokio::test]
    async fn format_cache_hit_skips_second_lookup() {
        let state = test_state();
        let url = "https://cdn.example.com/cached-file.zip";
        let first = list_formats_for_url(&state, url, false)
            .await
            .expect("first");
        let second = list_formats_for_url(&state, url, false)
            .await
            .expect("cached");
        assert_eq!(first[0].url, second[0].url);
    }

    /// force:true must still return the warm success cache (backend parity).
    #[tokio::test]
    async fn force_true_still_hits_success_cache() {
        let state = test_state();
        let url = "https://cdn.example.com/force-cache.zip";
        let first = list_formats_for_url(&state, url, false)
            .await
            .expect("seed cache");
        let forced = list_formats_for_url(&state, url, true)
            .await
            .expect("force must not drop success cache");
        assert_eq!(first[0].url, forced[0].url);
        assert_eq!(forced[0].source.as_deref(), Some("direct"));
    }

    #[tokio::test]
    async fn force_still_validates_url() {
        let state = test_state();
        let err = list_formats_for_url(&state, "", true).await.unwrap_err();
        assert!(err.contains("No URL"));
    }

    #[tokio::test]
    async fn trap_url_rejected_on_list() {
        let state = test_state();
        let err = list_formats_for_url(
            &state,
            "https://evil.example.com/api/graphql?a=redirect",
            false,
        )
        .await
        .unwrap_err();
        assert!(err.contains("Redirect/API") || err.contains("intercept"));
    }

    #[tokio::test]
    async fn resolve_download_url_uses_direct_when_provided() {
        let state = test_state();
        let url = resolve_download_url(
            &state,
            "https://www.youtube.com/watch?v=x",
            Some("https://cdn.example.com/direct.mp4"),
        )
        .await
        .expect("direct");
        assert_eq!(url, ResolvedFetch::Url("https://cdn.example.com/direct.mp4".into()));
    }

    #[tokio::test]
    async fn resolve_omnisave_page_without_direct_fails_fast() {
        let state = test_state();
        let err = resolve_download_url(
            &state,
            "https://videodownloader.site/?q=Absolutely%20Anything",
            None,
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("in-page download") || err.contains("CDN"),
            "unexpected: {err}"
        );
    }

    #[tokio::test]
    async fn resolve_omnisave_keeps_cdn_direct_url() {
        let state = test_state();
        let cdn = "https://bcdnxw.hakunaymatata.com/tran-audio/x.mp4?token=1";
        let url = resolve_download_url(
            &state,
            "https://videodownloader.site/?q=Absolutely%20Anything",
            Some(cdn),
        )
        .await
        .expect("cdn direct");
        assert_eq!(url, ResolvedFetch::Url(cdn.into()));
    }

    /// Listing must seed best_url_cache so a Best-style resolve without directUrl
    /// still skips a second yt-dlp when formats were already listed.
    #[tokio::test]
    async fn list_formats_seeds_best_url_cache() {
        let state = test_state();
        let url = "https://cdn.example.com/seed-best.zip";
        let formats = list_formats_for_url(&state, url, false)
            .await
            .expect("list");
        assert!(!formats[0].url.is_empty());
        let key = formats::normalize_url(url);
        let cached = state.best_url_cache.get(&key).expect("best url seeded");
        assert_eq!(cached, formats[0].url);
        let resolved = resolve_download_url(&state, url, None)
            .await
            .expect("resolve from seed");
        assert_eq!(resolved, ResolvedFetch::Url(formats[0].url.clone()));
    }

    #[tokio::test]
    async fn resolve_download_url_uses_page_for_direct_file() {
        let state = test_state();
        let url = resolve_download_url(
            &state,
            "https://cdn.example.com/file.mp4",
            None,
        )
        .await
        .expect("page direct");
        assert_eq!(url, ResolvedFetch::Url("https://cdn.example.com/file.mp4".into()));
    }

    #[tokio::test]
    async fn resolve_download_url_blocks_unsafe_direct() {
        let state = test_state();
        let err = resolve_download_url(
            &state,
            "https://example.com/x",
            Some("http://127.0.0.1/internal"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("Blocked"));
    }
}
