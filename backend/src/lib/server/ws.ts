import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { db, dbInit } from './db';
import { downloads, devices, playlistJobs } from './db/schema';
import { getMacAddress } from './identity';
import { eq, sql, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { statfs, unlink, writeFile, mkdir } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
function logWithTime(orig: any, ...args: any[]) {
	orig(`[${new Date().toISOString()}]`, ...args);
}
console.log = (...args) => logWithTime(origLog, ...args);
console.error = (...args) => logWithTime(origError, ...args);
console.warn = (...args) => logWithTime(origWarn, ...args);

import { extractMediaUrl, extractMediaWithFormat, listFormats, getRecentFormatError, isDirectFileUrl, isManifestFormatUrl, isInstagramMediaPageUrl, startMergedYtDlpDownload, isInstagramSilentDashUrl, removeBestUrlCache } from './extractor';
import { detectMediaSource } from './formatSources';
import {
	defaultPlaylistFormatSettings,
	parsePlaylistFormatSettings,
	type PlaylistFormatSettings
} from './playlistSettings';
import {
	queuePlaylistDownload,
	schedulePlaylistJob,
	pausePlaylistJob,
	cancelPlaylistJob,
	resumePlaylistJob,
	listPlaylistJobsForDevice,
	getPlaylistJob,
	isActivePlaylistJob,
	type PlaylistRuntime
} from './playlistRunner';
import { config } from './config';
import { buildEngineCliArgs, coreEngineBinaryPath } from './engineCli';
import { resolveGithubDownloadUrl } from './github';
import { isSafeDownloadUrl, sanitizeFileName, safeJoin, categoryForExt, completedFileStillExists, sanitizeDownloadMediaUrl } from './util';
import { isOrphanPlaylistDownloadRow, runDatabaseCleanup } from './dbCleanup';
import {
	reuseOrUniqueSavePath,
	removeResumeSidecars,
	sweepLegacySidecars,
	hasResumeState,
	migrateLegacySidecars
} from './resumePaths';

const MIN_FREE_BYTES = config.minFreeDiskMb * 1024 * 1024; // early sanity buffer
const VIDEO_CATEGORY = 'videos';

function playlistRuntimeFromSettings(): PlaylistRuntime {
	return {
		baseDirectory: runtime.baseDirectory,
		defaultThreads: runtime.defaultThreads,
		maxRateBytes: runtime.maxRateBytes,
		engineQuiet: runtime.engineQuiet,
		playlistFormats: runtime.playlistFormats
	};
}

function playlistJobToSnapshot(row: typeof import('./db/schema').playlistJobs.$inferSelect) {
	return {
		downloadId: row.id,
		playlistId: row.id,
		fileName: `${row.title} (${row.currentIndex}/${row.totalTracks} tracks)`,
		status: row.status === 'cancelled' ? 'error' : row.status,
		downloaded: row.downloadedBytes ?? 0,
		total: row.totalBytes ?? 0,
		isPlaylist: true,
		playlistCurrent: row.currentIndex,
		playlistTotal: row.totalTracks,
		saveDir: row.saveDir
	};
}
/** In-browser blob/data saves (AI images, canvas exports) — not fetched over HTTP. */
const MAX_BLOB_BYTES = 80 * 1024 * 1024;

function mimeToExt(mime: string): string {
	const m = (mime || '').toLowerCase().split(';')[0].trim();
	const map: Record<string, string> = {
		'image/png': '.png',
		'image/jpeg': '.jpg',
		'image/jpg': '.jpg',
		'image/webp': '.webp',
		'image/gif': '.gif',
		'image/svg+xml': '.svg',
		'image/bmp': '.bmp',
		'application/pdf': '.pdf',
		'video/mp4': '.mp4',
		'audio/mpeg': '.mp3',
		'audio/wav': '.wav'
	};
	return map[m] || '.bin';
}

function refererForDownload(pageUrl: string, mediaUrl: string, explicitReferer?: string): string | undefined {
	if (explicitReferer) {
		try {
			const u = new URL(explicitReferer);
			if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
		} catch { /* ignore */ }
	}
	try {
		if (!pageUrl || pageUrl === mediaUrl) return undefined;
		const page = new URL(pageUrl);
		if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined;
		return page.href;
	} catch {
		return undefined;
	}
}

function isSignedCdnUrl(url: string): boolean {
	try {
		const u = new URL(url);
		// YouTube googlevideo uses `expire` (no trailing s); many CDNs use expires/sign/token.
		return (
			u.searchParams.has('sign') ||
			u.searchParams.has('token') ||
			u.searchParams.has('expires') ||
			u.searchParams.has('expire')
		);
	} catch {
		return false;
	}
}

type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';

interface JobSpec {
	id: string;
	pageUrl: string; // original page URL — used for (re)extraction and dedup
	fileName: string;
	savePath: string;
	category: string;
	threads: number;
	/** Only a brand-new download may be renamed from extraction; resumes must keep the path stable. */
	allowRename: boolean;
	/** When set, download this URL directly (skip yt-dlp extraction). */
	directUrl?: string;
	/** Browser referer for signed CDN URLs. */
	referer?: string;
	/** Internal: set once we have already re-extracted after a stale-CDN failure. */
	cdnRetried?: boolean;
}

/** Engine failure text that means "the direct URL we were given is dead" (expired token / ranges pulled). */
function looksLikeStaleCdnFailure(log: string): boolean {
	return /ignored Range|CDN token expired|ranges disabled|expired or ranges|\b403\b|forbidden/i.test(
		log || ''
	);
}

// ── Connected clients (broadcast target) ─────────────────────────────────────
const clients = new Set<WebSocket>();

function broadcast(obj: unknown) {
	const msg = JSON.stringify(obj);
	for (const c of clients) {
		if (c.readyState === 1) c.send(msg);
	}
}

// ── Running engine processes, keyed by downloadId, with caller intent ─────────
type Intent = 'normal' | 'paused' | 'cancelled';
const running = new Map<string, { proc: ChildProcess; intent: Intent }>();

// ── Security helpers ─────────────────────────────────────────────────────────

/**
 * Only the browser extension (chrome-/moz-extension origins) or local dev
 * pages may connect. This blocks ordinary websites from driving the local
 * downloader via `new WebSocket('ws://localhost:14921/ws')`. Browsers set the
 * Origin header and JS cannot forge it, so this check is reliable.
 */
function isAllowedOrigin(origin?: string): boolean {
	if (!origin) return true; // non-browser/native clients (no Origin header)
	if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
		// If an allowlist is configured, the extension ID must be in it.
		if (config.allowedExtensionIds.length === 0) return true;
		const id = origin.replace(/^chrome-extension:\/\//, '').replace(/^moz-extension:\/\//, '').replace(/\/.*$/, '');
		return config.allowedExtensionIds.includes(id);
	}
	try {
		const u = new URL(origin);
		return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

// ── Filesystem / disk helpers ────────────────────────────────────────────────

/**
 * Avoid silently overwriting an unrelated existing file: reuse incomplete
 * downloads with resume state, else append " (1)", " (2)", … like classic IDMs.
 */
async function uniqueSavePath(savePath: string): Promise<string> {
	const reused = reuseOrUniqueSavePath(savePath);
	if (hasResumeState(reused)) return reused;

	const dir = path.dirname(savePath);
	const ext = path.extname(savePath);
	const stem = path.basename(savePath, ext);
	let candidate = reused;
	for (let i = 0; ; i++) {
		if (i > 0) candidate = path.join(dir, `${stem} (${i})${ext}`);
		migrateLegacySidecars(candidate);
		const dbTaken =
			(await db.select().from(downloads).where(eq(downloads.savePath, candidate))).length > 0;
		if (hasResumeState(candidate)) return candidate;
		if (!existsSync(candidate) && !dbTaken) return candidate;
		if (i >= 99) return candidate;
	}
}

async function cleanupFiles(savePath: string) {
	await unlink(savePath).catch(() => {});
	removeResumeSidecars(savePath);
}

/** Free space for a target dir, walking up to the first directory that exists. */
async function freeSpaceFor(targetDir: string): Promise<number | null> {
	let dir = path.resolve(targetDir);
	for (;;) {
		try {
			const s = await statfs(dir);
			return Number(s.bavail) * Number(s.bsize);
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}
}

function pickDirectory(): string | null {
	const candidates = [
		'zenity --file-selection --directory 2>/dev/null',
		'kdialog --getexistingdirectory "$HOME" 2>/dev/null'
	];
	for (const cmd of candidates) {
		try {
			const out = execSync(cmd).toString().trim();
			if (out) return out;
			return null; // empty + exit 0 => user cancelled
		} catch (e: any) {
			if (e?.status === 1) return null; // user cancelled
			// else: picker missing — try the next one
		}
	}
	console.error('❌ No graphical folder picker available (tried zenity, kdialog).');
	return null;
}

// ── Runtime settings (overridable at run time via SET_SETTINGS) ───────────────
// Initialized from `.env` config; persisted per-device in `devices.settings` and
// applied live so the popup / dashboard can tune behavior without a restart.
interface RuntimeSettings {
	maxConcurrentDownloads: number;
	defaultThreads: number;
	maxRateBytes: number;
	baseDirectory: string;
	engineQuiet: boolean;
	playlistFormats: PlaylistFormatSettings;
}

const runtime: RuntimeSettings = {
	maxConcurrentDownloads: config.maxConcurrentDownloads,
	defaultThreads: config.defaultThreads,
	maxRateBytes: config.maxRateBytes,
	baseDirectory: config.baseDir || path.join(os.homedir(), 'Downloads', 'Veloce'),
	engineQuiet: config.engineQuiet,
	playlistFormats: defaultPlaylistFormatSettings()
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Merge an untrusted partial settings object into the live runtime settings. */
function applySettings(patch: Record<string, unknown>) {
	if (patch.maxConcurrentDownloads !== undefined)
		runtime.maxConcurrentDownloads = clampInt(patch.maxConcurrentDownloads, 1, 64, runtime.maxConcurrentDownloads);
	if (patch.defaultThreads !== undefined)
		runtime.defaultThreads = clampInt(patch.defaultThreads, 1, 64, runtime.defaultThreads);
	if (patch.maxRateBytes !== undefined)
		runtime.maxRateBytes = clampInt(patch.maxRateBytes, 0, Number.MAX_SAFE_INTEGER, runtime.maxRateBytes);
	if (typeof patch.baseDirectory === 'string' && patch.baseDirectory.trim())
		runtime.baseDirectory = patch.baseDirectory.trim();
	if (typeof patch.engineQuiet === 'boolean') runtime.engineQuiet = patch.engineQuiet;
	if (patch.playlistFormats && typeof patch.playlistFormats === 'object') {
		runtime.playlistFormats = parsePlaylistFormatSettings(patch.playlistFormats);
	}
}

let settingsLoaded = false;

/** Load persisted device settings into the live runtime (once, on first client). */
async function loadSettings(macAddress: string) {
	if (settingsLoaded) return;
	settingsLoaded = true;
	try {
		const rows = await db.select().from(devices).where(eq(devices.id, macAddress));
		const s = rows[0]?.settings as Record<string, unknown> | null;
		if (s) applySettings(s);
	} catch (e) {
		console.error('Failed to load device settings:', e);
	}
}

/** Persist the live runtime settings to this device's row. */
async function persistSettings(macAddress: string) {
	try {
		await db.update(devices).set({ settings: { ...runtime } }).where(eq(devices.id, macAddress));
	} catch (e) {
		console.error('Failed to persist device settings:', e);
	}
}

/** Open a path (file or folder) with the desktop's default handler, detached. */
function xdgOpen(target: string): boolean {
	try {
		const child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
		child.on('error', (e) => console.error('xdg-open failed:', e));
		child.unref();
		return true;
	} catch (e) {
		console.error('xdg-open spawn failed:', e);
		return false;
	}
}

/** Reveal a file in the file manager, highlighting it when the DBus API exists. */
function revealInFileManager(filePath: string): boolean {
	try {
		const child = spawn(
			'dbus-send',
			[
				'--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
				'--type=method_call', '/org/freedesktop/FileManager1',
				'org.freedesktop.FileManager1.ShowItems',
				`array:string:file://${filePath}`, 'string:'
			],
			{ stdio: 'ignore' }
		);
		let failed = false;
		child.on('error', () => { failed = true; });
		child.on('close', (code) => {
			if (failed || code !== 0) xdgOpen(path.dirname(filePath)); // fallback: open folder
		});
		return true;
	} catch {
		return xdgOpen(path.dirname(filePath));
	}
}

// ── Scheduler: cap concurrent engine processes ───────────────────────────────
let activeDownloads = 0;
const pendingJobs: Array<() => Promise<void>> = [];

function pumpScheduler() {
	while (activeDownloads < runtime.maxConcurrentDownloads && pendingJobs.length > 0) {
		const job = pendingJobs.shift()!;
		activeDownloads++;
		job()
			.catch((e) => console.error('❌ Scheduled download job failed:', e))
			.finally(() => {
				activeDownloads--;
				pumpScheduler();
			});
	}
}

function scheduleDownload(job: () => Promise<void>) {
	pendingJobs.push(job);
	pumpScheduler();
}

async function setStatus(id: string, status: DownloadStatus) {
	await db.update(downloads).set({ status }).where(eq(downloads.id, id));
}

async function markError(id: string, error: string) {
	await setStatus(id, 'error');
	broadcast({ type: 'DOWNLOAD_ERROR', downloadId: id, error });
}

/** Prefer a human-readable discovery/fatal line from engine stderr over bare exit codes. */
function pickEngineErrorFromLog(log: string): string | undefined {
	if (!log) return undefined;
	const lines = log
		.split(/\r?\n/)
		.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
		.filter(Boolean);
	const interesting = lines.filter(
		(l) =>
			/could not discover|discovered file size is zero|insufficient disk|file too large|blocked|✗|error:|fatal/i.test(
				l
			) && !/^\s*│/.test(l)
	);
	const pick = interesting.at(-1) || lines.at(-1);
	if (!pick) return undefined;
	return pick.replace(/^[✗✅⚠️🔍📦]*\s*/u, '').slice(0, 280);
}

function specFromRow(row: typeof downloads.$inferSelect): JobSpec {
	// savePath layout is `${baseDir}/${category}/${fileName}`.
	const category = path.basename(path.dirname(row.savePath));
	return {
		id: row.id,
		pageUrl: row.url,
		fileName: row.fileName,
		savePath: row.savePath,
		category,
		threads: runtime.defaultThreads,
		allowRename: false,
		directUrl: row.directUrl ?? undefined,
		referer: row.referer ?? undefined
	};
}

/**
 * Resolve the media URL (re-extracting for video sites so expired CDN links are
 * refreshed on resume), verify disk space, spawn the engine, and stream
 * progress. Holds a scheduler slot until the engine process settles.
 */
async function runDownloadJob(spec: JobSpec): Promise<void> {
	const { id } = spec;
	let { savePath, fileName } = spec;
	try {
		// Never treat an Instagram/YouTube watch page as a downloadable file URL.
		const pageSource = detectMediaSource(spec.pageUrl);
		let directUrl = spec.directUrl;
		if (
			directUrl &&
			(detectMediaSource(directUrl) === 'instagram' ||
				detectMediaSource(directUrl) === 'youtube' ||
				/instagram\.com\/(p|reel|reels|tv|stories)\//i.test(directUrl))
		) {
			console.warn(`[Veloce] Ignoring page-like directUrl for ${pageSource}: ${directUrl.slice(0, 80)}`);
			directUrl = undefined;
		}
		// HLS/DASH / manifest.googlevideo — never feed playlist bodies to core_engine.
		if (directUrl && isManifestFormatUrl(directUrl)) {
			console.warn(
				`[Veloce] Omitting manifest directUrl (will re-extract/merge): ${directUrl.slice(0, 100)}`
			);
			directUrl = undefined;
		}
		// Instagram CDN often has no Content-Length — core_engine discovery fails.
		// Silent DASH / video CDN → merge. Audio-only (.m4a) keeps a direct CDN path.
		const igCdn =
			!!directUrl &&
			/(?:fbcdn\.net|cdninstagram\.com|(?:^|\.)instagram\.)/i.test(directUrl);
		const igAudioOnly =
			!!directUrl &&
			(/\.(?:m4a|aac|mp3|opus|ogg)(?:\?|$)/i.test(directUrl) ||
				/\baudio only\b/i.test(fileName));
		const forceIgMerge =
			pageSource === 'instagram' &&
			!igAudioOnly &&
			(!directUrl || igCdn || isInstagramSilentDashUrl(directUrl));

		let finalUrl = directUrl || spec.pageUrl;

		if (finalUrl.includes('mediafire.com')) {
			const fresh = await extractMediaUrl(finalUrl);
			if (!fresh) {
				console.error(`❌ Mediafire link expired or unavailable: ${finalUrl}`);
				await markError(id, 'MediaFire download link expired. Refresh the file page in your browser and try again.');
				return;
			}
			finalUrl = fresh;
		} else if (/github\.com|githubusercontent\.com/i.test(finalUrl)) {
			const gh = resolveGithubDownloadUrl(finalUrl);
			if ('error' in gh) {
				await markError(id, gh.error);
				return;
			}
			finalUrl = gh.url;
		} else if (
			forceIgMerge ||
			(!directUrl && !isDirectFileUrl(spec.pageUrl) && spec.category === VIDEO_CATEGORY)
		) {
			const source = pageSource;
			// Instagram: always merge via yt-dlp+ffmpeg when no usable engine URL.
			if (source === 'instagram' && (forceIgMerge || !directUrl)) {
				if (!isInstagramMediaPageUrl(spec.pageUrl)) {
					await markError(
						id,
						'Instagram download needs a post, reel, or story URL (/p/…, /reel/…, /stories/…), not the homepage. Open the video and use the Veloce badge.'
					);
					return;
				}
				const freeMerge = await freeSpaceFor(path.dirname(savePath));
				if (freeMerge !== null && freeMerge < MIN_FREE_BYTES) {
					console.error('❌ Insufficient disk space!');
					await markError(id, 'Insufficient disk space');
					return;
				}
				await setStatus(id, 'downloading');
				console.log(`[Veloce] Merge download via yt-dlp (${source}): ${spec.pageUrl}`);
				const { proc, promise } = startMergedYtDlpDownload(spec.pageUrl, savePath);
				running.set(id, { proc, intent: 'normal' });
				const result = await promise;
				const intent = running.get(id)?.intent ?? 'normal';
				running.delete(id);

				if (intent === 'cancelled' || (!result.ok && result.error === 'cancelled')) {
					await cleanupFiles(savePath);
					await db.delete(downloads).where(eq(downloads.id, id));
					broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: id });
					return;
				}
				if (intent === 'paused') {
					await setStatus(id, 'paused');
					broadcast({ type: 'DOWNLOAD_PAUSED', downloadId: id });
					return;
				}
				if (!result.ok) {
					await markError(id, result.error);
					return;
				}
				const size = existsSync(savePath) ? statSync(savePath).size : 0;
				await db
					.update(downloads)
					.set({ downloadedBytes: size, totalBytes: size, status: 'completed' })
					.where(eq(downloads.id, id));
				await setStatus(id, 'completed');
				broadcast({
					type: 'DOWNLOAD_COMPLETED',
					downloadId: id,
					status: 'completed',
					downloaded: size,
					total: size
				});
				return;
			}

			// Prefer a single muxed CDN URL for the range engine (YouTube / others).
			const muxed = await extractMediaWithFormat(
				spec.pageUrl,
				'best[vcodec!=none][acodec!=none]'
			);
			if (muxed?.url && !isManifestFormatUrl(muxed.url)) {
				finalUrl = muxed.url;
			} else if (source === 'youtube') {
				// DASH split A/V — yt-dlp + ffmpeg merge (core_engine cannot mux two URLs).
				const freeMerge = await freeSpaceFor(path.dirname(savePath));
				if (freeMerge !== null && freeMerge < MIN_FREE_BYTES) {
					console.error('❌ Insufficient disk space!');
					await markError(id, 'Insufficient disk space');
					return;
				}
				await setStatus(id, 'downloading');
				console.log(`[Veloce] Merge download via yt-dlp (${source}): ${spec.pageUrl}`);
				const { proc, promise } = startMergedYtDlpDownload(spec.pageUrl, savePath);
				running.set(id, { proc, intent: 'normal' });
				const result = await promise;
				const intent = running.get(id)?.intent ?? 'normal';
				running.delete(id);

				if (intent === 'cancelled' || (!result.ok && result.error === 'cancelled')) {
					await cleanupFiles(savePath);
					await db.delete(downloads).where(eq(downloads.id, id));
					broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: id });
					return;
				}
				if (intent === 'paused') {
					await setStatus(id, 'paused');
					broadcast({ type: 'DOWNLOAD_PAUSED', downloadId: id });
					return;
				}
				if (!result.ok) {
					await markError(id, result.error);
					return;
				}
				const size = existsSync(savePath) ? statSync(savePath).size : 0;
				await db
					.update(downloads)
					.set({ downloadedBytes: size, totalBytes: size, status: 'completed' })
					.where(eq(downloads.id, id));
				await setStatus(id, 'completed');
				broadcast({
					type: 'DOWNLOAD_COMPLETED',
					downloadId: id,
					status: 'completed',
					downloaded: size,
					total: size
				});
				return;
			} else {
				const extracted = await extractMediaUrl(spec.pageUrl);
				if (!extracted || isManifestFormatUrl(extracted)) {
					console.error(`❌ Could not extract a direct media URL for ${spec.pageUrl}. Aborting.`);
					await markError(id, 'Could not extract a downloadable media URL (the site may require login, or yt-dlp/cookies failed).');
					return;
				}
				finalUrl = extracted;
			}

			// Improve a generic filename from the resolved URL — only for fresh downloads.
			if (spec.allowRename && (fileName.startsWith('file') || fileName.startsWith('download_file'))) {
				try {
					const u = new URL(finalUrl);
					const parts = u.pathname.split('/').filter((p) => p.length > 0);
					let betterName = parts.pop();
					if (betterName && betterName.includes('.')) {
						betterName = decodeURIComponent(betterName.replace(/\+/g, ' '));
						const baseDir = path.dirname(path.dirname(savePath));
						const newPath = safeJoin(baseDir, spec.category, betterName);
						if (newPath) {
							fileName = sanitizeFileName(betterName);
							savePath = newPath;
							await db.update(downloads).set({ fileName, savePath }).where(eq(downloads.id, id));
						}
					}
				} catch {
					// keep original name
				}
			}
		}

		// Disk space sanity check (early, coarse). The engine does the precise,
		// size-aware check after it discovers the content length.
		const free = await freeSpaceFor(path.dirname(savePath));
		if (free !== null && free < MIN_FREE_BYTES) {
			console.error('❌ Insufficient disk space!');
			await markError(id, 'Insufficient disk space');
			return;
		}

		await setStatus(id, 'downloading');
		finalUrl = sanitizeDownloadMediaUrl(finalUrl);
		if (isManifestFormatUrl(finalUrl)) {
			await markError(
				id,
				'Cannot download a stream manifest as a file. Open the video page and retry from the Veloce badge.'
			);
			return;
		}
		const referer = refererForDownload(spec.pageUrl, finalUrl, spec.referer);
		if (!referer && isSignedCdnUrl(finalUrl)) {
			await markError(
				id,
				'CDN blocked this link (missing page referer). Reload the Veloce extension, refresh the video page, and download again from the Veloce badge while the video is open.'
			);
			return;
		}
		const finalSafety = isSafeDownloadUrl(finalUrl);
		if (!finalSafety.ok) {
			await markError(id, finalSafety.reason);
			return;
		}
		const bin = coreEngineBinaryPath();
		const engineArgs = buildEngineCliArgs({
			id,
			url: finalUrl,
			savePath,
			threads: Math.min(64, Math.max(1, spec.threads || runtime.defaultThreads)),
			maxRateBytes: runtime.maxRateBytes,
			engineQuiet: runtime.engineQuiet,
			referer: referer || undefined,
			pageUrl: spec.pageUrl
		});
		const rustProcess = spawn(bin, engineArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
		running.set(id, { proc: rustProcess, intent: 'normal' });

		let resolveProc!: () => void;
		const procDone = new Promise<void>((r) => { resolveProc = r; });

		let settled = false;
		const settle = async (status: 'completed' | 'error' | 'paused', errorMsg?: string) => {
			if (settled) return;
			settled = true;
			if (status === 'completed') {
				const row = (await db.select().from(downloads).where(eq(downloads.id, id)))[0];
				const expected = Math.max(row?.totalBytes ?? 0, row?.downloadedBytes ?? 0);
				const disk = existsSync(savePath) ? statSync(savePath).size : 0;
				// Guard against engine exit 0 with a truncated file (wrong discovery size /
				// early close). Require disk to cover ~98% of the last reported total.
				if (expected > 1_048_576 && disk > 0 && disk < Math.floor(expected * 0.98)) {
					console.error(
						`[Veloce] Incomplete file on settle: disk=${disk} expected=${expected} path=${savePath}`
					);
					await setStatus(id, 'error');
					broadcast({
						type: 'DOWNLOAD_ERROR',
						downloadId: id,
						error: `Download incomplete (${disk} / ${expected} bytes). Try again — the CDN size may have been wrong.`
					});
					resolveProc();
					return;
				}
				const tot = Math.max(expected, disk);
				if (tot > 0) {
					await db
						.update(downloads)
						.set({ downloadedBytes: tot, totalBytes: tot })
						.where(eq(downloads.id, id));
				}
				await setStatus(id, 'completed');
				removeResumeSidecars(savePath);
				broadcast({
					type: 'DOWNLOAD_COMPLETED',
					downloadId: id,
					status: 'completed',
					downloaded: tot,
					total: tot
				});
			} else {
				await setStatus(id, status);
				if (status === 'paused') {
					broadcast({ type: 'DOWNLOAD_PAUSED', downloadId: id });
				} else {
					broadcast({ type: 'DOWNLOAD_ERROR', downloadId: id, error: errorMsg ?? 'Download failed' });
				}
			}
			resolveProc();
		};

		const finishCancelled = async () => {
			if (settled) return;
			settled = true;
			await cleanupFiles(savePath);
			await db.delete(downloads).where(eq(downloads.id, id));
			broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: id });
			resolveProc();
		};

		let lineBuffer = '';
		let lastDbWrite = 0;
		let lastEngineError: string | undefined;
		let stderrTail = '';
		rustProcess.stderr?.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString();
			process.stderr.write(text);
			stderrTail = (stderrTail + text).slice(-8192);
		});
		rustProcess.stdout?.on('data', async (chunk) => {
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split('\n');
			lineBuffer = lines.pop()!;
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const progress = JSON.parse(line);
					if (progress.type === 'progress') {
						const now = Date.now();
						if (now - lastDbWrite > 5000) {
							lastDbWrite = now;
							await db.update(downloads)
								.set({ downloadedBytes: progress.downloaded, totalBytes: progress.total })
								.where(eq(downloads.id, id));
						}
						broadcast({
							type: 'PROGRESS',
							downloadId: id,
							downloaded: progress.downloaded,
							total: progress.total,
							speedBps: progress.speed_bps || 0,
							etaSecs: progress.eta_secs || 0,
							elapsedSecs: progress.elapsed_secs || 0,
							threads: progress.threads || []
						});
					} else if (progress.type === 'already_exists') {
						await settle('completed');
					} else if (progress.type === 'fatal') {
						lastEngineError = progress.error || 'Engine fatal error';
						console.error(`\n[Veloce] Engine fatal: ${lastEngineError}`);
						await settle('error', lastEngineError);
					}
				} catch { /* non-JSON engine line */ }
			}
		});

		rustProcess.on('error', async (err) => {
			console.error(`❌ Failed to launch core engine at ${bin}:`, err);
			await settle('error', `Could not start the download engine (${err.message}). Is core_engine built?`);
		});

		rustProcess.on('close', async (code) => {
			const intent = running.get(id)?.intent ?? 'normal';
			running.delete(id);
			if (intent === 'cancelled') {
				await finishCancelled();
			} else if (intent === 'paused') {
				await settle('paused');
			} else {
				const fromStderr = pickEngineErrorFromLog(stderrTail);
				const errMsg =
					code === 0
						? undefined
						: lastEngineError || fromStderr || `Engine exited with code ${code}`;

				// A `directUrl` handed to us from a warm format cache can be an
				// expired signed CDN link by the time the job runs. Re-extract
				// once from the page URL and retry in the same scheduler slot
				// before surfacing the failure to the user.
				if (
					code !== 0 &&
					spec.directUrl &&
					!spec.cdnRetried &&
					looksLikeStaleCdnFailure(`${stderrTail}\n${errMsg ?? ''}`)
				) {
					console.warn(
						`[Veloce] Direct URL looked stale for ${id}; re-extracting from page and retrying once.`
					);
					removeBestUrlCache(spec.pageUrl);
					try {
						await runDownloadJob({
							...spec,
							directUrl: undefined,
							cdnRetried: true,
							allowRename: false
						});
					} finally {
						resolveProc();
					}
					return;
				}

				await settle(code === 0 ? 'completed' : 'error', errMsg);
			}
		});

		await procDone;
	} catch (e) {
		console.error('❌ Background processing failed:', e);
		running.delete(id);
		try {
			await markError(id, 'Internal error while starting download');
		} catch {}
	}
}

