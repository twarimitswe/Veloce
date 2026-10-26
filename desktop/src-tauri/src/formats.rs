use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, Duration};

/// Platform/media source for a URL.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MediaSource {
    YouTube,
    Instagram,
    TikTok,
    Twitter,
    MediaFire,
    GitHub,
    Direct,
    Generic,
}

/// A single downloadable format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFormat {
    pub id: String,
    pub label: String,
    pub url: String,
    pub ext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesize: Option<u64>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// MediaFire download info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFireInfo {
    pub file_name: String,
    pub direct_url: String,
    pub size_bytes: Option<u64>,
}

struct MediaFireCacheEntry {
    info: MediaFireInfo,
    at: Instant,
}

/// Fresh CDN tokens are reusable briefly — avoids a second ~2–5s page scrape
/// when enqueue already resolved (or resume re-queues within TTL).
static MEDIAFIRE_CDN_CACHE: Lazy<Mutex<HashMap<String, MediaFireCacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const MEDIAFIRE_CDN_TTL: Duration = Duration::from_secs(90);

static MEDIAFIRE_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(4)
        .user_agent(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .gzip(true)
        .brotli(true)
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .expect("mediafire http client")
});

fn mediafire_cache_key(url: &str) -> String {
    url::Url::parse(url)
        .map(|mut u| {
            u.set_query(None);
            u.set_fragment(None);
            let mut s = u.to_string();
            if s.ends_with('/') {
                s.pop();
            }
            s
        })
        .unwrap_or_else(|_| url.trim_end_matches('/').to_string())
}

/// Cache entry for extracted best URLs.
struct CacheEntry {
    url: String,
    ts: Instant,
}

/// Hard entry cap for `FormatCache` — this process is a long-lived tray app, so
/// TTL alone lets the map grow one entry per URL until the next hit expires it.
const FORMAT_CACHE_MAX_ENTRIES: usize = 500;

/// Format cache with TTL + a hard entry cap.
pub struct FormatCache {
    cache: Mutex<HashMap<String, CacheEntry>>,
    ttl: Duration,
}

impl FormatCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let cache = self.cache.lock().unwrap();
        match cache.get(key) {
            Some(entry) if entry.ts.elapsed() < self.ttl => Some(entry.url.clone()),
            _ => None,
        }
    }

    pub fn set(&self, key: &str, url: &str) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= FORMAT_CACHE_MAX_ENTRIES && !cache.contains_key(key) {
            // Drop expired entries first, then the single oldest if still full.
            cache.retain(|_, e| e.ts.elapsed() < self.ttl);
            if cache.len() >= FORMAT_CACHE_MAX_ENTRIES {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, e)| e.ts)
                    .map(|(k, _)| k.clone())
                {
                    cache.remove(&oldest);
                }
            }
        }
        cache.insert(key.to_string(), CacheEntry {
            url: url.to_string(),
            ts: Instant::now(),
        });
    }

    #[allow(dead_code)]
    pub fn invalidate(&self, key: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.remove(key);
    }

    #[allow(dead_code)]
    pub fn clear(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.clear();
    }
}

/// Detect the media source from a URL.
pub fn detect_source(url: &str) -> MediaSource {
    let lower = url.to_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        MediaSource::YouTube
    } else if lower.contains("instagram.com") {
        MediaSource::Instagram
    } else if lower.contains("tiktok.com") {
        MediaSource::TikTok
    } else if lower.contains("twitter.com") || lower.contains("x.com") {
        MediaSource::Twitter
    } else if lower.contains("mediafire.com") {
        MediaSource::MediaFire
    } else if is_github_url(url) {
        MediaSource::GitHub
    } else if is_direct_file_url(url) {
        MediaSource::Direct
    } else {
        MediaSource::Generic
    }
}

