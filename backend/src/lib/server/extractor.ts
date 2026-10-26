import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	detectMediaSource,
	failCacheTtlMs,
	failReasonForSource,
	inferFormatKind,
	isManifestFormatUrl,
	type FormatKind,
	type MediaSource
} from './formatSources';
import { githubBlobToRaw, isGithubRawUrl, resolveGithubDownloadUrl } from './github';
import { decodeRemoteFileName, sanitizeFileName, sanitizeDownloadMediaUrl } from './util';

const requireFromHere = createRequire(import.meta.url);
const EXTRACTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
/** backend/ root whether running from src or Vite SSR bundle. */
function backendRoot(): string {
	// Prefer process.cwd() when `pnpm dev` is run from backend/
	const cwd = process.cwd();
	if (fs.existsSync(path.join(cwd, 'bin', 'yt-dlp')) || fs.existsSync(path.join(cwd, 'package.json'))) {
		return cwd;
	}
	// Fall back from this file: src/lib/server → backend/
	return path.resolve(EXTRACTOR_DIR, '../../..');
}

export type { FormatKind, MediaSource };

export type AvStream = 'both' | 'video' | 'audio';

export interface MediaFormat {
	id: string;
	label: string;
	url: string;
	ext: string;
	filesize?: number;
	/** Preferred save name (MediaFire / direct). Extension includes this when set. */
	fileName?: string;
	/** Platform that produced this format (youtube, instagram, …). */
	source?: MediaSource;
	/** How the engine should fetch it. */
	kind?: FormatKind;
	/** Whether the stream includes video, audio, or both (YouTube DASH). */
	av?: AvStream;
}

function fileNameFromRemoteUrl(url: string): string {
	try {
		const raw = path.basename(new URL(url).pathname) || 'download';
		return sanitizeFileName(decodeRemoteFileName(raw) || 'download');
	} catch {
		return 'download';
	}
}

function formatBytesShort(n: number): string {
	if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
	if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${n} B`;
}

/** Single-file row for MediaFire / CDN / GitHub raw. */
function directFileFormat(
	url: string,
	rawName: string,
	source: MediaSource,
	filesize?: number
): MediaFormat {
	const fromUrl = fileNameFromRemoteUrl(url);
	let decoded = sanitizeFileName(decodeRemoteFileName(rawName) || fromUrl);
	const ext = path.extname(decoded) || path.extname(fromUrl) || '.bin';
	if (!path.extname(decoded)) decoded = `${decoded}${ext}`;
	const label =
		filesize && filesize > 0 ? `${decoded} — ${formatBytesShort(filesize)}` : decoded;
	return {
		id: 'direct',
		label,
		url,
		ext,
		fileName: decoded,
		filesize,
		source,
		kind: 'direct'
	};
}

const EXTRACTOR_DOMAINS = [
	'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com',
	'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'
];

/**
 * Insertion-ordered map with a hard entry cap. Prevents the in-memory caches
 * from growing without bound over a long-running coordinator process: on insert
 * of a new key past `capacity`, the oldest entry is evicted (FIFO). Per-entry
 * TTL is still enforced by callers on read, so stale entries never surface —
 * this only bounds total footprint.
 */
class BoundedMap<K, V> extends Map<K, V> {
	constructor(private readonly capacity: number) {
		super();
	}
	set(key: K, value: V): this {
		if (!this.has(key) && this.size >= this.capacity) {
			const oldest = this.keys().next().value as K | undefined;
			if (oldest !== undefined) this.delete(oldest);
		}
		return super.set(key, value);
	}
}

/**
 * Global cap on concurrent yt-dlp child processes across every path (format
 * races, best-URL extraction, playlist listing, merge downloads). Without this,
 * a `force:true` badge click during two prefetches plus a merge job could spawn
 * a dozen `yt-dlp -J` processes at once (~50–150 MB RSS each) and thrash a
 * low-RAM machine into the 50 s SW timeout. Extra attempts queue instead.
 */
const YTDLP_MAX_CONCURRENT = 3;
let ytdlpActive = 0;
const ytdlpWaiters: Array<() => void> = [];
/** Largest yt-dlp stdout we will buffer before killing the child (JSON blowout guard). */
const YTDLP_MAX_STDOUT_BYTES = 24 * 1024 * 1024;

function acquireYtdlpSlot(): Promise<() => void> {
	return new Promise<void>((resolve) => {
		if (ytdlpActive < YTDLP_MAX_CONCURRENT) {
			ytdlpActive++;
			resolve();
		} else {
			ytdlpWaiters.push(() => {
				ytdlpActive++;
				resolve();
			});
		}
	}).then(() => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			ytdlpActive--;
			ytdlpWaiters.shift()?.();
		};
	});
}

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_CACHE_TTL_MS = 90 * 1000;
const formatCache = new BoundedMap<string, { formats: MediaFormat[]; ts: number }>(400);
const failCache = new BoundedMap<string, { reason: string; ts: number; source?: MediaSource }>(400);
const inflight = new Map<string, Promise<MediaFormat[]>>();

/** Browsers to try for cookie auth — chrome first (most users log in there). */
const COOKIE_BROWSER_ORDER = ['chrome', 'chromium', 'firefox', 'brave'] as const;

const BROWSER_COOKIE_PATHS: Partial<Record<(typeof COOKIE_BROWSER_ORDER)[number], string>> = {
	chrome: path.join(os.homedir(), '.config/google-chrome/Default/Cookies'),
	chromium: path.join(os.homedir(), '.config/chromium/Default/Cookies'),
	brave: path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser/Default/Cookies')
};

/** Skip browsers with no cookie DB (avoids brave spam on machines without Brave). */
function availableCookieBrowsers(): (typeof COOKIE_BROWSER_ORDER)[number][] {
	const out: (typeof COOKIE_BROWSER_ORDER)[number][] = [];
	for (const browser of COOKIE_BROWSER_ORDER) {
		if (browser === 'firefox') {
			out.push(browser);
			continue;
		}
		const cookiePath = BROWSER_COOKIE_PATHS[browser];
		if (cookiePath && fs.existsSync(cookiePath)) out.push(browser);
	}
	return out.length ? out : ['chrome'];
}

/** Chrome cookie decrypt often fails on Linux without a keyring helper yt-dlp uses.
 * Skip that browser for the rest of this process after one hard fail. */
const cookieBrowserSkip = new Set<string>();

function markCookieBrowserBad(browser: string, reason: string) {
	if (!browser || cookieBrowserSkip.has(browser)) return;
	if (
		/secretstorage/i.test(reason) ||
		/could not find .* cookies database/i.test(reason) ||
		/failed to decrypt/i.test(reason) ||
		/Could not copy Chrome cookie/i.test(reason)
	) {
		cookieBrowserSkip.add(browser);
		console.warn(
			`[Extractor] cookie browser "${browser}" unusable — will not retry this process. Reason: ${reason.slice(0, 160)}`
		);
	}
}

/** Prefer Firefox first: Chrome cookie decrypt on Linux often fails inside yt-dlp (Python). */
function cookieBrowsersForAttempt(force: boolean): string[] {
	const available = availableCookieBrowsers().filter((b) => !cookieBrowserSkip.has(b));
	const preferred = [
		...available.filter((b) => b === 'firefox'),
		...available.filter((b) => b !== 'firefox')
	];
	const list = preferred.length ? preferred : ['firefox'];
	if (force) return list.slice(0, 4);
	return list.slice(0, 2);
}

/**
 * YouTube requires solving JS challenges (n-parameter / signatures). yt-dlp needs a JS runtime.
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 */
function ytdlpSharedArgs(): string[] {
	return ['--js-runtimes', 'node'];
}

const INSTAGRAM_FAIL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cache for direct URLs used by extractMediaUrl().
 * Prefer seeding from listFormats() (Best / first progressive URL) so download
 * after a format list does not spawn a second yt-dlp. Still filled by -f b -g
 * when the caller omitted directUrl and no seed exists.
 */
const BEST_URL_CACHE_TTL_MS = 10 * 60 * 1000; // same as format cache
const IG_DIRECT_URL_CACHE_TTL_MS = 5 * 60 * 1000; // Instagram URLs expire faster
const bestUrlCache = new BoundedMap<string, { url: string; ts: number }>(400);

/** Prefer Best row; else first format with a usable URL. */
function seedBestUrlFromFormats(cacheKey: string, formats: MediaFormat[]): void {
	const seed =
		formats.find((f) => f.id === 'best' && f.url) || formats.find((f) => !!f.url);
	if (seed?.url) {
		bestUrlCache.set(cacheKey, { url: seed.url, ts: Date.now() });
	}
}

/** Export for tests — clear cached direct URLs. */
export function clearBestUrlCache(): void {
	bestUrlCache.clear();
}

/** Export for tests — remove one entry. */
export function removeBestUrlCache(url: string): void {
	bestUrlCache.delete(normalizePageUrl(url));
}

const ytDlpErrorLogged = new Set<string>();

/** Canonical cache key — same video/post must map to one key across content, SW, and backend. */
export function normalizeFormatUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = '';
		const host = u.hostname.toLowerCase();
		if (host === 'youtu.be') {
			const id = u.pathname.split('/').filter(Boolean)[0];
			if (id) return `https://www.youtube.com/watch?v=${id}`;
		}
		if (host.includes('youtube.com')) {
			if (u.pathname.startsWith('/shorts/')) {
				const id = u.pathname.split('/').filter(Boolean)[1];
				if (id) return `https://www.youtube.com/shorts/${id}`;
			}
			if (u.pathname === '/watch') {
				const v = u.searchParams.get('v');
				if (v) return `https://www.youtube.com/watch?v=${v}`;
			}
		}
		if (/instagram\.com/i.test(u.hostname)) {
			u.search = '';
			// Match extension: /reels/ID and /reel/ID share one cache key.
			u.pathname = u.pathname.replace(/\/reels\//i, '/reel/').replace(/\/+$/, '');
		}
		return u.href;
	} catch {
		return url;
	}
}