const EXTRACTOR_DOMAINS = ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'];


function categoryFor(sourceUrl: string, rawName: string): { category: string; rawName: string } {
	let ext = path.extname(rawName).toLowerCase();
	try {
		const hostname = new URL(sourceUrl).hostname.toLowerCase();
		if (EXTRACTOR_DOMAINS.some((d) => hostname.includes(d))) {
			if (!ext) rawName += (ext = '.mp4');
			return { category: VIDEO_CATEGORY, rawName };
		}
	} catch { /* ignore */ }
	return { category: categoryForExt(ext), rawName };
}

interface QueueOpts {
	macAddress: string;
	rawUrl: string; // normalized source url (used for dedup + re-extraction)
	fileName: string;
	baseDir: string;
	threads: number;
	directUrl?: string;
	ext?: string;
	referer?: string;
}

/**
 * Write bytes that only exist in the browser (blob:/data: URLs) straight to
 * disk — no Rust engine. Used for AI-generated images and canvas exports.
 */
async function saveBlobDownload(opts: {
	macAddress: string;
	base64: string;
	fileName: string;
	mime?: string;
	baseDir: string;
	/** Page URL or synthetic id for history/dedup. */
	sourceUrl: string;
}): Promise<{ ok: true; downloadId: string } | { ok: false; error: string }> {
	let buf: Buffer;
	try {
		buf = Buffer.from(opts.base64, 'base64');
	} catch {
		return { ok: false, error: 'Invalid blob data.' };
	}
	if (buf.length === 0) return { ok: false, error: 'Empty blob.' };
	if (buf.length > MAX_BLOB_BYTES) {
		return { ok: false, error: `Blob too large (max ${Math.round(MAX_BLOB_BYTES / 1048576)} MB).` };
	}

	let rawName = sanitizeFileName(opts.fileName || 'download');
	if (!path.extname(rawName) && opts.mime) {
		const stem = rawName.replace(/\.[^.]+$/, '') || 'download';
		rawName = sanitizeFileName(stem + mimeToExt(opts.mime));
	}

	const ext = path.extname(rawName).toLowerCase();
	const category = categoryForExt(ext || mimeToExt(opts.mime || ''));
	const desiredPath = safeJoin(opts.baseDir, category, rawName);
	if (!desiredPath) return { ok: false, error: 'Invalid file path.' };

	const free = await freeSpaceFor(path.dirname(desiredPath));
	if (free !== null && free < buf.length + MIN_FREE_BYTES) {
		return { ok: false, error: 'Insufficient disk space.' };
	}

	const savePath = await uniqueSavePath(desiredPath);
	const finalName = path.basename(savePath);
	const downloadId = crypto.randomUUID();
	const sourceUrl = opts.sourceUrl || `blob:local/${downloadId}`;

	await db.insert(downloads).values({
		id: downloadId,
		deviceId: opts.macAddress,
		url: sourceUrl,
		fileName: finalName,
		savePath,
		status: 'downloading',
		totalBytes: buf.length,
		downloadedBytes: 0
	});
	broadcast({ type: 'DOWNLOAD_ACK', downloadId, fileName: finalName, status: 'downloading' });

	try {
		await mkdir(path.dirname(savePath), { recursive: true });
		await writeFile(savePath, buf);
		await db.update(downloads)
			.set({ status: 'completed', downloadedBytes: buf.length, totalBytes: buf.length })
			.where(eq(downloads.id, downloadId));
		broadcast({
			type: 'PROGRESS',
			downloadId,
			downloaded: buf.length,
			total: buf.length,
			speedBps: 0,
			etaSecs: 0
		});
		broadcast({ type: 'DOWNLOAD_COMPLETED', downloadId, status: 'completed' });
		return { ok: true, downloadId };
	} catch (e) {
		console.error('SAVE_BLOB failed:', e);
		await cleanupFiles(savePath);
		await db.delete(downloads).where(eq(downloads.id, downloadId));
		broadcast({ type: 'DOWNLOAD_REMOVED', downloadId });
		return { ok: false, error: 'Could not write blob to disk.' };
	}
}