/// Check if a URL is a direct file download link.
pub fn is_direct_file_url(url: &str) -> bool {
    let direct_exts = [
        ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".mp3",
        ".wav", ".flac", ".ogg", ".m4a", ".zip", ".rar", ".7z",
        ".tar", ".gz", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".xml",
        ".svg", ".iso", ".txt", ".csv", ".json", ".md", ".yaml", ".yml",
        ".html", ".css", ".js", ".ts",
    ];
    let lower = url.to_lowercase();
    // Must be http(s) and end with a direct file extension
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return false;
    }
    // Strip query string before checking extension
    let without_query = lower.split('?').next().unwrap_or(&lower);
    let without_fragment = without_query.split('#').next().unwrap_or(without_query);
    if without_fragment.contains("github.com") && without_fragment.contains("/blob/") {
        return false;
    }
    direct_exts.iter().any(|ext| without_fragment.ends_with(ext))
}

pub fn is_github_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("raw.githubusercontent.com")
        || (lower.contains("github.com") && lower.contains("/blob/"))
}

pub fn is_github_raw_url(url: &str) -> bool {
    url.to_lowercase().contains("raw.githubusercontent.com")
}

pub fn github_blob_to_raw(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    if host == "raw.githubusercontent.com" {
        return Some(url.to_string());
    }
    if !host.ends_with("github.com") {
        return None;
    }
    static BLOB_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"^/([^/]+)/([^/]+)/blob/([^/]+)/(.+)$").expect("github blob regex")
    });
    let caps = BLOB_RE.captures(parsed.path())?;
    Some(format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        &caps[1], &caps[2], &caps[3], &caps[4]
    ))
}

pub fn resolve_list_url(url: &str) -> String {
    github_blob_to_raw(url).unwrap_or_else(|| url.to_string())
}

/// True when the URL should go through yt-dlp (video/social platforms).
pub fn is_extractor_domain(url: &str) -> bool {
    matches!(
        detect_source(url),
        MediaSource::YouTube
            | MediaSource::Instagram
            | MediaSource::TikTok
            | MediaSource::Twitter
            | MediaSource::MediaFire
    )
}

/// Instagram reel and /p/ URLs share the same shortcode — try both if one fails.
pub fn instagram_url_variants(url: &str) -> Vec<String> {
    if !url.to_lowercase().contains("instagram.com") {
        return vec![normalize_url(url)];
    }

    let mut variants = std::collections::HashSet::new();
    variants.insert(normalize_url(url));

    if let Some(caps) = regex::Regex::new(r"(?i)instagram\.com/(reel|p|tv)/([^/?#]+)")
        .ok()
        .and_then(|re| re.captures(url))
    {
        let kind = caps.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        let code = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if !code.is_empty() {
            variants.insert(format!("https://www.instagram.com/p/{code}"));
            variants.insert(format!("https://www.instagram.com/reel/{code}"));
            if kind == "tv" {
                variants.insert(format!("https://www.instagram.com/tv/{code}"));
            }
        }
    }

    if let Some(caps) = regex::Regex::new(r"(?i)instagram\.com/stories/([^/?#]+)(?:/(\d+))?")
        .ok()
        .and_then(|re| re.captures(url))
    {
        let user = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        if let Some(story_id) = caps.get(2).map(|m| m.as_str()) {
            variants.insert(format!("https://www.instagram.com/stories/{user}/{story_id}"));
        }
        variants.insert(format!("https://www.instagram.com/stories/{user}"));
    }

    variants.into_iter().collect()
}

/// HLS/DASH manifest URLs need special handling (omit directUrl → re-extract).
pub fn is_manifest_format_url(url: &str) -> bool {
    if url.is_empty() {
        return false;
    }
    if let Ok(parsed) = url::Url::parse(url) {
        let host = parsed.host_str().unwrap_or("").to_lowercase();
        // YouTube HLS/DASH host — playlist body must never be fed to core_engine as a file.
        if host == "manifest.googlevideo.com" || host.ends_with(".manifest.googlevideo.com") {
            return true;
        }
    }
    let lower = url.to_lowercase();
    lower.contains(".m3u8")
        || lower.contains(".mpd")
        || lower.contains("/manifest/")
        || lower.contains("playlist_type")
        || lower.contains("format=m3u8")
}

/// True for /p/, /reel/, /tv/, /stories/… — not the Instagram homepage or profile root.
pub fn is_instagram_media_page_url(url: &str) -> bool {
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)/(p|reel|reels|tv|stories)/").expect("ig media path"));
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !host.contains("instagram.com") {
        return false;
    }
    RE.is_match(parsed.path())
}