function normalizePageUrl(url: string): string {
	return normalizeFormatUrl(url);
}

/** Reel and /p/ URLs share the same shortcode — try both if one fails. */
function instagramUrlVariants(url: string): string[] {
	if (!/instagram\.com/i.test(url)) return [url];
	const variants = new Set<string>([normalizePageUrl(url)]);
	const m = url.match(/instagram\.com\/(reel|p|tv)\/([^/?#]+)/i);
	if (m) {
		const code = m[2];
		variants.add(`https://www.instagram.com/p/${code}`);
		variants.add(`https://www.instagram.com/reel/${code}`);
	}
	const sm = url.match(/instagram\.com\/stories\/([^/?#]+)(?:\/(\d+))?/i);
	if (sm) {
		const user = sm[1];
		const id = sm[2];
		variants.add(`https://www.instagram.com/stories/${user}`);
		if (id) variants.add(`https://www.instagram.com/stories/${user}/${id}`);
	}
	return [...variants];
}

export function getRecentFormatError(url: string): string | undefined {
	const key = normalizePageUrl(url);
	const hit = failCache.get(key);
	if (!hit) return undefined;
	const source = hit.source ?? detectMediaSource(key);
	const ttl = failCacheTtlMs(source, key);
	if (Date.now() - hit.ts < ttl) return hit.reason;
	return undefined;
}

function isTrapDownloadUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const path = u.pathname.toLowerCase();
		if (/\/redirect|\/pkg\/|\/api\/|\/graphql|\/download\?/i.test(path)) return true;
		if (/redirect|download/i.test(u.searchParams.get('a') || '')) return true;
		return false;
	} catch {
		return false;
	}
}

export function isExtractorDomain(url: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return EXTRACTOR_DOMAINS.some((d) => hostname.includes(d));
	} catch {
		return false;
	}
}

export { detectMediaSource, isManifestFormatUrl, isInstagramMediaPageUrl } from './formatSources';

function formatBytes(n: number): string {
	if (!n) return '';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getCached(url: string): MediaFormat[] | null {
	const hit = formatCache.get(url);
	if (hit && Date.now() - hit.ts < FORMAT_CACHE_TTL_MS) return hit.formats;
	return null;
}

function setCached(url: string, formats: MediaFormat[]) {
	if (formats.length > 0) formatCache.set(url, { formats, ts: Date.now() });
}

/**
 * List downloadable formats for a URL. Video/social pages go through yt-dlp;
 * direct file links return a single "Direct" entry.
 */
export async function listFormats(url: string, opts?: { force?: boolean }): Promise<MediaFormat[]> {
	const key = normalizePageUrl(url);
	// Warm success cache always wins. force only bypasses the fail cache below so a
	// badge click does not re-run yt-dlp when prefetch already filled the menu.
	const cached = getCached(key);
	if (cached) return cached;

	if (!opts?.force) {
		const recentFail = failCache.get(key);
		if (recentFail) {
			const ttl = /instagram\.com/i.test(key) ? INSTAGRAM_FAIL_CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
			if (Date.now() - recentFail.ts < ttl) return [];
		}
	}

	if (inflight.has(key)) {
		return inflight.get(key)!;
	}

	const work = listFormatsUncached(key, url, opts).finally(() => inflight.delete(key));
	inflight.set(key, work);
	return work;
}

async function listFormatsUncached(
	cacheKey: string,
	url: string,
	opts?: { force?: boolean }
): Promise<MediaFormat[]> {
	const source = detectMediaSource(url);
	if (url.includes('mediafire.com')) {
		const info = await resolveMediafireInfo(url);
		if (!info) {
			failCache.set(cacheKey, {
				reason: 'MediaFire link expired or unavailable. Open the MediaFire file page in your browser and try again.',
				ts: Date.now()
			});
			return [];
		}
		const formats = [
			directFileFormat(info.url, info.fileName, 'mediafire', info.sizeBytes)
		];
		setCached(cacheKey, formats);
		return formats;
	}

	if (/github\.com|githubusercontent\.com/i.test(url)) {
		const gh = resolveGithubDownloadUrl(url);
		if ('error' in gh) {
			failCache.set(cacheKey, { reason: gh.error, ts: Date.now() });
			return [];
		}
		const fetchUrl = gh.url;
		const formats = [directFileFormat(fetchUrl, fileNameFromRemoteUrl(fetchUrl), 'direct')];
		setCached(cacheKey, formats);
		return formats;
	}

	if (isDirectFileUrl(url)) {
		const formats = [directFileFormat(url, fileNameFromRemoteUrl(url), 'direct')];
		setCached(cacheKey, formats);
		return formats;
	}

	if (!isExtractorDomain(url)) {
		if (isTrapDownloadUrl(url)) {
			failCache.set(cacheKey, {
				reason: 'Redirect/API link — use the Veloce intercept format picker on the page instead of this URL directly.',
				ts: Date.now()
			});
			return [];
		}
		try {
			const u = new URL(url);
			const formats = [directFileFormat(url, path.basename(u.pathname) || 'download', 'direct')];
			setCached(cacheKey, formats);
			return formats;
		} catch {
			return [];
		}
	}

	const { formats, lastErr } = await listFormatsBySource(url, source, opts);
	console.log(
		`[Extractor] listFormats source=${source} raw=${formats.length} force=${opts?.force === true}`
	);
	const pickerFormats = finalizeFormatsForPicker(formats, source);
	console.log(
		`[Extractor] listFormats picker=${pickerFormats.length}`
	);
	if (pickerFormats.length > 0) {
		setCached(cacheKey, pickerFormats);
		seedBestUrlFromFormats(cacheKey, pickerFormats);
	} else {
		const reason = failReasonForSource(source, lastErr);
		failCache.set(cacheKey, {
			reason,
			ts: Date.now(),
			source
		});
		console.warn(`[Extractor] listFormats FAIL source=${source}: ${reason.slice(0, 160)}`);
	}
	return pickerFormats;
}

type YtDlpAttempt = {
	cookieArgs: string[];
	extraArgs?: string[];
	timeoutMs: number;
	label: string;
	allowPlaylist?: boolean;
};

type FormatListResult = { formats: MediaFormat[]; lastErr: string };

async function listFormatsBySource(
	url: string,
	source: MediaSource,
	opts?: { force?: boolean }
): Promise<FormatListResult> {
	switch (source) {
		case 'instagram':
			return raceInstagramFormats(url, opts?.force === true);
		case 'youtube':
			return raceYoutubeFormats(url, opts?.force === true);
		default:
			return raceGenericYtDlpFormats(url, source, opts?.force === true);
	}
}

async function raceInstagramFormats(url: string, force: boolean): Promise<FormatListResult> {
	const urls = instagramUrlVariants(url);
	const timeoutMs = force ? 18_000 : 12_000;
	const primaryUrl = urls[0] ?? url;

	console.log(
		`[Extractor] Instagram list start force=${force} variants=${urls.length} url=${primaryUrl}`
	);

	// Returns the live run handle alongside the settling promise so a race can
	// kill() this attempt early — mirrors raceYoutubeFormats/raceGenericYtDlpFormats.
	const tryOne = (
		pageUrl: string,
		browser: string
	): { kill: () => void; promise: Promise<{ formats: MediaFormat[]; err: string }> } => {
		if (browser && cookieBrowserSkip.has(browser)) {
			console.log(`[Extractor] Instagram skip ${browser} (already marked bad)`);
			return { kill: () => {}, promise: Promise.resolve({ formats: [], err: '' }) };
		}
		const label = browser || 'no-cookies';
		const cookieArgs = browser ? ['--cookies-from-browser', browser] : [];
		console.log(`[Extractor] Instagram try ${label} → ${pageUrl}`);
		const run = runYtDlpJson(pageUrl, cookieArgs, timeoutMs, {
			allowPlaylist: true,
			label: `instagram/${label}`
		});
		const promise = run.promise.then((raw) => {
			const formats = tagFormats(raw, 'instagram');
			const err = run.getError();
			if (err && browser) markCookieBrowserBad(browser, err);
			console.log(
				`[Extractor] Instagram done ${label}: formats=${formats.length}${err ? ` err=${err.slice(0, 100)}` : ''}`
			);
			return { formats, err: err || '' };
		});
		return { kill: run.kill, promise };
	};

	// Primary first; rebuild fallbacks AFTER skip so Chrome is not spawned twice.
	const browsers = cookieBrowsersForAttempt(force);
	console.log(`[Extractor] Instagram cookie browsers: ${browsers.join(', ') || '(none)'}`);

	let lastErr = '';
	const primaryBrowser = browsers[0] ?? '';
	{
		const { formats, err } = await tryOne(primaryUrl, primaryBrowser).promise;
		if (formats.length) {
			console.log(`[Extractor] Instagram OK via ${primaryBrowser || 'no-cookies'} (${formats.length} raw)`);
			return { formats, lastErr: '' };
		}
		lastErr = err || lastErr;
	}

	const fallbackJobs: { pageUrl: string; browser: string }[] = [];
	const browsersNow = cookieBrowsersForAttempt(force);
	for (const browser of browsersNow) {
		if (browser === primaryBrowser) continue;
		fallbackJobs.push({ pageUrl: primaryUrl, browser });
	}
	for (const pageUrl of urls.slice(1)) {
		for (const browser of browsersNow.slice(0, 2)) {
			fallbackJobs.push({ pageUrl, browser });
		}
	}
	fallbackJobs.push({ pageUrl: primaryUrl, browser: '' });

	// yt-dlp spawns are semaphore-limited (YTDLP_MAX_CONCURRENT); keep the queued
	// fallback set modest so a stale queue doesn't hold work long after a win.
	const capped = fallbackJobs.slice(0, 4);
	console.log(
		`[Extractor] Instagram fallbacks (${capped.length}): ${capped
			.map((j) => `${j.browser || 'no-cookies'}@${j.pageUrl.includes('/reel/') ? 'reel' : 'p'}`)
			.join(', ')}`
	);

	if (!capped.length) return { formats: [], lastErr };

	const runners = capped.map((job) => {
		const { kill, promise } = tryOne(job.pageUrl, job.browser);
		return { job, kill, promise };
	});

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;
		let bestErr = lastErr;

		// Stop the other in-flight yt-dlp/cookie-decrypt spawns the instant one
		// fallback wins — previously they ran to completion (up to timeoutMs)
		// for a discarded result, each holding a semaphore slot + RSS for nothing.
		const finishAll = (formats: MediaFormat[], via: string) => {
			if (resolved) return;
			resolved = true;
			for (const r of runners) r.kill();
			console.log(
				`[Extractor] Instagram race end via=${via} formats=${formats.length} lastErr=${(bestErr || '').slice(0, 80)}`
			);
			resolve({ formats, lastErr: bestErr });
		};

		for (const { job, promise } of runners) {
			promise.then(({ formats, err }) => {
				if (err) bestErr = err || bestErr;
				if (!resolved && formats.length > 0) {
					finishAll(formats, job.browser || 'no-cookies');
					return;
				}
				finished++;
				if (finished === runners.length && !resolved) finishAll([], 'exhausted');
			});
		}
	});
}

function youtubeAttempts(force: boolean): YtDlpAttempt[] {
	const out: YtDlpAttempt[] = [];
	const timeout = force ? 28_000 : 18_000;
	for (const browser of cookieBrowsersForAttempt(force)) {
		out.push({
			cookieArgs: ['--cookies-from-browser', browser],
			timeoutMs: timeout,
			label: `youtube/${browser}`
		});
	}
	for (const client of ['android', 'web', 'ios'] as const) {
		out.push({
			cookieArgs: cookieBrowserSkip.has('chrome') ? [] : ['--cookies-from-browser', 'chrome'],
			extraArgs: ['--extractor-args', `youtube:player_client=${client}`],
			timeoutMs: force ? 24_000 : 14_000,
			label: `youtube/chrome/${client}`
		});
	}
	out.push({
		cookieArgs: [],
		timeoutMs: 10_000,
		label: 'youtube/no-cookies'
	});
	return out;
}

async function raceYoutubeFormats(url: string, force: boolean): Promise<FormatListResult> {
	const attempts = youtubeAttempts(force);
	let lastErr = '';

	// force used to walk attempts serially (slow badge clicks). Now force only lengthens
	// timeouts / attempt set; race strategy matches prefetch: primary then parallel fallbacks.
	const primary = attempts[0];
	if (primary) {
		const run = runYtDlpJson(url, primary.cookieArgs, primary.timeoutMs, {
			label: primary.label,
			extraArgs: primary.extraArgs
		});
		const primaryFormats = tagFormats(await run.promise, 'youtube');
		lastErr = run.getError() || lastErr;
		run.kill();
		if (primaryFormats.length) return { formats: primaryFormats, lastErr: '' };
	}

	const fallbacks = attempts.slice(1, 4);
	if (!fallbacks.length) return { formats: [], lastErr };

	const runners = fallbacks.map((attempt) =>
		runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, {
			label: attempt.label,
			extraArgs: attempt.extraArgs
		})
	);

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;
		let bestErr = lastErr;

		const finishAll = (formats: MediaFormat[]) => {
			if (!resolved) {
				resolved = true;
				for (const r of runners) r.kill();
				resolve({ formats: tagFormats(formats, 'youtube'), lastErr: bestErr });
			}
		};

		for (const r of runners) {
			r.promise.then((formats) => {
				if (!resolved && formats.length > 0) {
					finishAll(formats);
					return;
				}
				bestErr = r.getError() || bestErr;
				finished++;
				if (finished === runners.length && !resolved) finishAll([]);
			});
		}
	});
}