/**
 * Create (or attach to) a single download from a normalized request. Handles
 * categorization, path confinement, dedup, DB insert, ACK broadcast and
 * scheduling. Shared by the single-download and playlist-expansion paths.
 */
async function queueDownload(opts: QueueOpts): Promise<{ ok: true; downloadId: string } | { ok: false; error: string }> {
	const ghPage = resolveGithubDownloadUrl(opts.rawUrl);
	if ('error' in ghPage) return { ok: false, error: ghPage.error };
	let rawUrl = ghPage.url;

	let directUrl = opts.directUrl;
	if (directUrl) {
		const ghDirect = resolveGithubDownloadUrl(directUrl);
		if ('error' in ghDirect) return { ok: false, error: ghDirect.error };
		directUrl = ghDirect.url;
	} else if (isDirectFileUrl(rawUrl)) {
		directUrl = rawUrl;
	}

	let rawName = sanitizeFileName(opts.fileName || 'download_file');
	const isGenericName =
		!opts.fileName ||
		opts.fileName === 'download_file' ||
		opts.fileName.startsWith('file') ||
		/^direct(\.[a-z0-9]+)?$/i.test(opts.fileName) ||
		/^download(\.[a-z0-9]+)?$/i.test(opts.fileName);
	if (directUrl && isGenericName) {
		try {
			const du = new URL(directUrl);
			const fromPath = path.basename(du.pathname);
			if (fromPath && fromPath.includes('.')) {
				rawName = sanitizeFileName(fromPath);
			} else if (opts.ext) {
				const stem = rawName.replace(/\.[^.]+$/, '') || 'download';
				rawName = sanitizeFileName(`${stem}${opts.ext.startsWith('.') ? opts.ext : '.' + opts.ext}`);
			}
		} catch { /* keep rawName */ }
	}

	const cat = categoryFor(rawUrl, rawName);
	const category = cat.category;
	rawName = cat.rawName;

	const desiredPath = safeJoin(opts.baseDir, category, rawName);
	if (!desiredPath) return { ok: false, error: 'Invalid file path' };

	// Dedup keyed on SOURCE url. A picked format/direct URL allows multiple
	// qualities but still collapses an *active* identical source+target.
	let duplicate: (typeof downloads.$inferSelect) | undefined;
	const sameSource = await db.select().from(downloads).where(eq(downloads.url, opts.rawUrl));
	if (!directUrl) {
		const activeDownload = sameSource.find((d) => ['queued', 'downloading', 'paused'].includes(d.status));
		const completedOnDisk = sameSource.find((d) => d.status === 'completed' && completedFileStillExists(d.savePath));
		const resumable = sameSource.find(
			(d) =>
				['paused', 'error', 'failed', 'cancelled'].includes(d.status) &&
				(hasResumeState(d.savePath) || existsSync(d.savePath))
		);
		duplicate = activeDownload ?? resumable ?? completedOnDisk;
	} else {
		duplicate = sameSource.find(
			(d) => ['queued', 'downloading'].includes(d.status) && path.basename(d.savePath) === rawName
		);
	}
	if (duplicate) {
		if (['paused', 'error', 'failed', 'cancelled'].includes(duplicate.status)) {
			await setStatus(duplicate.id, 'queued');
			migrateLegacySidecars(duplicate.savePath);
			broadcast({ type: 'DOWNLOAD_ACK', downloadId: duplicate.id, fileName: duplicate.fileName, status: 'queued' });
			scheduleDownload(() => runDownloadJob(specFromRow(duplicate!)));
			return { ok: true, downloadId: duplicate.id };
		}
		broadcast({ type: 'DOWNLOAD_ACK', downloadId: duplicate.id, fileName: duplicate.fileName, status: duplicate.status });
		return { ok: true, downloadId: duplicate.id };
	}

	const savePath = await uniqueSavePath(desiredPath);
	const finalName = path.basename(savePath);
	const downloadId = crypto.randomUUID();
	const storedReferer = opts.referer ||
		refererForDownload(opts.rawUrl, directUrl || opts.rawUrl);
	await db.insert(downloads).values({
		id: downloadId,
		deviceId: opts.macAddress,
		url: opts.rawUrl,
		directUrl: directUrl ?? null,
		referer: storedReferer ?? null,
		fileName: finalName,
		savePath,
		status: 'queued'
	});
	broadcast({ type: 'DOWNLOAD_ACK', downloadId, fileName: finalName, status: 'queued' });

	scheduleDownload(() => runDownloadJob({
		id: downloadId,
		pageUrl: opts.rawUrl,
		fileName: finalName,
		savePath,
		category,
		threads: opts.threads,
		allowRename: !directUrl && !isDirectFileUrl(rawUrl),
		directUrl,
		referer: storedReferer
	}));
	return { ok: true, downloadId };
}