/// OmniSave / MovieBox / netfilm catalog pages — media URLs come from site API intercept only.
pub fn is_intercept_catalog_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    host.contains("videodownloader.site")
        || host.contains("moviebox.")
        || host.contains("netfilm.")
        || host.contains("aoneroom.com")
}

/// Redirect/API/graphql trap URLs — backend parity.
pub fn is_trap_download_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if lower.contains("/redirect") || lower.contains("/pkg/")
        || lower.contains("/api/") || lower.contains("/graphql")
        || lower.contains("/download?")
    {
        return true;
    }
    // Check query parameter 'a' for redirect/download
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(a) = parsed.query_pairs().find(|(k, _)| k == "a") {
            let val = a.1.to_lowercase();
            if val.contains("redirect") || val.contains("download") {
                return true;
            }
        }
    }
    false
}

/// Soft-fail TTL: Instagram stays failed longer (cookies / empty media recover slowly).
pub fn fail_cache_ttl_secs(source: MediaSource) -> u64 {
    match source {
        MediaSource::Instagram => 5 * 60,
        _ => 90,
    }
}

/// User-facing error matched to the URL platform — never a cross-site message.
pub fn fail_reason_for_source(source: MediaSource, last_err: Option<&str>) -> String {
    let err = last_err.unwrap_or("").to_lowercase();

    match source {
        MediaSource::Instagram => {
            if err.contains("empty media") {
                return "Instagram blocked yt-dlp for this post. Stay logged in to Instagram in Chrome (not only Chromium), reload the post, then click the Veloce badge again. Image-only posts have no video.".into();
            }
            if err.contains("story") || err.contains("stories") {
                return "Instagram story extraction failed. Stay logged in to Chrome, open the video story, then click the Veloce badge. Photo-only stories have no video stream.".into();
            }
            "Instagram returned no formats. Log in to Instagram in Chrome, reload the page, and retry.".into()
        }
        MediaSource::YouTube => {
            if err.contains("challenge solving")
                || err.contains("signature solving")
                || err.contains("only images are available")
            {
                return "YouTube blocked format extraction (JS challenge). Ensure Node.js is installed on your system, restart Veloce, then retry from the badge.".into();
            }
            if err.contains("not available") || err.contains("private") {
                return "YouTube reports this video is unavailable (region, sign-in, or age gate). Open it in your browser, sign in if needed, then retry from the Veloce badge.".into();
            }
            if err.contains("requested format is not available") {
                return "YouTube returned no progressive formats for this video. Retry with the Veloce badge — alternate player clients will be tried.".into();
            }
            "YouTube returned no formats. Sign in to YouTube in Chrome and retry.".into()
        }
        MediaSource::TikTok => {
            "TikTok returned no formats. Open the video in your browser while logged in, then retry.".into()
        }
        MediaSource::Twitter => {
            "X/Twitter returned no formats. Open the post in your browser while logged in, then retry.".into()
        }
        _ => {
            if let Some(raw) = last_err.filter(|s| !s.is_empty()) {
                if raw.len() > 240 {
                    format!("{}…", &raw[..237])
                } else {
                    raw.to_string()
                }
            } else {
                "No downloadable formats found for this URL.".into()
            }
        }
    }
}

/// Normalize a URL for consistent caching.
pub fn normalize_url(url: &str) -> String {
    let lower = url.to_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        // Extract video ID and build canonical URL
        if let Some(id) = extract_youtube_id(url) {
            return format!("https://www.youtube.com/watch?v={}", id);
        }
    }
    if lower.contains("instagram.com") {
        // Strip query; map /reels/ → /reel/ so feed + viewer share one cache key.
        let no_query = url.split('?').next().unwrap_or(url).trim_end_matches('/');
        return no_query.replace("/reels/", "/reel/").replace("/Reels/", "/reel/");
    }
    // Default: strip query string
    url.split('?').next().unwrap_or(url).trim_end_matches('/').to_string()
}