async function raceGenericYtDlpFormats(
	url: string,
	source: MediaSource,
	force: boolean
): Promise<FormatListResult> {
	const attempts: YtDlpAttempt[] = [
		{ cookieArgs: ['--cookies-from-browser', 'chrome'], timeoutMs: force ? 24_000 : 20_000, label: `${source}/chrome` },
		{ cookieArgs: ['--cookies-from-browser', 'chromium'], timeoutMs: force ? 24_000 : 20_000, label: `${source}/chromium` },
		{ cookieArgs: [], timeoutMs: 12_000, label: `${source}/no-cookies` }
	];

	// Always race in parallel (force only lengthens timeouts). Serial force walks used to
	// make TikTok/X badge clicks wait for chrome then chromium then no-cookies one-by-one.
	const runners = attempts.map((attempt) =>
		runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, { label: attempt.label })
	);

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;
		let bestErr = '';

		const finishAll = (formats: MediaFormat[]) => {
			if (!resolved) {
				resolved = true;
				for (const r of runners) r.kill();
				resolve({ formats: tagFormats(formats, source), lastErr: bestErr });
			}
		};

		for (const r of runners) {
			r.promise.then((formats) => {
				if (!resolved && formats.length > 0) {
					finishAll(formats);
					return;
				}
				bestErr = r.getError() || bestErr;
				finished++;
				if (finished === runners.length && !resolved) finishAll([]);
			});
		}
	});
}