/**
 * On startup, reclaim downloads that were mid-flight when the process last
 * stopped. Their engine child was killed with us, but the `.veloce_state`
 * sidecar lets the engine resume. This delivers the crash-recovery promise.
 */
async function reconcileInterrupted() {
	try {
		sweepLegacySidecars(runtime.baseDirectory);
		const stuck = await db.select().from(downloads)
			.where(inArray(downloads.status, ['downloading', 'queued']));
		if (stuck.length === 0) return;
		for (const row of stuck) {
			migrateLegacySidecars(row.savePath);
			// Only auto-resume rows that actually made progress. A row with no
			// bytes, no partial file and no resume state is likely a job that
			// fails immediately (dead URL, missing engine, bad cookies) — re-running
			// it on every coordinator start just re-fails it silently. Surface it
			// so the user retries deliberately.
			const madeProgress =
				(row.downloadedBytes ?? 0) > 0 ||
				hasResumeState(row.savePath) ||
				existsSync(row.savePath);
			if (!madeProgress) {
				await markError(
					row.id,
					'Interrupted before any data downloaded — click Retry.'
				);
				continue;
			}
			await setStatus(row.id, 'queued');
			scheduleDownload(() => runDownloadJob(specFromRow(row)));
		}
	} catch (e) {
		console.error('Failed to reconcile interrupted downloads:', e);
	}
}