fn extract_youtube_id(url: &str) -> Option<String> {
    // Handle youtu.be/ID
    if let Some(short) = url.split("youtu.be/").nth(1) {
        return short.split('?').next().map(|s| s.split('/').next().unwrap_or(s).to_string());
    }
    // Handle youtube.com/watch?v=ID
    if url.contains("youtube.com/watch") {
        if let Ok(parsed) = url::Url::parse(url) {
            for (key, value) in parsed.query_pairs() {
                if key == "v" && !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    // Handle youtube.com/shorts/ID
    if let Some(shorts) = url.split("youtube.com/shorts/").nth(1) {
        return Some(shorts.split('?').next().unwrap_or(shorts).split('/').next().unwrap_or(shorts).to_string());
    }
    None
}

pub async fn resolve_mediafire(url: &str) -> Result<MediaFireInfo, String> {
    let key = mediafire_cache_key(url);
    {
        let cache = MEDIAFIRE_CDN_CACHE.lock().unwrap();
        if let Some(entry) = cache.get(&key) {
            if entry.at.elapsed() < MEDIAFIRE_CDN_TTL {
                log::info!(
                    "[MediaFire] CDN cache hit (age {}s) — skip page scrape",
                    entry.at.elapsed().as_secs()
                );
                return Ok(entry.info.clone());
            }
        }
    }

    log::info!("[MediaFire] Fetching page HTML for {}", url);
    let client = &*MEDIAFIRE_HTTP;

    let mut last_err = String::new();
    for attempt in 1..=3 {
        log::info!("[MediaFire] Page fetch attempt {attempt}/3");
        match fetch_mediafire_html(client, url).await {
            Ok(html) => {
                log::info!(
                    "[MediaFire] Page fetched ({} bytes). Extracting CDN link...",
                    html.len()
                );

                let file_name = extract_meta_content(&html, "og:title")
                    .or_else(|| extract_title(&html))
                    .unwrap_or_else(|| "mediafire_file".to_string());

                let direct_url = extract_mediafire_download_url(&html).ok_or_else(|| {
                    "Could not find download link on MediaFire page".to_string()
                })?;

                let size_bytes = extract_mediafire_size(&html);
                let info = MediaFireInfo {
                    file_name,
                    direct_url,
                    size_bytes,
                };
                MEDIAFIRE_CDN_CACHE.lock().unwrap().insert(
                    key,
                    MediaFireCacheEntry {
                        info: info.clone(),
                        at: Instant::now(),
                    },
                );
                log::info!("[MediaFire] CDN URL ready (cached {}s)", MEDIAFIRE_CDN_TTL.as_secs());
                return Ok(info);
            }
            Err(e) => {
                last_err = e;
                log::warn!("[MediaFire] Attempt {attempt} failed: {last_err}");
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(250 * attempt as u64)).await;
                }
            }
        }
    }

    Err(last_err)
}

async fn fetch_mediafire_html(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch MediaFire page: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("MediaFire HTTP {}", resp.status()));
    }

    // Prefer bytes → UTF-8 so a partial decode still yields scrapeable HTML.
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read MediaFire page: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let search = format!("property=\"{}\"", property);
    // Try pattern: <meta property="og:title" content="..." />
    let start = html.find(&search)?;
    let rest = &html[start..];
    let content_start = rest.find("content=\"")?;
    let value_start = content_start + 9;
    let value_end = rest[value_start..].find('\"')?;
    Some(rest[value_start..value_start + value_end].to_string())
}

fn extract_title(html: &str) -> Option<String> {
    let start = html.find("<title>")?;
    let end = html[start + 7..].find("</title>")?;
    Some(html[start + 7..start + 7 + end].trim().to_string())
}