function tagFormats(formats: MediaFormat[], source: MediaSource): MediaFormat[] {
	return formats.map((f) => ({
		...f,
		source: f.source ?? source,
		kind: f.kind ?? (isManifestFormatUrl(f.url) ? 'manifest' : 'progressive')
	}));
}

type YtDlpRunOpts = { allowPlaylist?: boolean; label?: string; extraArgs?: string[] };

function runYtDlpJson(
	url: string,
	cookieArgs: string[],
	timeoutMs: number,
	opts: YtDlpRunOpts = {}
): { promise: Promise<MediaFormat[]>; kill: () => void; getError: () => string } {
	let proc: ChildProcess | null = null;
	let lastErr = '';
	let killTimer: ReturnType<typeof setTimeout> | null = null;
	// `done` is assigned inside the executor; `kill` (returned synchronously) and
	// the semaphore-release path both need to reach it.
	let doneFn: (result: MediaFormat[]) => void = () => {};

	const kill = () => {
		if (!proc) {
			// Killed while still queued for a yt-dlp slot — abandon without spawning.
			doneFn([]);
			return;
		}
		try {
			proc.kill('SIGTERM');
		} catch { /* ignore */ }
		// Cookie-decrypt hangs ignore SIGTERM — escalate quickly.
		if (killTimer) clearTimeout(killTimer);
		killTimer = setTimeout(() => {
			try {
				proc?.kill('SIGKILL');
			} catch { /* ignore */ }
		}, 800);
	};

	const getError = () => lastErr;

	const promise = new Promise<MediaFormat[]>((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		const args = [
			...ytdlpSharedArgs(),
			...cookieArgs,
			...(opts.extraArgs ?? []),
			'--no-warnings',
			'--no-progress',
			'--socket-timeout', '12',
			'--retries', '1',
			'-J',
			'--',
			url
		];
		if (!opts.allowPlaylist) {
			args.splice(args.length - 2, 0, '--no-playlist');
		}

		let output = '';
		let settled = false;
		let releaseSlot: () => void = () => {};
		let timeout: ReturnType<typeof setTimeout> | null = null;
		const done = (result: MediaFormat[]) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
			releaseSlot();
			if (!result.length && lastErr && opts.label) {
				const logKey = `${opts.label}:${url}`;
				if (!ytDlpErrorLogged.has(logKey)) {
					if (ytDlpErrorLogged.size > 500) ytDlpErrorLogged.clear();
					ytDlpErrorLogged.add(logKey);
					console.error(`[yt-dlp formats/${opts.label}]: ${lastErr}`);
					setTimeout(() => ytDlpErrorLogged.delete(logKey), 120_000);
				}
			}
			resolve(result);
		};
		doneFn = done;

		void acquireYtdlpSlot().then((release) => {
			releaseSlot = release;
			if (settled) {
				// kill()/timeout fired while we were queued — give the slot back.
				release();
				return;
			}

			proc = spawn(ytdlpPath, args);

			timeout = setTimeout(() => {
				kill();
				done([]);
			}, timeoutMs);

			proc.stdout?.on('data', (data) => {
				output += data.toString();
				if (output.length > YTDLP_MAX_STDOUT_BYTES) {
					lastErr = lastErr || 'yt-dlp output exceeded the size limit';
					kill();
					done([]);
				}
			});
			proc.stderr?.on('data', (data) => {
				const text = data.toString();
				for (const rawLine of text.split('\n')) {
					const line = rawLine.trim();
					if (!line) continue;
					if (line.startsWith('ERROR:')) {
						lastErr = line.replace(/^ERROR:\s*/, '');
					} else if (/secretstorage/i.test(line) || /could not find .* cookies database/i.test(line)) {
						lastErr = line;
						// Fail this attempt immediately — waiting the full timeout feels "infinite".
						kill();
						done([]);
						return;
					}
				}
			});

			proc.on('close', () => {
				if (!output.trim()) {
					done([]);
					return;
				}
				try {
					const parsed = parseYtDlpFormats(output);
					done(parsed);
				} catch (e) {
					console.error('[Extractor] Failed to parse yt-dlp JSON', e);
					done([]);
				}
			});

			proc.on('error', () => done([]));
		});
	});

	return { promise, kill, getError };
}

