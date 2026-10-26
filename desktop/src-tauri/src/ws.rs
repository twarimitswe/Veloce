use std::collections::HashMap;
use std::net::{Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State as AxumState,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};

use crate::config::Config;
use crate::download::{self, StartDownloadRequest};
use crate::playlist;
use crate::state::AppState;
use crate::util;

/// Thread-safe registry of connected WebSocket clients.
pub struct WsClients {
    next_id: Mutex<u64>,
    clients: Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<String>>>,
}

impl WsClients {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(0),
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn add(&self, tx: tokio::sync::mpsc::UnboundedSender<String>) -> u64 {
        let mut next = self.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        self.clients.lock().unwrap().insert(id, tx);
        id
    }

    pub fn remove(&self, id: u64) {
        self.clients.lock().unwrap().remove(&id);
    }

    pub fn broadcast(&self, msg: &str) {
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|_id, tx| tx.send(msg.to_string()).is_ok());
    }

    pub fn broadcast_progress(
        &self,
        download_id: &str,
        downloaded: u64,
        total: u64,
        speed_bps: u64,
        eta_secs: u64,
    ) {
        let msg = serde_json::json!({
            "type": "PROGRESS",
            "downloadId": download_id,
            "downloaded": downloaded,
            "total": total,
            "speedBps": speed_bps,
            "etaSecs": eta_secs,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_ack(&self, download_id: &str, file_name: &str, status: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_ACK",
            "downloadId": download_id,
            "fileName": file_name,
            "status": status,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_completed(&self, download_id: &str, status: &str, downloaded: u64, total: u64) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_COMPLETED",
            "downloadId": download_id,
            "status": status,
            "downloaded": downloaded,
            "total": total,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_error(&self, download_id: &str, error: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_ERROR",
            "downloadId": download_id,
            "error": error,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_paused(&self, download_id: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_PAUSED",
            "downloadId": download_id,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_removed(&self, download_id: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_REMOVED",
            "downloadId": download_id,
        })
        .to_string();
        self.broadcast(&msg);
    }

    // ── Playlist broadcasts (backend parity) ───────────────────────────────

    pub fn broadcast_playlist_queued(&self, playlist_id: &str, count: i64, total: i64, folder: &str, title: &str) {
        let msg = serde_json::json!({
            "type": "PLAYLIST_QUEUED",
            "playlistId": playlist_id,
            "count": count,
            "total": total,
            "folder": folder,
            "title": title,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_playlist_removed(&self, playlist_id: &str) {
        let msg = serde_json::json!({
            "type": "PLAYLIST_REMOVED",
            "playlistId": playlist_id,
        })
        .to_string();
        self.broadcast(&msg);
    }
}

pub struct WsState {
    pub app: Arc<AppState>,
    pub clients: Arc<WsClients>,
}

pub async fn start_ws_server(app: Arc<AppState>, clients: Arc<WsClients>, port: u16) {
    // Startup reconciliation (backend parity)
    if let Ok(interrupted) = app.db.list_interrupted_downloads() {
        for row in interrupted {
            // Only auto-resume rows that made real progress. A row with no bytes,
            // no partial file and no resume sidecar is likely a job that fails
            // immediately (dead URL, missing engine, bad cookies); re-running it on
            // every startup just re-fails it. Surface it for a deliberate retry.
            let made_progress = row.downloaded_bytes.unwrap_or(0) > 0
                || crate::util::has_resume_state(Path::new(&row.save_path))
                || Path::new(&row.save_path).exists();
            if !made_progress {
                log::info!("Interrupted download {} had no progress — marking for manual retry", row.id);
                let _ = app.db.update_download_status(&row.id, "failed");
                app.ws_clients
                    .broadcast_error(&row.id, "Interrupted before any data downloaded — click Retry.");
                continue;
            }
            log::info!("Reconciling interrupted download on startup: {}", row.id);
            let _ = app.db.update_download_status(&row.id, "queued");

            let job = crate::scheduler::JobState {
                id: row.id.clone(),
                url: row.url.clone(),
                direct_url: row.direct_url.clone(),
                file_name: row.file_name.clone(),
                save_path: row.save_path.clone(),
                status: "queued".to_string(),
                downloaded: row.downloaded_bytes.unwrap_or(0) as u64,
                total: row.total_bytes.unwrap_or(0) as u64,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
                merge_via_ytdlp: false,
            };
            app.scheduler.enqueue(job);
        }
        if app.scheduler.queue_depth() > 0 {
            crate::download::pump_scheduler(app.clone());
        }
    }

    let ws_state = Arc::new(WsState {
        app,
        clients: clients.clone(),
    });

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(ws_state);

    let listener = bind_ws_listener(port).await;
    log::info!(
        "WebSocket server listening on ws://127.0.0.1:{}/ws (also ws://localhost:{}/ws)",
        port,
        port
    );

    axum::serve(listener, router)
        .await
        .expect("WebSocket server exited with error");
}

/// Bind dual-stack `[::]:port` so `localhost` works when it resolves to `::1`.
/// Falls back to `0.0.0.0` when IPv6 is unavailable.
async fn bind_ws_listener(port: u16) -> tokio::net::TcpListener {
    let v6 = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    match tokio::net::TcpListener::bind(v6).await {
        Ok(listener) => listener,
        Err(e) => {
            log::warn!("IPv6 bind on port {} failed ({}), using 0.0.0.0", port, e);
            let v4 = SocketAddr::from(([0, 0, 0, 0], port));
            tokio::net::TcpListener::bind(v4)
                .await
                .expect("Failed to bind WebSocket server — is port 14921 already in use?")
        }
    }
}

fn verify_origin(headers: &HeaderMap) -> bool {
    let config = Config::from_env();
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if origin.is_empty() {
        return true;
    }
    if origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") {
        if config.allowed_extension_ids.is_empty() {
            return true;
        }
        let id = origin
            .trim_start_matches("chrome-extension://")
            .trim_start_matches("moz-extension://")
            .split('/')
            .next()
            .unwrap_or("");
        return config
            .allowed_extension_ids
            .iter()
            .any(|allowed| allowed == id);
    }
    if let Ok(parsed) = url::Url::parse(origin) {
        return parsed.host_str() == Some("localhost")
            || parsed.host_str() == Some("127.0.0.1");
    }
    false
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    AxumState(state): AxumState<Arc<WsState>>,
) -> Response {
    if !verify_origin(&headers) {
        log::warn!("Rejected WebSocket from disallowed origin");
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: Arc<WsState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let client_id = state.clients.add(msg_tx.clone());
    send_initial_state(&state.app, &msg_tx);

    let forward_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        if let Message::Text(text) = msg {
            handle_message(&text, &state, &msg_tx).await;
        }
    }

    state.clients.remove(client_id);
    forward_task.abort();
}

fn snapshot_status(status: &str) -> &str {
    // Extension popup only shows Retry for status === 'error'.
    match status {
        "failed" | "cancelled" => "error",
        other => other,
    }
}

fn send_initial_state(app: &AppState, tx: &tokio::sync::mpsc::UnboundedSender<String>) {
    // Register the extension device so foreign-key constraints don't fail on download inserts.
    let _ = app.db.upsert_device("extension");
    let _ = app.db.upsert_device("desktop");

    let settings = app.get_ui_settings();
    let path = settings
        .get("baseDirectory")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let _ = tx.send(
        serde_json::json!({
            "type": "DIRECTORY_SELECTED",
            "payload": { "path": path }
        })
        .to_string(),
    );
    let _ = tx.send(
        serde_json::json!({
            "type": "SETTINGS",
            "settings": {
                "maxConcurrentDownloads": settings.get("maxConcurrentDownloads"),
                "defaultThreads": settings.get("defaultThreads"),
                "maxRateBytes": settings.get("maxRateBytes"),
                "baseDirectory": path,
                "engineQuiet": settings.get("engineQuiet"),
                "playlistFormats": settings.get("playlistFormats"),
            }
        })
        .to_string(),
    );

    // Snapshot recent downloads from both extension and desktop so the popup
    // queue matches what the Tauri UI shows after reconnect.
    let mut snapshot: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for device in ["extension", "desktop"] {
        if let Ok(recent) = app.db.list_recent_downloads(device, 30) {
            for d in recent {
                if !seen.insert(d.id.clone()) {
                    continue;
                }
                snapshot.push(serde_json::json!({
                    "downloadId": d.id,
                    "fileName": d.file_name,
                    "status": snapshot_status(&d.status),
                    "downloaded": d.downloaded_bytes.unwrap_or(0),
                    "total": d.total_bytes.unwrap_or(0),
                    "error": if d.status == "failed" || d.status == "error" {
                        serde_json::Value::String("Download failed — click Retry".into())
                    } else {
                        serde_json::Value::Null
                    },
                }));
            }
        }
    }
    if !snapshot.is_empty() {
        let _ = tx.send(
            serde_json::json!({
                "type": "DOWNLOAD_SNAPSHOT",
                "downloads": snapshot,
            })
            .to_string(),
        );
    }
}

/// Strip tracking query parameters from a URL — backend parity.
fn strip_tracking_params(url: &str) -> String {
    if let Ok(mut parsed) = url::Url::parse(url) {
        let tracking_params = [
            "utm_source", "utm_medium", "utm_campaign",
            "igsh", "fbclid", "gclid", "si",
        ];
        let query = parsed.query().unwrap_or("").to_string();
        let pairs: Vec<String> = url::form_urlencoded::parse(query.as_bytes())
            .filter(|(k, _)| !tracking_params.contains(&k.as_ref()))
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        if pairs.is_empty() {
            parsed.set_query(None);
        } else {
            parsed.set_query(Some(&pairs.join("&")));
        }
        parsed.to_string()
    } else {
        url.to_string()
    }
}

async fn handle_message(
    text: &str,
    state: &Arc<WsState>,
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
) {
    let data: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let msg_type = data["type"].as_str().unwrap_or("");
    log::info!("[WS] Received message type: {}", msg_type);

    match msg_type {
        "PING" => {
            let _ = tx.send(serde_json::json!({"type": "PONG"}).to_string());
        }

        "LIST_FORMATS" => {
            let url = data["payload"]["url"].as_str().unwrap_or("").to_string();
            let force = data["payload"]["force"].as_bool().unwrap_or(false);
            let request_id = data["requestId"].as_str().unwrap_or("").to_string();
            let app = state.app.clone();
            let tx = tx.clone();

            // Do not block the WebSocket read loop — prefetches and user clicks share one connection.
            tokio::spawn(async move {
                match download::list_formats_for_url(&app, &url, force).await {
                    Ok(formats) if formats.is_empty() => {
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_ERROR",
                                "requestId": request_id,
                                "error": "No formats found for this URL.",
                            })
                            .to_string(),
                        );
                    }
                    Ok(formats) => {
                        let formats_json: Vec<serde_json::Value> = formats
                            .iter()
                            .map(|f| {
                                serde_json::json!({
                                    "id": f.id,
                                    "label": f.label,
                                    "url": f.url,
                                    "ext": f.ext,
                                    "filesize": f.filesize,
                                    "source": f.source,
                                    "kind": f.kind,
                                })
                            })
                            .collect();
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_LIST",
                                "requestId": request_id,
                                "formats": formats_json,
                            })
                            .to_string(),
                        );
                    }
                    Err(e) => {
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_ERROR",
                                "requestId": request_id,
                                "error": e,
                            })
                            .to_string(),
                        );
                    }
                }
            });
        }

        "NEW_DOWNLOAD" => {
            let payload = &data["payload"];
            let raw_url = payload["url"].as_str().unwrap_or("");
            log::info!("[WS] NEW_DOWNLOAD requested for url: {}", raw_url);
            let direct_url = payload["directUrl"].as_str().map(|s| s.to_string());
            let file_name = payload["fileName"].as_str().unwrap_or("download_file");
            let referer = payload["referer"]
                .as_str()
                .or_else(|| payload["pageUrl"].as_str())
                .map(|s| s.to_string());
            let is_playlist = payload["playlist"].as_bool().unwrap_or(false);

            if raw_url.is_empty() {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DOWNLOAD_ERROR",
                        "downloadId": null,
                        "error": "No URL provided"
                    })
                    .to_string(),
                );
                return;
            }

            // Normalize URL: strip tracking params (backend parity).
            let url = strip_tracking_params(raw_url);

            if !crate::util::is_safe_download_url(&url) {
                log::error!("[WS] Blocked NEW_DOWNLOAD: unsafe download URL: {}", url);
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DOWNLOAD_ERROR",
                        "downloadId": null,
                        "error": "Blocked: download URL points to a private or local network address"
                    })
                    .to_string(),
                );
                return;
            }

            if let Some(ref direct) = direct_url {
                if !crate::util::is_safe_download_url(direct) {
                    log::error!("[WS] Blocked NEW_DOWNLOAD: unsafe direct URL: {}", direct);
                    let _ = tx.send(
                        serde_json::json!({
                            "type": "DOWNLOAD_ERROR",
                            "downloadId": null,
                            "error": "Blocked: direct URL points to a private or local network address"
                        })
                        .to_string(),
                    );
                    return;
                }
            }

            if is_playlist {
                // ── Playlist download (backend parity) ─────────────────────
                let app = state.app.clone();
                let pl_url = url.clone();
                let pl_file_name = file_name.to_string();
                let pl_referer = referer.clone();
                let pl_tx = tx.clone();
                let threads = payload["threads"].as_u64().unwrap_or(8) as u32;

                tokio::spawn(async move {
                    match playlist::queue_playlist_download(
                        &app, &pl_url,
                        Some(&pl_file_name),
                        pl_referer.as_deref(),
                        threads,
                    ).await {
                        Ok((playlist_id, total, title, folder)) => {
                            // Schedule the playlist, broadcast queued event.
                            playlist::schedule_playlist_job(app.clone(), playlist_id.clone());

                            // Tauri event for desktop frontend.
                            app.emit_playlist_queued(
                                &crate::state::PlaylistQueuedEvent {
                                    playlist_id: playlist_id.clone(),
                                    count: total,
                                    total,
                                    folder: folder.clone(),
                                    title: title.clone(),
                                },
                            );

                            // WebSocket broadcast for extension.
                            app.ws_clients.broadcast_playlist_queued(
                                &playlist_id, total, total, &folder, &title,
                            );
                            let _ = pl_tx.send(
                                serde_json::json!({
                                    "type": "PLAYLIST_QUEUED",
                                    "playlistId": playlist_id,
                                    "count": total,
                                    "total": total,
                                    "folder": folder,
                                    "title": title,
                                })
                                .to_string(),
                            );
                        }
                        Err(e) => {
                            let _ = pl_tx.send(
                                serde_json::json!({
                                    "type": "DOWNLOAD_ERROR",
                                    "downloadId": null,
                                    "error": e,
                                })
                                .to_string(),
                            );
                        }
                    }
                });
                return;
            }

            // ── Single download ───────────────────────────────────────────
            let mut download_id = uuid::Uuid::new_v4().to_string();

            // Deduplication & Resume (backend parity)
            if let Ok(Some(existing)) = state.app.db.find_resumable_by_url(&url) {
                let status = existing.status.as_str();
                if matches!(status, "queued" | "downloading") {
                    log::info!("NEW_DOWNLOAD deduplicated (status {}): {}", status, existing.id);
                    let _ = tx.send(
                        serde_json::json!({
                            "type": "DOWNLOAD_ACK",
                            "downloadId": existing.id,
                            "fileName": existing.file_name,
                            "status": status,
                        })
                        .to_string(),
                    );
                    return;
                }
                log::info!("NEW_DOWNLOAD resuming existing download: {}", existing.id);
                download_id = existing.id.clone();
            } else if let Ok(Some(done)) = state.app.db.find_completed_on_disk_by_url(&url) {
                log::info!("NEW_DOWNLOAD deduplicated (completed): {}", done.id);
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DOWNLOAD_ACK",
                        "downloadId": done.id,
                        "fileName": done.file_name,
                        "status": "completed",
                    })
                    .to_string(),
                );
                return;
            }

            let app_state = state.app.clone();
            let base_directory = payload["baseDirectory"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            let threads = payload["threads"].as_u64().map(|t| t as u32);
            let req = StartDownloadRequest {
                url,
                direct_url,
                file_name: file_name.to_string(),
                referer,
                device_id: "extension".to_string(),
                download_id: Some(download_id.clone()),
                save_path: None,
                base_directory,
                threads,
            };

            // Clone tx so the spawned task can send responses back to this client.
            let task_tx = tx.clone();

            tokio::spawn(async move {
                match download::enqueue_download_job(app_state, req).await {
                    Ok(id) => {
                        log::info!("NEW_DOWNLOAD enqueued: {}", id);
                    }
                    Err(e) => {
                        log::error!("NEW_DOWNLOAD failed: {}", e);
                        let _ = task_tx.send(
                            serde_json::json!({
                                "type": "DOWNLOAD_ERROR",
                                "downloadId": null,
                                "error": e,
                            })
                            .to_string(),
                        );
                    }
                }
            });
        }

        "SAVE_BLOB" => {
            // Spawn so large base64 decode + disk write cannot stall the WS read loop.
            let payload = data["payload"].clone();
            let app = state.app.clone();
            let task_tx = tx.clone();
            tokio::spawn(async move {
                let base64 = payload["base64"].as_str().unwrap_or("");
                let file_name = payload["fileName"].as_str().unwrap_or("download");
                let mime = payload["mime"].as_str();
                let source_url = payload["sourceUrl"]
                    .as_str()
                    .or_else(|| payload["pageUrl"].as_str())
                    .unwrap_or("blob:browser");

                match download::save_blob_download(&app, base64, file_name, mime, source_url).await {
                    Ok(id) => log::info!("SAVE_BLOB completed: {}", id),
                    Err(e) => {
                        let _ = task_tx.send(
                            serde_json::json!({
                                "type": "DOWNLOAD_ERROR",
                                "downloadId": null,
                                "error": e,
                            })
                            .to_string(),
                        );
                    }
                }
            });
        }

        "PAUSE_DOWNLOAD" => {
            // Check playlist jobs first (backend parity).
            if let Some(id) = data["downloadId"].as_str() {
                if playlist::is_playlist_running(id) {
                    playlist::pause_playlist_job(id);
                } else {
                    let _ = download::pause_download_job(&state.app, id).await;
                }
            }
        }

        "RESUME_DOWNLOAD" => {
            if let Some(id) = data["downloadId"].as_str() {
                // Check if it's a playlist job
                if let Ok(Some(_)) = state.app.db.get_playlist_job(id) {
                    let app = state.app.clone();
                    let id = id.to_string();
                    tokio::spawn(async move {
                        playlist::resume_playlist_job(app, &id);
                    });
                } else {
                    let app = state.app.clone();
                    let id = id.to_string();
                    let task_tx = tx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = download::resume_download_job(app.clone(), &id).await {
                            log::error!("RESUME_DOWNLOAD failed: {}", e);
                            let _ = app.db.update_download_status(&id, "failed");
                            app.ws_clients.broadcast_error(&id, &e);
                            let _ = task_tx.send(
                                serde_json::json!({
                                    "type": "DOWNLOAD_ERROR",
                                    "downloadId": id,
                                    "error": e,
                                })
                                .to_string(),
                            );
                        }
                    });
                }
            }
        }

        "CANCEL_DOWNLOAD" => {
            // Check playlist jobs first (backend parity).
            if let Some(id) = data["downloadId"].as_str() {
                if playlist::is_playlist_running(id) {
                    playlist::cancel_playlist_job(&state.app, id);
                } else {
                    let _ = download::cancel_download_job(&state.app, id).await;
                }
            }
        }

        "REMOVE_DOWNLOAD" => {
            // Remove from history only (keeps any completed file on disk) — backend parity.
            if let Some(id) = data["downloadId"].as_str() {
                // Check playlist jobs first
                if let Ok(Some(_)) = state.app.db.get_playlist_job(id) {
                    if !playlist::is_playlist_running(id) {
                        let _ = state.app.db.delete_playlist_job(id);
                        state.app.ws_clients.broadcast_playlist_removed(id);
                    }
                } else {
                    let is_running = {
                        let engines = state.app.active_engines.lock().unwrap();
                        engines.contains_key(id)
                    };
                    if !is_running {
                        let _ = state.app.db.delete_download(id);
                        state.app.ws_clients.broadcast_removed(id);
                    }
                }
            }
        }

        "GET_SETTINGS" => {
            // Return merged runtime settings (desktop + extension devices).
            let settings = state.app.get_ui_settings();
            let _ = tx.send(
                serde_json::json!({
                    "type": "SETTINGS",
                    "settings": {
                        "maxConcurrentDownloads": settings.get("maxConcurrentDownloads"),
                        "defaultThreads": settings.get("defaultThreads"),
                        "maxRateBytes": settings.get("maxRateBytes"),
                        "baseDirectory": settings.get("baseDirectory"),
                        "engineQuiet": settings.get("engineQuiet"),
                        "playlistFormats": settings.get("playlistFormats"),
                    }
                })
                .to_string(),
            );
        }

        "SET_SETTINGS" => {
            // Persist on both devices so Tauri UI + extension popup stay in sync.
            if let Some(payload) = data["payload"].as_object() {
                let patch = serde_json::Value::Object(payload.clone());
                state.app.apply_settings_patch(&patch);
                let merged = state.app.get_ui_settings();
                state.app.ws_clients.broadcast(
                    &serde_json::json!({
                        "type": "SETTINGS",
                        "settings": {
                            "maxConcurrentDownloads": merged.get("maxConcurrentDownloads"),
                            "defaultThreads": merged.get("defaultThreads"),
                            "maxRateBytes": merged.get("maxRateBytes"),
                            "baseDirectory": merged.get("baseDirectory"),
                            "engineQuiet": merged.get("engineQuiet"),
                            "playlistFormats": merged.get("playlistFormats"),
                        }
                    })
                    .to_string(),
                );
            }
        }

        "REQUEST_DIRECTORY_PICKER" => {
            // Open graphical folder picker (zenity/kdialog) — backend parity.
            let result = util::pick_directory();
            if let Some(path) = result {
                state.app.apply_settings_patch(&serde_json::json!({
                    "baseDirectory": &path,
                    "base_dir": &path,
                }));

                let _ = tx.send(
                    serde_json::json!({
                        "type": "DIRECTORY_SELECTED",
                        "payload": { "path": path },
                    })
                    .to_string(),
                );
            } else {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DIRECTORY_PICKER_UNAVAILABLE",
                        "error": "No graphical folder picker found. Install zenity or kdialog, or type the path manually."
                    })
                    .to_string(),
                );
            }
        }

        "OPEN_FILE" | "REVEAL_FILE" => {
            let is_reveal = msg_type == "REVEAL_FILE";
            if let Some(id) = data["downloadId"].as_str() {
                if let Ok(Some(row)) = state.app.db.get_download(id) {
                    let path = Path::new(&row.save_path);
                    if !path.exists() {
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "DOWNLOAD_ERROR",
                                "downloadId": id,
                                "error": "File no longer exists on disk."
                            })
                            .to_string(),
                        );
                        return;
                    }
                    let result = if is_reveal {
                        util::reveal_in_folder(&row.save_path)
                    } else {
                        util::open_path(&row.save_path)
                    };
                    if let Err(e) = result {
                        log::error!("Open/reveal failed: {}", e);
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "DOWNLOAD_ERROR",
                                "downloadId": id,
                                "error": e
                            })
                            .to_string(),
                        );
                    }
                }
            }
        }

        _ => {
            log::debug!("Unhandled WebSocket message type: {}", msg_type);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_clients_add_remove() {
        let clients = WsClients::new();
        let (tx, _) = tokio::sync::mpsc::unbounded_channel::<String>();
        let id = clients.add(tx);
        assert!(clients.clients.lock().unwrap().contains_key(&id));
        clients.remove(id);
        assert!(!clients.clients.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn test_broadcast_progress() {
        let clients = WsClients::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        clients.add(tx);
        clients.broadcast_progress("id-1", 500, 1000, 2_500_000, 30);
        let msg = rx.try_recv().unwrap();
        assert!(msg.contains("PROGRESS"));
        assert!(msg.contains("id-1"));
    }

    #[test]
    fn test_verify_extension_origin() {
        let mut headers = HeaderMap::new();
        headers
            .insert(
                "origin",
                "chrome-extension://abcdefghijklmnop".parse().unwrap(),
            );
        assert!(verify_origin(&headers));
    }

    #[test]
    fn test_reject_random_origin() {
        let mut headers = HeaderMap::new();
        headers
            .insert("origin", "https://evil.example".parse().unwrap());
        assert!(!verify_origin(&headers));
    }

    #[test]
    fn test_strip_tracking_params_removes_known_params() {
        let url = "https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link&igsh=abc123&si=def456";
        let result = strip_tracking_params(url);
        assert_eq!(result, "https://www.instagram.com/p/ABC123/");
    }

    #[test]
    fn test_strip_tracking_params_keeps_other_params() {
        let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM";
        let result = strip_tracking_params(url);
        assert_eq!(
            result,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM"
        );
    }

    #[test]
    fn test_strip_tracking_params_invalid_url_returns_original() {
        let url = "not a valid url";
        let result = strip_tracking_params(url);
        assert_eq!(result, "not a valid url");
    }

    #[test]
    fn test_strip_tracking_params_no_params_unchanged() {
        let url = "https://example.com/video.mp4";
        let result = strip_tracking_params(url);
        assert_eq!(result, url);
    }
}