fn extract_mediafire_download_url(html: &str) -> Option<String> {
    // Pattern 0 (primary): regex — finds any href pointing to a mediafire.com CDN.
    // Works regardless of attribute order (TypeScript backend parity).
    static MF_DOWNLOAD_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r###"href="(https?://download\d+\.mediafire\.com[^"]+)"###)
            .expect("mediafire download url regex")
    });
    if let Some(caps) = MF_DOWNLOAD_RE.captures(html) {
        return Some(caps[1].to_string());
    }

    // Fallback: look backwards from downloadButton for an href attribute.
    if let Some(start) = html.find("id=\"downloadButton\"") {
        // Search backwards from the id position for href="..."
        let before = &html[..start];
        if let Some(href_start) = before.rfind("href=\"") {
            let url_start = href_start + 6;
            let quote_end = html[url_start..].find('\"')?;
            let url = &html[url_start..url_start + quote_end];
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }

    // Legacy fallback patterns
    // Pattern: download_link class
    if let Some(start) = html.find("class=\"download_link\"") {
        let rest = &html[start..];
        if let Some(href_start) = rest.find("href=\"") {
            let url_start = href_start + 6;
            let url_end = rest[url_start..].find('\"')?;
            let url = &rest[url_start..url_start + url_end];
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn extract_mediafire_size(html: &str) -> Option<u64> {
    // Look for file size text like "102.4 MB"
    let patterns = ["class=\"file_size\"", "class=\"details\"", "\"size\""];
    for pattern in &patterns {
        if let Some(start) = html.find(pattern) {
            let end = (start + 200).min(html.len());
            let section = &html[start..end];
            // Find numbers followed by KB/MB/GB
            for line in section.lines() {
                if let Some(size) = parse_size_string(line) {
                    return Some(size);
                }
            }
        }
    }
    None
}

static SIZE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"([\d.]+)\s*(B|KB|MB|GB)").expect("Invalid size regex")
});