/** Prefer caption / uploader over Instagram's generic "Video by …" / "Reel" titles. */
function getSmartTitle(info: Record<string, unknown>): string {
	const uploader = String(
		info.uploader || info.creator || info.channel || info.uploader_id || ''
	).trim();
	let t = String(info.title || '').trim();
	const byMatch = t.match(/^(?:Video|Photo|Reel) by\s+(.+)$/i);
	const generic =
		!t ||
		t === 'post' ||
		/^reel$/i.test(t) ||
		/^instagram$/i.test(t) ||
		!!byMatch;

	if (generic) {
		const desc = String(info.description || '').trim();
		if (desc) {
			t = desc.split('\n')[0].slice(0, 80).trim();
			if (uploader && !t.toLowerCase().includes(uploader.toLowerCase())) {
				t = `${uploader} - ${t}`;
			}
		} else if (byMatch?.[1]) {
			t = byMatch[1].trim();
		} else if (uploader) {
			t = uploader;
		} else {
			t = '';
		}
	}

	return (t || uploader || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function parseYtDlpFormats(output: string): MediaFormat[] {
	let info: Record<string, unknown> | null;
	try {
		info = JSON.parse(output);
	} catch {
		return [];
	}
	if (!info || typeof info !== 'object') return [];

	if (info._type === 'playlist' && Array.isArray(info.entries)) {
		const merged: MediaFormat[] = [];
		const baseTitle = getSmartTitle(info).replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
		const total = info.entries.length;
		for (let i = 0; i < info.entries.length; i++) {
			const entry = info.entries[i];
			if (!entry) continue;
			const suffix = total > 1 ? ` [${i + 1}/${total}]` : '';
			merged.push(...formatsFromInfo(entry, `${baseTitle}${suffix}`));
		}
		if (merged.length > 0) return dedupeFormats(merged).slice(0, 40);
	}

	return dedupeFormats(formatsFromInfo(info, getSmartTitle(info)));
}

/**
 * Instagram CDN: `efg` embeds vencode_tag with `dash_…` for silent video-only DASH.
 * Progressive muxed clips do not use that tag — catching it avoids labeling those as video+audio.
 */
export function isInstagramSilentDashUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (!/instagram\.|fbcdn\.net|cdninstagram/i.test(u.hostname)) return false;
		if (/\.m4a(\?|$)/i.test(u.pathname)) return false;
		const efg = u.searchParams.get('efg');
		if (!efg) return false;
		const pad = '='.repeat((4 - (efg.length % 4)) % 4);
		const raw = Buffer.from(efg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
		return /dash_/i.test(raw);
	} catch {
		return false;
	}
}

function avFromCodecs(
	vcodec: unknown,
	acodec: unknown,
	url: string
): AvStream | null {
	const hasVideo = typeof vcodec === 'string' && vcodec !== 'none';
	const hasAudio = typeof acodec === 'string' && acodec !== 'none';
	if (hasVideo || hasAudio) {
		if (hasVideo && hasAudio && isInstagramSilentDashUrl(url)) return 'video';
		return hasVideo && hasAudio ? 'both' : hasVideo ? 'video' : 'audio';
	}
	if (isInstagramSilentDashUrl(url)) return 'video';
	return null;
}

function formatsFromInfo(info: Record<string, unknown>, title: string): MediaFormat[] {
	const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'video';
	const raw = (info.formats as Record<string, unknown>[]) ?? [];
	const out: MediaFormat[] = [];
	const seenUrls = new Set<string>();

	// Keep all streams internally (av tagged). The picker drops video-only / audio-only
	// so the menu never offers silent files — but race still knows yt-dlp succeeded.
	const directUrl = info.url as string | undefined;
	const directExt = (info.ext as string) || 'mp4';
	if (directUrl) {
		const cleanDirect = sanitizeDownloadMediaUrl(directUrl);
		seenUrls.add(cleanDirect);
		const av = avFromCodecs(info.vcodec, info.acodec, cleanDirect) ?? 'both';
		const size = (info.filesize || info.filesize_approx) as number | undefined;
		const sizeStr = size ? ` · ${formatBytes(size)}` : '';
		const label =
			av === 'both'
				? `${safeTitle} — ${directExt}${sizeStr}`.trim()
				: `${safeTitle} — ${av === 'video' ? 'video only' : 'audio only'} ${directExt}${sizeStr}`.trim();
		out.push({
			id: '0',
			label,
			url: cleanDirect,
			ext: directExt.startsWith('.') ? directExt : `.${directExt}`,
			filesize: size,
			av,
			kind: 'progressive'
		});
	}

	for (const f of raw) {
		if (!f.url) continue;
		const formatUrl = sanitizeDownloadMediaUrl(f.url as string);
		if (seenUrls.has(formatUrl)) continue;
		const formatId = String(f.format_id ?? '');
		if (f.ext === 'mhtml' || f.format_note === 'storyboard' || formatId.startsWith('sb')) continue;
		const av = avFromCodecs(f.vcodec, f.acodec, formatUrl);
		if (!av) continue;

		const res = f.resolution && f.resolution !== 'audio only' ? String(f.resolution) : '';
		const size = (f.filesize || f.filesize_approx) as number | undefined;
		const sizeStr = size ? ` · ${formatBytes(size)}` : '';
		const ext = (f.ext as string) || 'mp4';
		// Muxed rows: no "video+audio" wording. Split rows keep tags so picker can drop them.
		const labelParts =
			av === 'both'
				? [res, ext, sizeStr]
				: [res, av === 'video' ? 'video only' : 'audio only', ext, sizeStr];
		const label = labelParts.filter(Boolean).join(' ');

		seenUrls.add(formatUrl);
		out.push({
			id: String(f.format_id),
			label: `${safeTitle} — ${label}`.trim(),
			url: formatUrl,
			ext: ext.startsWith('.') ? ext : `.${ext}`,
			filesize: size,
			av,
			kind: inferFormatKind(formatUrl, f.protocol as string | undefined)
		});
	}

	return out;
}

const MF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Short TTL cache so enqueue + engine-start don't double-scrape (~5s → ~0 on hit). */
const mediafireCdnCache = new BoundedMap<
	string,
	{ url: string; at: number; fileName?: string; sizeBytes?: number }
>(200);
const MEDIAFIRE_CDN_TTL_MS = 90_000;

function mediafireCacheKey(url: string): string {
	try {
		const u = new URL(url);
		u.search = '';
		u.hash = '';
		return u.toString().replace(/\/$/, '');
	} catch {
		return url.replace(/\/$/, '');
	}
}

function isMediafireCdnHost(hostname: string): boolean {
	return /^download\d+\.mediafire\.com$/i.test(hostname);
}

function isMediafireFilePage(url: string): boolean {
	return /www\.mediafire\.com\/file\//i.test(url);
}

/** True when the URL already points at a file, not an HTML landing page. */
export function isDirectFileUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (!/^https?:$/i.test(u.protocol)) return false;
		if (isMediafireCdnHost(u.hostname)) return true;
		if (u.hostname.toLowerCase().endsWith('github.com') && /\/blob\//i.test(u.pathname)) return false;
		return /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|iso|xml|txt|csv|json|md|yaml|yml|html|css|js|ts)(\?|#|$)/i.test(u.pathname);
	} catch {
		return false;
	}
}

/** CDN URLs embed `/qkey/filename` — rebuild the public file page from that. */
function mediafireFilePageFromCdn(url: string): string | null {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		if (parts.length < 2) return null;
		const fileName = decodeURIComponent(parts[parts.length - 1]);
		const qkey = parts[parts.length - 2];
		return `https://www.mediafire.com/file/${qkey}/${fileName}`;
	} catch {
		return null;
	}
}

/** HEAD without following redirects — CDN links expire and 302 to a repair page. */
async function probeMediafireCdn(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			method: 'HEAD',
			redirect: 'manual',
			headers: { 'User-Agent': MF_UA }
		});
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location') ?? '';
			if (loc.includes('download_repair')) return null;
		}
		if (res.status === 200) {
			const ct = res.headers.get('content-type') ?? '';
			if (ct.includes('video/') || ct.includes('audio/') || ct.includes('octet-stream')) {
				return url;
			}
		}
		if (res.status === 206) return url;
	} catch { /* fall through */ }
	return null;
}