let reconciled = false;
let dbCleaned = false;

const WSS_SINGLETON_KEY = '__veloce_wss_attached';

export function setupWebSocketServer(server: Server) {
	// Vite HMR re-runs this module — never attach a second WebSocketServer to the same HTTP server.
	if ((server as Server & { [WSS_SINGLETON_KEY]?: boolean })[WSS_SINGLETON_KEY]) {
		return;
	}
	(server as Server & { [WSS_SINGLETON_KEY]?: boolean })[WSS_SINGLETON_KEY] = true;
	console.log(`[Veloce] WebSocket ready — ws://localhost:${config.port}/ws`);

	const wss = new WebSocketServer({
		server,
		path: '/ws',
		verifyClient: (info: { origin: string; secure: boolean; req: import('http').IncomingMessage }) => {
			const ok = isAllowedOrigin(info.origin);
			if (!ok) console.warn(`🚫 Rejected WebSocket from disallowed origin: ${info.origin}`);
			return ok;
		}
	});

	if (!reconciled) {
		reconciled = true;
		dbInit.then(() => reconcileInterrupted());
	}
	if (!dbCleaned) {
		dbCleaned = true;
		dbInit.then(() => runDatabaseCleanup());
	}

	wss.on('connection', async (ws, req) => {
		clients.add(ws);
		const origin = req.headers.origin || 'native';
		console.log(`[Veloce] client connected from ${origin} (${clients.size} total)`);
		const macAddress = getMacAddress();

		try {
			await dbInit;
			const deviceResult = await db.select().from(devices).where(eq(devices.id, macAddress));
			if (deviceResult.length === 0) {
				await db.insert(devices).values({ id: macAddress, createdAt: new Date(), lastActive: new Date(), settings: {} });
			} else {
				await db.update(devices).set({ lastActive: new Date() }).where(eq(devices.id, macAddress));
			}
			await loadSettings(macAddress);
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: runtime.baseDirectory } }));
				ws.send(JSON.stringify({ type: 'SETTINGS', settings: { ...runtime } }));
			}
		} catch (err) {
			console.error('Failed to initialize device identity:', err);
		}

		// Rehydrate the popup with a snapshot of recent/active downloads.
		try {
			const recent = await db.select().from(downloads)
				.where(eq(downloads.deviceId, macAddress))
				.orderBy(sql`rowid desc`)
				.limit(50);
			const playlists = await listPlaylistJobsForDevice(macAddress);
			const snapshot = [
				...playlists.map(playlistJobToSnapshot),
				...recent
					.filter((d) => !isOrphanPlaylistDownloadRow(d))
					.slice(0, 20)
					.map((d) => ({
						downloadId: d.id,
						fileName: d.fileName,
						status: d.status,
						downloaded: d.downloadedBytes ?? 0,
						total: d.totalBytes ?? 0
					}))
			];
			if (ws.readyState === 1 && snapshot.length > 0) {
				ws.send(JSON.stringify({ type: 'DOWNLOAD_SNAPSHOT', downloads: snapshot }));
			}
			for (const pl of playlists) {
				if (['queued', 'downloading'].includes(pl.status) && !isActivePlaylistJob(pl.id)) {
					if (pl.status === 'downloading') {
						await db.update(playlistJobs).set({ status: 'queued' }).where(eq(playlistJobs.id, pl.id));
					}
					schedulePlaylistJob(pl.id, playlistRuntimeFromSettings(), broadcast);
				}
			}
		} catch (err) {
			console.error('Failed to send download snapshot:', err);
		}

		ws.on('message', async (message) => {
			try {
				const data = JSON.parse(message.toString());

				if (data.type === 'PING') {
					if (ws.readyState === 1) {
						ws.send(JSON.stringify({ type: 'PONG' }));
					}
					return;
				}

				if (data.type === 'SAVE_BLOB') {
					const payload = data.payload ?? {};
					let baseDir = payload.baseDirectory;
					if (!baseDir || String(baseDir).trim() === '') {
						baseDir = runtime.baseDirectory;
					}
					const result = await saveBlobDownload({
						macAddress,
						base64: payload.base64 ?? '',
						fileName: payload.fileName ?? 'download',
						mime: payload.mime,
						baseDir,
						sourceUrl: payload.sourceUrl ?? payload.pageUrl ?? 'blob:browser'
					});
					if (!result.ok) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: result.error }));
					}
					return;
				}

				if (data.type === 'NEW_DOWNLOAD') {
					console.log(`[Veloce] NEW_DOWNLOAD: ${data.payload?.fileName || 'file'} | ${data.payload?.directUrl || data.payload?.url || ''}`);
					// Validate the URL up front (scheme + SSRF guard).
					const safety = isSafeDownloadUrl(data.payload.url ?? '');
					if (!safety.ok) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: safety.reason }));
						return;
					}
					if (data.payload.directUrl) {
						const directSafety = isSafeDownloadUrl(data.payload.directUrl);
						if (!directSafety.ok) {
							ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: directSafety.reason }));
							return;
						}
					}

					// Normalize URL (strip tracking params).
					let referer = data.payload.referer || data.payload.pageUrl;
					let rawUrl = data.payload.url;
					if (data.payload.directUrl && referer && rawUrl === data.payload.directUrl) {
						rawUrl = referer;
					}
					try {
						const urlObj = new URL(rawUrl);
						for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'igsh', 'fbclid', 'gclid', 'si']) {
							urlObj.searchParams.delete(p);
						}
						rawUrl = urlObj.toString();
					} catch {
						console.error('Invalid URL during normalization');
					}

					const threads = Math.min(64, Math.max(1, Number(data.payload.threads) || runtime.defaultThreads));

					let baseDir = data.payload.baseDirectory;
					if (!baseDir || baseDir.trim() === '') {
						baseDir = runtime.baseDirectory;
					}

					// Playlist: one folder per playlist; audio preferred, else 720p video (step down).
					if (data.payload.playlist) {
						const result = await queuePlaylistDownload({
							macAddress,
							playlistUrl: rawUrl,
							referer: data.payload.referer || data.payload.pageUrl,
							baseDir,
							threads,
							formatSettings: runtime.playlistFormats,
							runtime: playlistRuntimeFromSettings(),
							broadcast
						});
						if (!result.ok) {
							ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: result.error }));
							return;
						}
						schedulePlaylistJob(result.playlistId, playlistRuntimeFromSettings(), broadcast);
						ws.send(JSON.stringify({
							type: 'PLAYLIST_QUEUED',
							playlistId: result.playlistId,
							count: result.total,
							total: result.total,
							folder: result.saveDir,
							title: result.title
						}));
						return;
					}

					const result = await queueDownload({
						macAddress,
						rawUrl,
						fileName: data.payload.fileName || 'download_file',
						baseDir,
						threads,
						directUrl: data.payload.directUrl,
						ext: data.payload.ext,
						referer: data.payload.referer || data.payload.pageUrl
					});
					if (!result.ok) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: result.error }));
					}
				} else if (data.type === 'LIST_FORMATS') {
					// Non-blocking — desktop tokio::spawn parity. Awaiting yt-dlp here used to
					// stall the whole WS read loop so prefetch + badge clicks serialized.
					const pageUrl = data.payload?.url ?? '';
					const requestId = data.requestId;
					const force = data.payload?.force === true;
					if (/^(blob:|data:|mediastream:)/i.test(pageUrl)) {
						ws.send(JSON.stringify({
							type: 'FORMATS_ERROR',
							requestId,
							error: 'Browser-only blob URL — reload the Veloce extension and refresh the page. The badge should resolve to the Instagram post link (/p/…).'
						}));
						return;
					}
					const safety = isSafeDownloadUrl(pageUrl);
					if (!safety.ok) {
						ws.send(JSON.stringify({ type: 'FORMATS_ERROR', requestId, error: safety.reason }));
						return;
					}
					void (async () => {
						try {
							const formats = await listFormats(pageUrl, { force });
							if (!formats.length) {
								const hint = getRecentFormatError(pageUrl);
								if (ws.readyState === 1) {
									ws.send(JSON.stringify({
										type: 'FORMATS_ERROR',
										requestId,
										error: hint ?? 'No formats found for this URL.'
									}));
								}
								return;
							}
							if (ws.readyState === 1) {
								ws.send(JSON.stringify({ type: 'FORMATS_LIST', requestId, formats }));
							}
						} catch (e) {
							console.error('LIST_FORMATS failed:', e);
							if (ws.readyState === 1) {
								ws.send(JSON.stringify({ type: 'FORMATS_ERROR', requestId, error: 'Could not list formats.' }));
							}
						}
					})();
				} else if (data.type === 'PAUSE_DOWNLOAD') {
					const pl = await getPlaylistJob(data.downloadId);
					if (pl) {
						pausePlaylistJob(data.downloadId);
						broadcast({ type: 'PLAYLIST_UPDATE', playlistId: pl.id, fileName: `${pl.title} (${pl.currentIndex}/${pl.totalTracks} tracks)`, status: 'paused', isPlaylist: true });
						return;
					}
					const r = running.get(data.downloadId);
					if (r) {
						r.intent = 'paused';
						r.proc.kill('SIGTERM');
					}
				} else if (data.type === 'RESUME_DOWNLOAD') {
					const pl = await getPlaylistJob(data.downloadId);
					if (pl && pl.status === 'paused' && !isActivePlaylistJob(pl.id)) {
						await resumePlaylistJob(pl.id, playlistRuntimeFromSettings(), broadcast);
						return;
					}
					const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
					if (row && ['paused', 'error', 'queued'].includes(row.status) && !running.has(row.id)) {
						await setStatus(row.id, 'queued');
						broadcast({ type: 'DOWNLOAD_ACK', downloadId: row.id, fileName: row.fileName, status: 'queued' });
						scheduleDownload(() => runDownloadJob(specFromRow(row)));
					}
				} else if (data.type === 'CANCEL_DOWNLOAD') {
					const pl = await getPlaylistJob(data.downloadId);
					if (pl) {
						await cancelPlaylistJob(data.downloadId, broadcast);
						return;
					}
					const r = running.get(data.downloadId);
					if (r) {
						r.intent = 'cancelled';
						r.proc.kill('SIGTERM'); // close handler does cleanup + row delete
					} else {
						const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
						if (row) {
							await cleanupFiles(row.savePath);
							await db.delete(downloads).where(eq(downloads.id, row.id));
						}
						broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: data.downloadId });
					}
				} else if (data.type === 'REMOVE_DOWNLOAD') {
					const pl = await getPlaylistJob(data.downloadId);
					if (pl && !isActivePlaylistJob(pl.id)) {
						await db.delete(playlistJobs).where(eq(playlistJobs.id, pl.id));
						broadcast({ type: 'PLAYLIST_REMOVED', playlistId: pl.id });
						return;
					}
					// Remove from history only (keeps any completed file on disk).
					if (!running.has(data.downloadId)) {
						await db.delete(downloads).where(eq(downloads.id, data.downloadId));
						broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: data.downloadId });
					}
				} else if (data.type === 'REQUEST_DIRECTORY_PICKER') {
					const result = pickDirectory();
					if (result) {
						runtime.baseDirectory = result;
						await persistSettings(macAddress);
						if (ws.readyState === 1) {
							ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: result } }));
						}
					} else if (ws.readyState === 1) {
						ws.send(JSON.stringify({
							type: 'DIRECTORY_PICKER_UNAVAILABLE',
							error: 'No graphical folder picker found. Install zenity or kdialog, or type the path manually.'
						}));
					}
				} else if (data.type === 'OPEN_FILE' || data.type === 'REVEAL_FILE') {
					const pl = await getPlaylistJob(data.downloadId);
					if (pl?.saveDir && existsSync(pl.saveDir)) {
						if (data.type === 'OPEN_FILE') xdgOpen(pl.saveDir);
						else revealInFileManager(pl.saveDir);
						return;
					}
					const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
					if (!row) return;
					if (!existsSync(row.savePath)) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: row.id, error: 'File no longer exists on disk.' }));
						return;
					}
					if (data.type === 'OPEN_FILE') xdgOpen(row.savePath);
					else revealInFileManager(row.savePath);
				} else if (data.type === 'GET_SETTINGS') {
					if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'SETTINGS', settings: { ...runtime } }));
				} else if (data.type === 'SET_SETTINGS') {
					applySettings(data.payload ?? {});
					await persistSettings(macAddress);
					pumpScheduler(); // a raised concurrency cap may free queued jobs immediately
					broadcast({ type: 'SETTINGS', settings: { ...runtime } });
				}
			} catch (err) {
				console.error('❌ Failed to process WebSocket message:', err);
			}
		});

		ws.on('close', () => {
			clients.delete(ws);
			console.log(`[Veloce] client disconnected (${clients.size} remaining)`);
		});
	});
}