fn parse_size_string(s: &str) -> Option<u64> {
    let s = s.trim();
    let caps = SIZE_RE.captures(s)?;
    let num: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps.get(2)?.as_str();
    let bytes = match unit {
        "B" => num,
        "KB" => num * 1024.0,
        "MB" => num * 1024.0 * 1024.0,
        "GB" => num * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(bytes as u64)
}

/// Format bytes into human-readable string.
pub fn format_bytes(n: u64) -> String {
    crate::util::format_bytes(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_source ────────────────────────────────────────────────────

    #[test]
    fn test_detect_source_youtube() {
        assert_eq!(detect_source("https://youtube.com/watch?v=dQw4w9WgXcQ"), MediaSource::YouTube);
        assert_eq!(detect_source("https://youtu.be/dQw4w9WgXcQ"), MediaSource::YouTube);
        assert_eq!(detect_source("https://www.youtube.com/shorts/abc123"), MediaSource::YouTube);
        assert_eq!(detect_source("HTTP://YOUTUBE.COM/WATCH?V=ID"), MediaSource::YouTube);
    }

    #[test]
    fn test_detect_source_instagram() {
        assert_eq!(detect_source("https://instagram.com/p/ABC123/"), MediaSource::Instagram);
        assert_eq!(detect_source("https://www.instagram.com/reel/DEF456/"), MediaSource::Instagram);
        assert_eq!(detect_source("https://instagram.com/stories/user/123/"), MediaSource::Instagram);
    }

    #[test]
    fn test_detect_source_tiktok() {
        assert_eq!(detect_source("https://tiktok.com/@user/video/123"), MediaSource::TikTok);
        assert_eq!(detect_source("https://www.tiktok.com/@user/photo/456"), MediaSource::TikTok);
    }

    #[test]
    fn test_detect_source_twitter() {
        assert_eq!(detect_source("https://twitter.com/user/status/123"), MediaSource::Twitter);
        assert_eq!(detect_source("https://x.com/user/status/456"), MediaSource::Twitter);
    }

    #[test]
    fn test_detect_source_mediafire() {
        assert_eq!(detect_source("https://www.mediafire.com/file/abc/file.zip/file"), MediaSource::MediaFire);
    }

    #[test]
    fn test_is_intercept_catalog_url() {
        assert!(is_intercept_catalog_url(
            "https://videodownloader.site/?q=Absolutely%20Anything"
        ));
        assert!(is_intercept_catalog_url("https://www.moviebox.ph/moviedetail/x"));
        assert!(!is_intercept_catalog_url(
            "https://bcdnxw.hakunaymatata.com/file.mp4"
        ));
        assert!(!is_intercept_catalog_url("https://www.youtube.com/watch?v=x"));
    }

    #[test]
    fn test_detect_source_direct() {
        assert_eq!(detect_source("https://cdn.example.com/video.mp4"), MediaSource::Direct);
        assert_eq!(detect_source("https://example.com/file.mp4?token=abc"), MediaSource::Direct);
        assert_eq!(detect_source("https://example.com/image.png"), MediaSource::Direct);
    }

    #[test]
    fn test_detect_source_generic() {
        assert_eq!(detect_source("https://example.com/page"), MediaSource::Generic);
        assert_eq!(detect_source("https://someblog.com/article"), MediaSource::Generic);
    }

    #[test]
    fn test_detect_source_unknown() {
        assert_eq!(detect_source("not-a-url"), MediaSource::Generic);
        assert_eq!(detect_source(""), MediaSource::Generic);
    }

    // ── is_direct_file_url ──────────────────────────────────────────────

    #[test]
    fn test_is_direct_file_url_positive() {
        assert!(is_direct_file_url("https://example.com/video.mp4"));
        assert!(is_direct_file_url("https://example.com/file.mp4?token=abc"));
        assert!(is_direct_file_url("https://example.com/image.png#fragment"));
        assert!(is_direct_file_url("https://cdn.example.com/archive.zip"));
        assert!(is_direct_file_url("HTTP://EXAMPLE.COM/VIDEO.MP4"));
    }

    #[test]
    fn test_is_direct_file_url_negative() {
        assert!(!is_direct_file_url("https://example.com/page"));
        // .html IS a direct extension per backend parity (backend includes html/css/js/ts)
        assert!(is_direct_file_url("https://example.com/video.html"));
        assert!(!is_direct_file_url("not-a-url.mp4"));
        assert!(!is_direct_file_url(""));
        assert!(!is_direct_file_url("ftp://example.com/file.mp4"));
    }

    // ── normalize_url ───────────────────────────────────────────────────

    #[test]
    fn test_normalize_url_youtube_canonical() {
        assert_eq!(
            normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_strips_playlist() {
        assert_eq!(
            normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_short() {
        assert_eq!(
            normalize_url("https://youtu.be/dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_shorts() {
        assert_eq!(
            normalize_url("https://www.youtube.com/shorts/abc123"),
            "https://www.youtube.com/watch?v=abc123"
        );
    }

    #[test]
    fn test_normalize_url_instagram() {
        assert_eq!(
            normalize_url("https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link"),
            "https://www.instagram.com/p/ABC123"
        );
    }

    #[test]
    fn test_normalize_url_instagram_reels_to_reel() {
        assert_eq!(
            normalize_url("https://www.instagram.com/reels/AbCdEf/?igsh=1"),
            "https://www.instagram.com/reel/AbCdEf"
        );
    }

    #[test]
    fn test_normalize_url_generic() {
        assert_eq!(
            normalize_url("https://example.com/page?query=param"),
            "https://example.com/page"
        );
    }

    #[test]
    fn test_normalize_url_strips_trailing_slash() {
        assert_eq!(
            normalize_url("https://example.com/page/"),
            "https://example.com/page"
        );
    }

    #[test]
    fn test_normalize_url_instagram_reel_strips_query() {
        assert_eq!(
            normalize_url("https://www.instagram.com/reel/AbCd/?igsh=1"),
            "https://www.instagram.com/reel/AbCd"
        );
    }

    #[test]
    fn test_normalize_url_instagram_story() {
        assert_eq!(
            normalize_url("https://www.instagram.com/stories/li_estas_leul/345678901234/?utm=x"),
            "https://www.instagram.com/stories/li_estas_leul/345678901234"
        );
        assert_eq!(
            normalize_url("https://www.instagram.com/stories/user/"),
            "https://www.instagram.com/stories/user"
        );
    }

    #[test]
    fn test_instagram_url_variants_reel_and_post() {
        let variants = instagram_url_variants("https://www.instagram.com/reel/AbCd123/?igsh=x");
        assert!(variants.contains(&"https://www.instagram.com/reel/AbCd123".to_string()));
        assert!(variants.contains(&"https://www.instagram.com/p/AbCd123".to_string()));
    }

    #[test]
    fn test_instagram_url_variants_story() {
        let variants =
            instagram_url_variants("https://www.instagram.com/stories/someuser/999/?x=1");
        assert!(variants.contains(&"https://www.instagram.com/stories/someuser/999".to_string()));
        assert!(variants.contains(&"https://www.instagram.com/stories/someuser".to_string()));
    }

    #[test]
    fn test_is_extractor_domain() {
        assert!(is_extractor_domain("https://www.youtube.com/watch?v=x"));
        assert!(is_extractor_domain("https://youtu.be/x"));
        assert!(is_extractor_domain("https://www.instagram.com/reel/x"));
        assert!(is_extractor_domain("https://www.mediafire.com/file/x/y"));
        assert!(!is_extractor_domain("https://example.com/a.mp4"));
        assert!(!is_extractor_domain("bad url"));
    }

    #[test]
    fn test_is_manifest_format_url() {
        assert!(is_manifest_format_url("https://cdn.example.com/stream.m3u8?sig=1"));
        assert!(is_manifest_format_url("https://cdn.example.com/manifest.mpd"));
        assert!(is_manifest_format_url(
            "https://cdn.example.com/manifest/hls/index"
        ));
        assert!(is_manifest_format_url(
            "https://cdn.example.com/play?format=m3u8&token=1"
        ));
        assert!(is_manifest_format_url(
            "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/id/x"
        ));
        assert!(!is_manifest_format_url(
            "https://googlevideo.com/videoplayback?id=1&itag=22"
        ));
    }

    #[test]
    fn test_is_instagram_media_page_url() {
        assert!(is_instagram_media_page_url(
            "https://www.instagram.com/reel/AbCd/"
        ));
        assert!(is_instagram_media_page_url("https://www.instagram.com/p/AbCd/"));
        assert!(is_instagram_media_page_url(
            "https://www.instagram.com/stories/user/123"
        ));
        assert!(!is_instagram_media_page_url("https://www.instagram.com/"));
        assert!(!is_instagram_media_page_url(
            "https://www.instagram.com/someuser/"
        ));
    }

    #[test]
    fn test_fail_cache_ttl_instagram_longer() {
        assert_eq!(fail_cache_ttl_secs(MediaSource::Instagram), 300);
        assert_eq!(fail_cache_ttl_secs(MediaSource::YouTube), 90);
    }

    #[test]
    fn test_fail_reason_for_source_platform_specific() {
        let ig = fail_reason_for_source(MediaSource::Instagram, Some("empty media response"));
        assert!(ig.contains("Instagram"));
        assert!(!ig.to_lowercase().contains("youtube"));
        let yt = fail_reason_for_source(MediaSource::YouTube, Some("challenge solving failed"));
        assert!(yt.contains("YouTube"));
        assert!(yt.contains("Node"));
    }

    #[test]
    fn test_github_blob_to_raw() {
        assert_eq!(
            github_blob_to_raw("https://github.com/o/r/blob/main/file.xml"),
            Some("https://raw.githubusercontent.com/o/r/main/file.xml".to_string())
        );
        assert_eq!(
            github_blob_to_raw("https://raw.githubusercontent.com/o/r/main/file.xml"),
            Some("https://raw.githubusercontent.com/o/r/main/file.xml".to_string())
        );
    }

    #[test]
    fn test_resolve_list_url_github() {
        assert_eq!(
            resolve_list_url("https://github.com/o/r/blob/main/readme.md"),
            "https://raw.githubusercontent.com/o/r/main/readme.md"
        );
    }

    #[test]
    fn test_parse_size_string() {
        assert_eq!(parse_size_string("102.4 MB"), Some(107_374_182));
        assert_eq!(parse_size_string("512 KB"), Some(524_288));
        assert_eq!(parse_size_string("no size"), None);
    }

    #[test]
    fn test_extract_mediafire_download_url_download_link_class() {
        let html = r#"<a class="download_link" href="https://download2393.mediafire.com/abc/key/file.zip">Download</a>"#;
        assert_eq!(
            extract_mediafire_download_url(html),
            Some("https://download2393.mediafire.com/abc/key/file.zip".to_string())
        );
    }

    #[test]
    fn test_extract_mediafire_download_url_href_before_id() {
        // Actual MediaFire HTML: href comes before id="downloadButton"
        let html = r#"<a class="input popsok" href="https://download2447.mediafire.com/abc123/key/video.mp4" id="downloadButton">Download</a>"#;
        assert_eq!(
            extract_mediafire_download_url(html),
            Some("https://download2447.mediafire.com/abc123/key/video.mp4".to_string())
        );
    }

    #[test]
    fn test_extract_mediafire_download_url_regex_anywhere() {
        // Regex pattern finds the CDN URL regardless of surrounding markup
        let html = r#"<div class="dl-btn-wrap"><a href="https://download999.mediafire.com/some/token/file.mkv" class="input">Grab</a></div>"#;
        assert_eq!(
            extract_mediafire_download_url(html),
            Some("https://download999.mediafire.com/some/token/file.mkv".to_string())
        );
    }

    #[test]
    fn test_extract_mediafire_size() {
        let html = r#"<span class="file_size">12.5 MB</span>"#;
        assert_eq!(extract_mediafire_size(html), Some(13_107_200));
    }

    #[test]
    fn test_detect_source_github() {
        assert_eq!(
            detect_source("https://github.com/o/r/blob/main/file.xml"),
            MediaSource::GitHub
        );
        assert_eq!(
            detect_source("https://raw.githubusercontent.com/o/r/main/file.xml"),
            MediaSource::GitHub
        );
    }

    #[test]
    fn test_is_direct_file_url_rejects_github_blob_pages() {
        assert!(!is_direct_file_url(
            "https://github.com/o/r/blob/main/file.xml"
        ));
    }

    // ── FormatCache ─────────────────────────────────────────────────────

    #[test]
    fn test_format_cache_set_and_get() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        assert_eq!(cache.get("key1"), Some("value1".to_string()));
    }

    #[test]
    fn test_format_cache_miss() {
        let cache = FormatCache::new(60);
        assert_eq!(cache.get("nonexistent"), None);
    }

    #[test]
    fn test_format_cache_invalidate() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        cache.invalidate("key1");
        assert_eq!(cache.get("key1"), None);
    }

    #[test]
    fn test_format_cache_clear() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        cache.set("key2", "value2");
        cache.clear();
        assert_eq!(cache.get("key1"), None);
        assert_eq!(cache.get("key2"), None);
    }

    #[test]
    fn test_format_cache_overwrite() {
        let cache = FormatCache::new(60);
        cache.set("key1", "old");
        cache.set("key1", "new");
        assert_eq!(cache.get("key1"), Some("new".to_string()));
    }

    #[test]
    fn test_format_cache_ttl_expires() {
        let cache = FormatCache::new(0); // 0 second TTL = immediate expiry
        cache.set("key1", "value1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert_eq!(cache.get("key1"), None);
    }

    // ── format_bytes ────────────────────────────────────────────────────

    #[test]
    fn test_format_bytes_zero() {
        assert_eq!(format_bytes(0), "0.0 B");
    }

    #[test]
    fn test_format_bytes_bytes() {
        assert_eq!(format_bytes(500), "500.0 B");
    }

    #[test]
    fn test_format_bytes_kilobytes() {
        assert_eq!(format_bytes(2048), "2.0 KB");
    }

    #[test]
    fn test_format_bytes_megabytes() {
        assert_eq!(format_bytes(5_242_880), "5.0 MB");
    }

    #[test]
    fn test_format_bytes_gigabytes() {
        assert_eq!(format_bytes(10_737_418_240), "10.0 GB");
    }

    #[test]
    fn test_format_bytes_boundary() {
        // 1023 bytes should still show as bytes
        assert_eq!(format_bytes(1023), "1023.0 B");
        // 1024 bytes = 1 KB
        assert_eq!(format_bytes(1024), "1.0 KB");
    }
}