async function parseMediafirePage(
	url: string
): Promise<{ cdn: string; fileName?: string; sizeBytes?: number } | null> {
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			headers: {
				'User-Agent': MF_UA
			}
		});
		const ct = res.headers.get('content-type') ?? '';
		if (ct.includes('video/') || ct.includes('audio/') || ct.includes('application/octet-stream')) {
			return { cdn: url, fileName: fileNameFromRemoteUrl(url) };
		}
		const html = await res.text();
		const match = html.match(/href="(https?:\/\/download\d+\.mediafire\.com[^"]+)"/i);
		const cdn = match?.[1];
		if (!cdn) return null;

		const og =
			html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] ||
			html.match(/content="([^"]+)"\s+property="og:title"/i)?.[1] ||
			html.match(/<title>([^<]+)<\/title>/i)?.[1];
		const fromCdn = fileNameFromRemoteUrl(cdn);
		let fileName = fromCdn;
		if (og) {
			const cleaned = sanitizeFileName(
				decodeRemoteFileName(og.replace(/\s*[|\-–].*$/, '').trim())
			);
			if (cleaned && cleaned !== 'mediafire_file') {
				const ext = path.extname(fromCdn) || path.extname(cleaned) || '.bin';
				fileName = path.extname(cleaned) ? cleaned : `${cleaned}${ext}`;
			}
		}
		const sizeMatch = html.match(/\((\d+(?:\.\d+)?)\s*(KB|MB|GB)\)/i);
		let sizeBytes: number | undefined;
		if (sizeMatch) {
			const n = parseFloat(sizeMatch[1]);
			const unit = sizeMatch[2].toUpperCase();
			const mul = unit === 'GB' ? 1_073_741_824 : unit === 'MB' ? 1_048_576 : 1024;
			sizeBytes = Math.round(n * mul);
		}
		return { cdn, fileName, sizeBytes };
	} catch (e) {
		console.error('[Extractor] Failed to parse Mediafire page', e);
		return null;
	}
}

type MediafireResolved = { url: string; fileName: string; sizeBytes?: number };

async function resolveMediafireInfo(url: string): Promise<MediafireResolved | null> {
	const key = mediafireCacheKey(url);
	const hit = mediafireCdnCache.get(key);
	if (hit && Date.now() - hit.at < MEDIAFIRE_CDN_TTL_MS) {
		return {
			url: hit.url,
			fileName: hit.fileName || fileNameFromRemoteUrl(hit.url),
			sizeBytes: hit.sizeBytes
		};
	}

	let parsed: { cdn: string; fileName?: string; sizeBytes?: number } | null = null;
	if (isMediafireFilePage(url)) {
		parsed = await parseMediafirePage(url);
	} else if (isMediafireCdnHost(new URL(url).hostname)) {
		const live = await probeMediafireCdn(url);
		if (live) {
			parsed = { cdn: live, fileName: fileNameFromRemoteUrl(live) };
		} else {
			const filePage = mediafireFilePageFromCdn(url);
			if (filePage) parsed = await parseMediafirePage(filePage);
		}
	} else if (url.includes('mediafire.com')) {
		parsed = await parseMediafirePage(url);
	}

	if (!parsed?.cdn) return null;
	const fileName = sanitizeFileName(parsed.fileName || fileNameFromRemoteUrl(parsed.cdn));
	mediafireCdnCache.set(key, {
		url: parsed.cdn,
		at: Date.now(),
		fileName,
		sizeBytes: parsed.sizeBytes
	});
	return { url: parsed.cdn, fileName, sizeBytes: parsed.sizeBytes };
}

async function resolveMediafireDownload(url: string): Promise<string | null> {
	const info = await resolveMediafireInfo(url);
	return info?.url ?? null;
}

function dedupeFormats(out: MediaFormat[]): MediaFormat[] {
	const map = new Map<string, MediaFormat>();
	for (const f of out) {
		const key = `${f.label}|${f.ext}`;
		map.set(key, f);
	}
	return Array.from(map.values());
}

function parseFormatHeight(label: string): number {
	const m = label.match(/(\d{3,4})x(\d{3,4})/);
	if (m) return parseInt(m[2], 10);
	const p = label.match(/\b(\d{3,4})p\b/i);
	if (p) return parseInt(p[1], 10);
	return 0;
}

/** True for progressive / muxed rows the range engine can download with sound. */
function isCombinedAvFormat(f: MediaFormat): boolean {
	if (isInstagramSilentDashUrl(f.url)) return false;
	if (f.av === 'both') return true;
	if (f.av === 'video' || f.av === 'audio') return false;
	return !/\bvideo only\b|\baudio only\b/i.test(f.label);
}

function titleStemFromFormats(formats: MediaFormat[]): string {
	for (const f of formats) {
		const stem = f.label.split(' — ')[0]?.trim();
		if (stem) return stem;
	}
	return 'video';
}

function hasSeparateAvPair(formats: MediaFormat[]): boolean {
	const hasVideo = formats.some(
		(f) => f.av === 'video' || /\bvideo only\b/i.test(f.label) || isInstagramSilentDashUrl(f.url)
	);
	const hasAudio = formats.some((f) => f.av === 'audio' || /\baudio only\b/i.test(f.label));
	return hasVideo && hasAudio;
}

/** YouTube only: hide silent video-only / audio-only; offer a "Best" row.
 * Instagram stays on the generic picker (pre-b3eb727) — applying this filter
 * emptied the menu when Instagram only returned DASH split streams.
 * When only DASH split A/V exists on YouTube, offer adaptive Best for yt-dlp+ffmpeg merge.
 */
function combinedAvPickerFormats(formats: MediaFormat[], source: MediaSource): MediaFormat[] {
	const combined = dedupeFormats(formats.filter(isCombinedAvFormat));
	combined.sort((a, b) => {
		const hb = parseFormatHeight(b.label);
		const ha = parseFormatHeight(a.label);
		if (hb !== ha) return hb - ha;
		return (b.filesize ?? 0) - (a.filesize ?? 0);
	});
	if (combined.length > 0) {
		const titleStem = combined[0]?.label.split(' — ')[0] || 'video';
		const top = combined[0];
		const best: MediaFormat = {
			id: 'best',
			label: `${titleStem} — Best`,
			url: top?.url || '',
			ext: top?.ext || '.mp4',
			filesize: top?.filesize,
			source,
			kind: 'progressive',
			av: 'both'
		};
		return [best, ...combined].slice(0, 24);
	}
	if (hasSeparateAvPair(formats)) {
		const titleStem = titleStemFromFormats(formats);
		return [
			{
				id: 'best',
				label: `${titleStem} — Best`,
				url: '',
				ext: '.mp4',
				source,
				kind: 'adaptive',
				av: 'both'
			}
		];
	}
	return [];
}

export function finalizeFormatsForPicker(formats: MediaFormat[], source: MediaSource): MediaFormat[] {
	if (source === 'youtube') {
		return combinedAvPickerFormats(formats, source);
	}

	if (source === 'instagram') {
		return instagramPickerFormats(formats);
	}

	const sorted = dedupeFormats([...formats]);
	sorted.sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
	return sorted.slice(0, 40);
}

/** Instagram menu: merged Best (+ yt-dlp/ffmpeg) and audio-only — hide silent video rows. */
function instagramPickerFormats(formats: MediaFormat[]): MediaFormat[] {
	const audioOnly = dedupeFormats(
		formats.filter((f) => f.av === 'audio' || /\baudio only\b/i.test(f.label))
	);
	audioOnly.sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));

	const hasVideo = formats.some(
		(f) =>
			f.av === 'video' ||
			f.av === 'both' ||
			/\bvideo only\b/i.test(f.label) ||
			isInstagramSilentDashUrl(f.url) ||
			(!!f.url && !/\baudio only\b/i.test(f.label) && f.av !== 'audio')
	);

	const out: MediaFormat[] = [];
	if (hasVideo || audioOnly.length > 0) {
		const titleStem = titleStemFromFormats(formats);
		out.push({
			id: 'best',
			label: `${titleStem} — Best`,
			url: '',
			ext: '.mp4',
			source: 'instagram',
			kind: 'adaptive',
			av: 'both'
		});
	}
	for (const a of audioOnly.slice(0, 8)) {
		out.push({ ...a, source: 'instagram', kind: a.kind || 'progressive' });
	}
	return out.slice(0, 24);
}

export interface PlaylistEntry {
	url: string;
	title?: string;
	/** 1-based position in the playlist. */
	index?: number;
}

export interface ResolvedPlaylist {
	title: string;
	id?: string;
	entries: PlaylistEntry[];
}

const YTDLP_BEST_FORMAT = 'best[vcodec!=none][acodec!=none]/b';
/** Prefer mergeable A/V; never fall back to bare `b` (Instagram DASH video-only). */
const YTDLP_MERGE_FORMAT = 'bv*+ba/best[vcodec!=none][acodec!=none]';

function extFromMediaUrl(mediaUrl: string, fallback: string): string {
	try {
		const mime = new URL(mediaUrl).searchParams.get('mime');
		if (mime?.includes('audio/mp4') || mime?.includes('mp4a')) return '.m4a';
		if (mime?.includes('audio/webm') || mime?.includes('opus')) return '.webm';
		if (mime?.includes('video/mp4')) return '.mp4';
		if (mime?.includes('video/webm')) return '.webm';
		const base = path.basename(new URL(mediaUrl).pathname);
		const ext = path.extname(base);
		if (ext && ext.length <= 5) return ext;
	} catch { /* ignore */ }
	return fallback;
}

/** Cookie arg lists for downloads — Firefox first (Chrome secretstorage often broken on Linux). */
function cookieArgStrategies(force = true): string[][] {
	const browsers = cookieBrowsersForAttempt(force);
	const out: string[][] = browsers.map((b) => ['--cookies-from-browser', b]);
	out.push([]);
	return out;
}

/** Extract media URL using a specific yt-dlp format selector. */
export async function extractMediaWithFormat(url: string, format: string): Promise<{ url: string; ext: string } | null> {
	const pageUrl = normalizeYoutubeWatchUrl(url);
	for (const cookieArgs of cookieArgStrategies()) {
		const browser = cookieArgs[1] || '';
		if (browser && cookieBrowserSkip.has(browser)) continue;
		const direct = await runYtDlp(pageUrl, cookieArgs, format);
		if (direct) {
			// Reject silent Instagram DASH (single -g line can still be video-only).
			if (isInstagramSilentDashUrl(direct)) continue;
			const fallback = format.startsWith('ba') || format.includes('bestaudio') ? '.m4a' : '.mp4';
			return { url: sanitizeDownloadMediaUrl(direct), ext: extFromMediaUrl(direct, fallback) };
		}
	}
	return null;
}

/** Resolve ffmpeg binary: `bin/ffmpeg`, PATH, then pnpm `@ffmpeg-installer/ffmpeg`. */
export function findFfmpegPath(): string | null {
	const candidates: string[] = [];

	const bundled = path.join(backendRoot(), 'bin', 'ffmpeg');
	candidates.push(bundled);

	try {
		const installer = requireFromHere('@ffmpeg-installer/ffmpeg') as { path?: string };
		if (installer?.path) candidates.push(installer.path);
	} catch {
		/* package not installed / Vite can't resolve — bin/ffmpeg still works */
	}

	candidates.push('ffmpeg'); // PATH last

	for (const cand of candidates) {
		try {
			if (cand !== 'ffmpeg' && !fs.existsSync(cand)) continue;
			if (cand !== 'ffmpeg') {
				try {
					fs.accessSync(cand, fs.constants.X_OK);
				} catch {
					try {
						fs.chmodSync(cand, 0o755);
					} catch {
						continue;
					}
				}
			}
			const check = spawnSync(cand, ['-version'], { stdio: 'ignore' });
			if (check.status === 0) return cand;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** True when ffmpeg is available (PATH or pnpm installer package). */
export function ffmpegAvailable(): boolean {
	return !!findFfmpegPath();
}

export type MergedDownloadResult = { ok: true } | { ok: false; error: string };

/**
 * Download + merge split A/V with yt-dlp (Instagram DASH, YouTube adaptive).
 * Writes to `savePath` via ffmpeg remux. Caller owns cancel via returned `proc`.
 */
export function startMergedYtDlpDownload(
	pageUrl: string,
	savePath: string,
	opts?: { timeoutMs?: number }
): { proc: ChildProcess; promise: Promise<MergedDownloadResult> } {
	const timeoutMs = opts?.timeoutMs ?? 180_000;
	const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
	const strategies = cookieArgStrategies(true);

	let current: ChildProcess | null = null;
	let killed = false;
	const kill = () => {
		killed = true;
		if (current && !current.killed) {
			try {
				current.kill('SIGTERM');
			} catch {
				/* ignore */
			}
		}
	};

	const promise = (async (): Promise<MergedDownloadResult> => {
		const ffmpegPath = findFfmpegPath();
		if (!ffmpegPath) {
			return {
				ok: false,
				error:
					'ffmpeg not found. Expected backend/bin/ffmpeg (copied from @ffmpeg-installer/ffmpeg). Re-run: cd backend && pnpm add @ffmpeg-installer/ffmpeg && cp "$(node -e "console.log(require(\'@ffmpeg-installer/ffmpeg\').path)")" bin/ffmpeg && chmod +x bin/ffmpeg'
			};
		}
		fs.mkdirSync(path.dirname(savePath), { recursive: true });
		let lastErr = '';
		for (const cookieArgs of strategies) {
			if (killed) return { ok: false, error: 'cancelled' };
			const browser = cookieArgs[1] || '';
			if (browser && cookieBrowserSkip.has(browser)) continue;

			const args = [
				...ytdlpSharedArgs(),
				...cookieArgs,
				'--ffmpeg-location',
				ffmpegPath,
				'-f',
				YTDLP_MERGE_FORMAT,
				'--merge-output-format',
				'mp4',
				// Instagram DASH often has ~ms length skew (audio shorter) and sometimes
				// non-zero start PTS. Keep timestamps + end on the shorter stream.
				'--postprocessor-args',
				'Merger:-copyts -shortest',
				'--fixup',
				'force',
				'--no-playlist',
				'--no-warnings',
				'--no-progress',
				'--socket-timeout',
				'20',
				'--retries',
				'2',
				'-o',
				savePath,
				'--',
				pageUrl
			];

			const mergeSlot = await acquireYtdlpSlot();
			const result = await new Promise<MergedDownloadResult>((resolve) => {
				const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
				current = proc;
				let stderr = '';
				proc.stderr?.on('data', (chunk) => {
					stderr += chunk.toString();
				});
				const timer = setTimeout(() => {
					try {
						proc.kill('SIGKILL');
					} catch {
						/* ignore */
					}
					resolve({ ok: false, error: `yt-dlp merge timed out after ${Math.round(timeoutMs / 1000)}s` });
				}, timeoutMs);
				proc.on('error', (err) => {
					clearTimeout(timer);
					resolve({ ok: false, error: err.message });
				});
				proc.on('close', (code) => {
					clearTimeout(timer);
					if (killed) {
						resolve({ ok: false, error: 'cancelled' });
						return;
					}
					if (code === 0 && fs.existsSync(savePath) && fs.statSync(savePath).size > 0) {
						resolve({ ok: true });
						return;
					}
					const errText = stderr.trim().split('\n').pop() || `yt-dlp exited ${code}`;
					if (browser) markCookieBrowserBad(browser, errText);
					resolve({ ok: false, error: errText.slice(0, 240) });
				});
			}).finally(() => mergeSlot());

			if (result.ok) return result;
			lastErr = result.error;
			if (result.error === 'cancelled') return result;
		}
		return {
			ok: false,
			error:
				lastErr ||
				'Could not merge video+audio with yt-dlp. Stay logged in (Firefox recommended) and retry.'
		};
	})();

	// Proxy ChildProcess so cancel/pause can kill whatever attempt is running.
	const proxy = {
		kill: (signal?: NodeJS.Signals) => {
			kill();
			if (signal && current) {
				try {
					current.kill(signal);
				} catch {
					/* ignore */
				}
			}
		},
		get killed() {
			return killed || !!current?.killed;
		}
	} as ChildProcess;

	return { proc: proxy, promise };
}

/** One-shot merge download (tests / callers that do not need cancel). */
export async function downloadMergedWithYtDlp(
	pageUrl: string,
	savePath: string,
	opts?: { timeoutMs?: number }
): Promise<MergedDownloadResult> {
	return startMergedYtDlpDownload(pageUrl, savePath, opts).promise;
}

function normalizeYoutubeWatchUrl(entryUrl: string): string {
	try {
		const u = new URL(entryUrl);
		const v = u.searchParams.get('v');
		if (v) return `https://www.youtube.com/watch?v=${v}`;
	} catch { /* ignore */ }
	return entryUrl;
}

/**
 * Return playlist title + entries (YouTube playlist/mix, Instagram carousel, etc.).
 */
export async function resolvePlaylist(url: string): Promise<ResolvedPlaylist | null> {
	if (!isExtractorDomain(url)) return null;
	for (const cookieArgs of [[], ['--cookies-from-browser', 'chrome'], ['--cookies-from-browser', 'chromium']]) {
		const info = await runYtDlpPlaylistJson(url, cookieArgs);
		if (info?.entries.length) return info;
	}
	return null;
}

/**
 * Return the entries of a playlist using yt-dlp's flat listing.
 */
export async function listPlaylistEntries(url: string): Promise<PlaylistEntry[]> {
	const pl = await resolvePlaylist(url);
	return pl?.entries ?? [];
}

function runYtDlpPlaylistJson(url: string, cookieArgs: string[]): Promise<ResolvedPlaylist | null> {
	return new Promise((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		let settled = false;
		let releaseSlot: () => void = () => {};
		let timeout: ReturnType<typeof setTimeout> | null = null;
		const done = (result: ResolvedPlaylist | null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			releaseSlot();
			resolve(result);
		};

		void acquireYtdlpSlot().then((release) => {
		releaseSlot = release;
		if (settled) {
			release();
			return;
		}
		const proc = spawn(ytdlpPath, [
			...ytdlpSharedArgs(),
			...cookieArgs,
			'--flat-playlist',
			'--no-warnings',
			'--no-progress',
			'--socket-timeout', '12',
			'--retries', '1',
			'-J',
			'--',
			url
		]);

		let output = '';
		timeout = setTimeout(() => {
			try { proc.kill('SIGTERM'); } catch { /* ignore */ }
			done(null);
		}, 90_000);

		proc.stdout?.on('data', (d) => {
			output += d.toString();
			if (output.length > YTDLP_MAX_STDOUT_BYTES) {
				try { proc.kill('SIGTERM'); } catch { /* ignore */ }
				done(null);
			}
		});
		proc.on('error', () => done(null));
		proc.on('close', () => {
			if (!output.trim()) return done(null);
			try {
				const info = JSON.parse(output);
				if (info._type !== 'playlist' || !Array.isArray(info.entries)) return done(null);
				const entries: PlaylistEntry[] = [];
				for (let i = 0; i < info.entries.length; i++) {
					const e = info.entries[i];
					if (!e) continue;
					const entryUrl = (e.url as string) || (e.webpage_url as string) ||
						(e.id ? `https://www.youtube.com/watch?v=${e.id}` : '');
					if (!entryUrl || !/^https?:/i.test(entryUrl)) continue;
					const idx = typeof e.playlist_index === 'number' ? e.playlist_index : i + 1;
					entries.push({
						url: normalizeYoutubeWatchUrl(entryUrl),
						title: (e.title as string) || undefined,
						index: idx
					});
				}
				if (!entries.length) return done(null);
				done({
					title: (info.title as string) || 'playlist',
					id: info.id as string | undefined,
					entries
				});
			} catch {
				done(null);
			}
		});
		});
	});
}

/**
 * Extracts the direct media URL from a social media link (Instagram, YouTube, etc) using yt-dlp.
 * Results are cached to avoid duplicate yt-dlp invocations when listFormats() already
 * extracted the formats and then runDownloadJob() needs the best direct URL.
 *
 * @param url The raw social media URL
 * @returns The absolute direct media URL, or null if it fails
 */
export async function extractMediaUrl(url: string): Promise<string | null> {
	// MediaFire — never cache, tokens expire mid-download.
	if (url.includes('mediafire.com')) {
		return resolveMediafireDownload(url);
	}

	// Direct file URLs — return as-is, no extraction needed.
	if (isDirectFileUrl(url)) {
		return url;
	}

	// Check cache from a previous extractMediaUrl() call — avoids re-running yt-dlp
	// on pause/resume cycles and consecutive playlist tracks from the same host.
	const normalized = normalizePageUrl(url);
	const cached = bestUrlCache.get(normalized);
	if (cached) {
		const ttl = /instagram\.com/i.test(normalized) ? IG_DIRECT_URL_CACHE_TTL_MS : BEST_URL_CACHE_TTL_MS;
		if (Date.now() - cached.ts < ttl) {
			return cached.url;
		}
		// Expired — fall through to re-extract.
	}

    const cookieStrategies: string[][] = [
        ['--cookies-from-browser', 'chrome'],
        ['--cookies-from-browser', 'chromium'],
        ['--cookies-from-browser', 'firefox'],
        [],
    ];

    for (const cookieArgs of cookieStrategies) {
        const label = cookieArgs.length ? cookieArgs[1] : 'no-cookies';
        const directUrl = await runYtDlp(url, cookieArgs, YTDLP_BEST_FORMAT);
        if (directUrl) {
            const clean = sanitizeDownloadMediaUrl(directUrl);
            bestUrlCache.set(normalized, { url: clean, ts: Date.now() });
            return clean;
        }
        console.error(`[Extractor] yt-dlp attempt failed (${label}) for ${url}`);
    }

    console.error(`[Extractor] All yt-dlp strategies failed for ${url}`);
    return null;
}

/**
 * Run yt-dlp once with a given cookie strategy and return the first direct
 * media URL, or null on failure/timeout.
 */
function runYtDlp(url: string, cookieArgs: string[], format: string): Promise<string | null> {
    return new Promise((resolve) => {
        const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
        let settled = false;
        let releaseSlot: () => void = () => {};
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const done = (result: string | null) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            releaseSlot();
            resolve(result);
        };

        void acquireYtdlpSlot().then((release) => {
            releaseSlot = release;
            if (settled) {
                release();
                return;
            }
            const ytdlp = spawn(ytdlpPath, [
                ...ytdlpSharedArgs(),
                ...cookieArgs,
                '-f', format,
                '--no-playlist',
                '--no-warnings',
                '--no-progress',
                '--socket-timeout', '12',
                '--retries', '1',
                '-g',
                '--',
                url
            ]);

            let output = '';
            timeout = setTimeout(() => {
                ytdlp.kill();
                console.error(`[yt-dlp] Timed out after 30s for: ${url}`);
                done(null);
            }, 30_000);

            ytdlp.stdout.on('data', (data) => {
                output += data.toString();
                if (output.length > YTDLP_MAX_STDOUT_BYTES) {
                    ytdlp.kill();
                    done(null);
                }
            });

            ytdlp.stderr.on('data', (data) => {
                console.error(`[yt-dlp log]: ${data.toString().trim()}`);
            });

            ytdlp.on('close', (code) => {
                if (code === 0 && output.trim()) {
                    done(output.trim().split('\n')[0]);
                } else {
                    done(null);
                }
            });

            ytdlp.on('error', (err) => {
                console.error('yt-dlp error (is it installed?):', err);
                done(null);
            });
        });
    });
}
