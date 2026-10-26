// Veloce background service worker — sole owner of the WebSocket to the Local Coordinator.
// Popup and content scripts route through here so only one connection exists.

const WS_URL = 'ws://127.0.0.1:14921/ws';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let wsPingTimer = null;
const livePorts = new Set();
/** Tab id of the active tab in the last-focused window — only it gets badges/prefetch. */
let foregroundTabId = null;
let previousForegroundTabId = null;

const CONTENT_SCRIPT_FILES = [
	'sites/registry.js',
	'sites/youtube.js',
	'sites/instagram.js',
	'sites/omnisave.js',
	'sites/mediafire.js',
	'content.js'
];
const downloads = {};
let selectedDirectory = null;
let settings = null;
const pendingFormatRequests = new Map(); // requestId -> { sendResponse, url? }
const NOTIF_ICON = 'icons/icon-128.png';

/**
 * Map with a hard entry cap. The service worker can stay alive across a long
 * browsing session; without a cap `formatCache` / `formatFailCache` accumulate
 * one entry per video/post ever hovered (each holding multi-KB signed CDN URLs)
 * and never shrink. FIFO-evict the oldest key on overflow. Per-entry TTL is still
 * checked on read so stale entries never surface — this only bounds footprint.
 */
class BoundedMap extends Map {
	constructor(capacity) {
		super();
		this._cap = capacity;
	}
	set(key, value) {
		if (!this.has(key) && this.size >= this._cap) {
			const oldest = this.keys().next().value;
			if (oldest !== undefined) this.delete(oldest);
		}
		return super.set(key, value);
	}
}

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const FORMAT_FAIL_TTL_MS = 5 * 60 * 1000;
const PREFETCH_FAIL_TTL_MS = 45 * 1000;
const FORMAT_CACHE_MAX = 300;
const formatCache = new BoundedMap(FORMAT_CACHE_MAX); // normalized url -> { formats, ts }
const formatFailCache = new BoundedMap(FORMAT_CACHE_MAX); // normalized url -> { ts, prefetch?: boolean }
const inflightFormatUrls = new Set();
const prefetchQueue = [];
const prefetchQueued = new Set();
let prefetchRunning = 0;
const PREFETCH_LIMIT = 2;
const PREFETCH_QUEUE_MAX = 24;
const WS_PING_MS = 25000;

/** True when the offscreen document (or legacy SW socket) is linked to the coordinator. */
let useOffscreenWs = false;
let coordinatorConnectInFlight = null;
let offscreenHealthTimer = null;

/** Backstop between user-triggered connectCoordinator() calls — the 1-min keepalive alarm alone can leave a dead offscreen socket undetected for up to 60s. */
function startOffscreenHealthCheck() {
	if (offscreenHealthTimer) return;
	offscreenHealthTimer = setInterval(() => {
		if (useOffscreenWs) void connectCoordinator();
	}, WS_PING_MS);
}

function retireLegacySocket() {
	if (!ws) return;
	try {
		ws.onclose = null;
		ws.onerror = null;
		ws.close();
	} catch { /* ignore */ }
	ws = null;
	stopWsPing();
}

/** MV3 service workers sleep — offscreen document keeps the WebSocket alive. */
async function ensureOffscreenDocument() {
	if (!chrome.offscreen?.createDocument) return false;
	try {
		if (await chrome.offscreen.hasDocument()) {
			useOffscreenWs = true;
			retireLegacySocket();
			return true;
		}
		await chrome.offscreen.createDocument({
			url: 'offscreen.html',
			reasons: ['WORKERS'],
			justification: 'Keep a stable WebSocket to the local Veloce download coordinator while the browser is open.'
		});
		useOffscreenWs = true;
		retireLegacySocket();
		return true;
	} catch (e) {
		// Document may already exist if another service-worker instance raced us.
		try {
			if (await chrome.offscreen.hasDocument()) {
				useOffscreenWs = true;
				retireLegacySocket();
				return true;
			}
		} catch { /* ignore */ }
		console.warn('[Veloce] Offscreen unavailable, falling back to service-worker socket', e);
		useOffscreenWs = false;
		return false;
	}
}

/** Match backend normalizeFormatUrl — one cache entry per video/post. */
function normalizeFormatUrl(url) {
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
			u.pathname = u.pathname.replace(/\/reels\//i, '/reel/').replace(/\/+$/, '');
		}
		return u.href;
	} catch {
		return url;
	}
}

function getFormatCache(url) {
	const key = normalizeFormatUrl(url);
	const hit = formatCache.get(key);
	if (hit && Date.now() - hit.ts < FORMAT_CACHE_TTL_MS) return hit.formats;
	return null;
}

function isFormatFailed(url) {
	const key = normalizeFormatUrl(url);
	const hit = formatFailCache.get(key);
	if (!hit) return false;
	const ttl = hit.prefetch ? PREFETCH_FAIL_TTL_MS : FORMAT_FAIL_TTL_MS;
	return Date.now() - hit.ts < ttl;
}

function setFormatFail(url, prefetch = false) {
	const key = normalizeFormatUrl(url);
	if (!key) return;
	formatFailCache.set(key, { ts: Date.now(), prefetch });
}

function clearFormatFail(url) {
	formatFailCache.delete(normalizeFormatUrl(url));
}

function setFormatCache(url, formats) {
	const key = normalizeFormatUrl(url);
	if (formats?.length) {
		formatCache.set(key, { formats, ts: Date.now() });
		clearFormatFail(key);
		broadcastToExtension({ type: 'VELOCE_FORMATS_READY', url: key, formats });
	}
}

function notifyFormatFailed(url, prefetch = false) {
	setFormatFail(url, prefetch);
	broadcastToExtension({ type: 'VELOCE_FORMATS_FAILED', url: normalizeFormatUrl(url), prefetch });
}

function isForegroundTab(tabId) {
	return tabId != null && tabId === foregroundTabId;
}

async function refreshForegroundTab() {
	const prev = foregroundTabId;
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		foregroundTabId = tab?.id ?? null;
	} catch {
		foregroundTabId = null;
	}
	broadcastForegroundState(prev);
}

function notifyTabForegroundState(tabId, active) {
	if (tabId == null) return;
	const msg = { type: 'VELOCE_FOREGROUND_STATE', active };
	chrome.tabs.sendMessage(tabId, msg).catch(() => {});
	for (const port of livePorts) {
		if (port.name !== 'veloce-tab' || port.sender?.tab?.id !== tabId) continue;
		try { port.postMessage(msg); } catch { /* ignore */ }
	}
}

/** Only the active tab (and the tab that just lost focus) are notified — not every open tab. */
function broadcastForegroundState(previousId = previousForegroundTabId) {
	previousForegroundTabId = foregroundTabId;
	const targets = new Set();
	if (foregroundTabId != null) targets.add(foregroundTabId);
	if (previousId != null && previousId !== foregroundTabId) targets.add(previousId);
	for (const tabId of targets) {
		notifyTabForegroundState(tabId, tabId === foregroundTabId);
	}
}

async function reinjectContentOnActiveTab() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) return;
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: CONTENT_SCRIPT_FILES
		});
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				files: ['inject-intercept.js'],
				world: 'MAIN'
			});
		} catch { /* MAIN hook may already be installed */ }
		await refreshForegroundTab();
	} catch (e) {
		console.warn('[Veloce] Active-tab re-inject failed, reloading tab', e);
		try {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab?.id && tab.url && /^https?:/i.test(tab.url)) await chrome.tabs.reload(tab.id);
		} catch { /* ignore */ }
	}
}

function drainPrefetchQueue() {
	if (!hasLiveClients()) return;
	if (foregroundTabId == null) return;
	connectWs();
	while (prefetchRunning < PREFETCH_LIMIT && prefetchQueue.length > 0) {
		const url = prefetchQueue.shift();
		prefetchQueued.delete(url);
		if (!url || getFormatCache(url) || inflightFormatUrls.has(url)) continue;
		prefetchRunning++;
		traceFormats('prefetch start', { url, running: prefetchRunning, queueLeft: prefetchQueue.length });
		void requestFormatsFromCoordinator(url, (data) => {
			prefetchRunning--;
			traceFormats(data.formats?.length ? 'prefetch OK' : 'prefetch FAIL', {
				url,
				count: data.formats?.length ?? 0,
				error: data.error
			});
			if (data.formats?.length) setFormatCache(url, data.formats);
			else notifyFormatFailed(url, true);
			drainPrefetchQueue();
		}, true);
	}
}

function enqueuePrefetch(url, front = false) {
	const key = normalizeFormatUrl(url);
	if (!key || getFormatCache(key) || isFormatFailed(key) || inflightFormatUrls.has(key) || prefetchQueued.has(key)) return;
	if (!front && prefetchQueue.length >= PREFETCH_QUEUE_MAX) return;
	prefetchQueued.add(key);
	if (front) prefetchQueue.unshift(key);
	else prefetchQueue.push(key);
	drainPrefetchQueue();
}

function prefetchFormats(url) {
	enqueuePrefetch(url);
}

function prefetchBatch(urls) {
	connectWs();
	if (!Array.isArray(urls) || !urls.length) return;
	for (const item of urls) {
		const url = typeof item === 'string' ? item : item?.url;
		const front = typeof item === 'object' && item?.priority;
		if (url) enqueuePrefetch(url, front);
	}
}

async function waitForInflightFormats(url, maxMs = 25000) {
	const key = normalizeFormatUrl(url);
	if (!inflightFormatUrls.has(key)) return getFormatCache(key);
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		const hit = getFormatCache(key);
		if (hit?.length) return hit;
		if (!inflightFormatUrls.has(key)) break;
		await new Promise((r) => setTimeout(r, 75));
	}
	return getFormatCache(key);
}

function broadcastToExtension(msg) {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function notify(id, title, message) {
	if (!chrome.notifications) return;
	try {
		chrome.notifications.create(id, {
			type: 'basic',
			iconUrl: NOTIF_ICON,
			title,
			message: String(message ?? '').slice(0, 300)
		});
	} catch { /* notifications may be unavailable */ }
}

function setConnected(val) {
	if (connected === val) return;
	connected = val;
	chrome.storage.local.set({ veloce_connected: val });
	broadcastToExtension({ type: 'VELOCE_STATE', connected: val, downloads, selectedDirectory });
}

function upsertDownload(id, patch) {
	const prev = downloads[id] ?? {
		id,
		fileName: 'Unknown file',
		status: 'queued',
		downloaded: 0,
		total: 0,
		speedBps: 0,
		etaSecs: 0,
		updatedAt: Date.now()
	};
	downloads[id] = { ...prev, ...patch, updatedAt: Date.now() };
	broadcastToExtension({ type: 'VELOCE_DOWNLOAD_UPDATE', download: downloads[id] });
}

function handleWsMessage(data) {
	switch (data.type) {
		case 'DOWNLOAD_SNAPSHOT':
			if (Array.isArray(data.downloads)) {
				for (const d of data.downloads) {
					const raw = d.status ?? 'queued';
					const status = raw === 'failed' || raw === 'cancelled' ? 'error' : raw;
					const prev = downloads[d.downloadId];
					const downloaded = d.downloaded ?? prev?.downloaded ?? 0;
					const total = d.total ?? prev?.total ?? 0;
					upsertDownload(d.downloadId, {
						fileName: d.fileName ?? prev?.fileName ?? 'Unknown file',
						status,
						downloaded,
						total,
						speedBps: 0,
						etaSecs: 0,
						error:
							status === 'error'
								? d.error || 'Download failed — click Retry'
								: undefined,
						isPlaylist: d.isPlaylist === true
					});
				}
			}
			break;
		case 'DOWNLOAD_ACK':
			upsertDownload(data.downloadId, {
				fileName: data.fileName,
				status: data.status ?? 'queued',
				error: undefined,
				speedBps: 0,
				etaSecs: 0
			});
			break;
		case 'PROGRESS':
			upsertDownload(data.downloadId, {
				status: 'downloading',
				downloaded: data.downloaded ?? 0,
				total: data.total ?? 0,
				speedBps: data.speedBps ?? 0,
				error: undefined,
				etaSecs: data.etaSecs ?? 0
			});
			break;
		case 'DOWNLOAD_COMPLETED': {
			const prev = downloads[data.downloadId];
			const tot = Math.max(
				data.total ?? 0,
				data.downloaded ?? 0,
				prev?.total ?? 0,
				prev?.downloaded ?? 0
			);
			const name = prev?.fileName ?? 'Download';
			upsertDownload(data.downloadId, {
				status: data.status ?? 'completed',
				downloaded: tot,
				total: tot,
				speedBps: 0,
				etaSecs: 0,
				error: undefined
			});
			notify(`veloce-done-${data.downloadId}`, 'Download complete', name);
			break;
		}
		case 'DOWNLOAD_PAUSED':
			upsertDownload(data.downloadId, { status: 'paused', speedBps: 0, etaSecs: 0, error: undefined });
			break;
		case 'DOWNLOAD_CANCELLED': {
			const name = downloads[data.downloadId]?.fileName ?? 'Download';
			delete downloads[data.downloadId];
			broadcastToExtension({ type: 'VELOCE_DOWNLOAD_CANCELLED', fileName: name });
			broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.downloadId });
			break;
		}
		case 'DOWNLOAD_REMOVED':
			delete downloads[data.downloadId];
			broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.downloadId });
			break;
		case 'DOWNLOAD_ERROR': {
			const name = downloads[data.downloadId]?.fileName ?? 'Download';
			upsertDownload(data.downloadId, {
				status: 'error',
				error: data.error ?? 'Download failed',
				speedBps: 0,
				etaSecs: 0
			});
			notify(`veloce-err-${data.downloadId ?? Date.now()}`, 'Download failed', `${name}: ${data.error ?? 'Unknown error'}`);
			break;
		}
		case 'SETTINGS':
			settings = data.settings ?? null;
			broadcastToExtension({ type: 'VELOCE_SETTINGS', settings });
			break;
		case 'PLAYLIST_QUEUED':
			notify('veloce-pl-' + Date.now(), 'Playlist started', `"${data.title || 'Playlist'}" — ${data.total} tracks, one job (see Settings for format).`);
			if (data.playlistId) {
				upsertDownload(data.playlistId, {
					fileName: `${data.title || 'Playlist'} (0/${data.total} tracks)`,
					status: 'queued',
					isPlaylist: true
				});
			}
			break;
		case 'PLAYLIST_UPDATE':
			if (data.playlistId) {
				upsertDownload(data.playlistId, {
					fileName: data.fileName || 'Playlist',
					status: data.status === 'cancelled' ? 'error' : (data.status || 'downloading'),
					downloaded: data.downloaded ?? 0,
					total: data.totalBytes ?? 0,
					speedBps: data.speedBps ?? 0,
					etaSecs: data.etaSecs ?? 0,
					isPlaylist: true,
					error: data.error
				});
			}
			break;
		case 'PLAYLIST_REMOVED':
			if (data.playlistId) {
				delete downloads[data.playlistId];
				broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.playlistId });
			}
			break;
		case 'PLAYLIST_FINISHED':
			if (data.playlistId) {
				const msg = `"${data.title || 'Playlist'}" done — ${data.completed ?? 0} saved, ${data.failed ?? 0} skipped`;
				notify(`veloce-pl-done-${data.playlistId}`, 'Playlist finished', msg);
				delete downloads[data.playlistId];
				broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.playlistId });
			}
			break;
		case 'DIRECTORY_SELECTED':
			selectedDirectory = data.payload?.path ?? null;
			if (selectedDirectory) chrome.storage.local.set({ veloce_base_dir: selectedDirectory });
			broadcastToExtension({ type: 'VELOCE_DIRECTORY', path: selectedDirectory });
			break;
		case 'DIRECTORY_PICKER_UNAVAILABLE':
			broadcastToExtension({ type: 'VELOCE_PICKER_ERROR', error: data.error });
			break;
		case 'FORMATS_LIST':
		case 'FORMATS_ERROR': {
			const pending = pendingFormatRequests.get(data.requestId);
			traceFormats(data.type === 'FORMATS_LIST' ? 'WS response OK' : 'WS response ERROR', {
				requestId: data.requestId,
				url: pending?.url,
				prefetch: pending?.prefetch === true,
				count: data.formats?.length ?? 0,
				error: data.error,
				hasPending: !!pending
			});
			if (pending) {
				pendingFormatRequests.delete(data.requestId);
				if (pending.url) inflightFormatUrls.delete(pending.url);
				if (data.type === 'FORMATS_LIST' && pending.url && data.formats?.length) {
					setFormatCache(pending.url, data.formats);
				} else if (pending.url && (data.type === 'FORMATS_ERROR' || !data.formats?.length)) {
					setFormatFail(pending.url, pending.prefetch === true);
				}
				pending.sendResponse(data);
			}
			break;
		}
	}
}

function hasLiveClients() {
	return livePorts.size > 0;
}

function handleOffscreenWsRelay(msg) {
	if (msg.type === 'VELOCE_WS_OPEN') {
		reconnectDelay = RECONNECT_BASE_MS;
		setConnected(true);
	} else if (msg.type === 'VELOCE_WS_CLOSE') {
		setConnected(false);
	} else if (msg.type === 'VELOCE_WS_MSG' && msg.data) {
		try {
			handleWsMessage(JSON.parse(msg.data));
		} catch (e) {
			console.error('[Veloce] Bad WS message', e);
		}
	}
}

function isCoordinatorLinked() {
	if (useOffscreenWs) return connected;
	return ws?.readyState === WebSocket.OPEN;
}

async function isCoordinatorLinkedAsync() {
	if (!useOffscreenWs) return ws?.readyState === WebSocket.OPEN;
	try {
		const r = await chrome.runtime.sendMessage({ type: 'VELOCE_WS_STATUS' });
		return r?.ready === true;
	} catch {
		return false;
	}
}

function stopWsPing() {
	if (wsPingTimer) {
		clearInterval(wsPingTimer);
		wsPingTimer = null;
	}
}

function startWsPing() {
	if (useOffscreenWs) return;
	stopWsPing();
	wsPingTimer = setInterval(() => {
		if (ws?.readyState === WebSocket.OPEN) {
			wsSend({ type: 'PING' });
		}
	}, WS_PING_MS);
}

function scheduleWsReconnect() {
	if (useOffscreenWs) return;
	clearTimeout(reconnectTimer);
	const delay = hasLiveClients() ? 400 : reconnectDelay;
	reconnectTimer = setTimeout(() => {
		connectWsLegacy();
		if (!hasLiveClients()) {
			reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), RECONNECT_MAX_MS);
		}
	}, delay);
}

function connectWsLegacy() {
	if (useOffscreenWs) return;
	if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
	if (ws?.readyState === WebSocket.CLOSING) return;

	ws = new WebSocket(WS_URL);

	ws.onopen = () => {
		reconnectDelay = RECONNECT_BASE_MS;
		setConnected(true);
		startWsPing();
	};

	ws.onmessage = (event) => {
		try {
			handleWsMessage(JSON.parse(event.data));
		} catch (e) {
			console.error('[Veloce] Bad WS message', e);
		}
	};

	ws.onclose = () => {
		ws = null;
		stopWsPing();
		setConnected(false);
		scheduleWsReconnect();
	};

	ws.onerror = () => ws?.close();
}

async function connectCoordinator() {
	if (coordinatorConnectInFlight) return coordinatorConnectInFlight;
	coordinatorConnectInFlight = (async () => {
		const offscreen = await ensureOffscreenDocument();
		if (offscreen) {
			startOffscreenHealthCheck();
			try {
				const status = await chrome.runtime.sendMessage({ type: 'VELOCE_WS_STATUS' });
				if (!status?.ready) {
					await chrome.runtime.sendMessage({ type: 'VELOCE_WS_ENSURE' });
				}
			} catch { /* offscreen still starting */ }
			return;
		}
		connectWsLegacy();
	})().finally(() => {
		coordinatorConnectInFlight = null;
	});
	return coordinatorConnectInFlight;
}

function connectWs() {
	void connectCoordinator();
}

function ensureConnected(maxWaitMs = 3000) {
	return new Promise((resolve) => {
		void connectCoordinator().then(async () => {
			if (await isCoordinatorLinkedAsync()) {
				resolve(true);
				return;
			}
			const start = Date.now();
			const poll = async () => {
				if (await isCoordinatorLinkedAsync()) resolve(true);
				else if (Date.now() - start >= maxWaitMs) resolve(false);
				else setTimeout(poll, 80);
			};
			poll();
		});
	});
}

async function wsSendAsync(obj) {
	if (useOffscreenWs) {
		try {
			const r = await chrome.runtime.sendMessage({ type: 'VELOCE_WS_SEND', payload: obj });
			if (!r?.ok) {
				interceptLog('wsSend failed — socket not ready', { type: obj.type, ready: r?.ready });
				if (!r?.ready) setConnected(false);
				void connectCoordinator();
				return false;
			}
			return true;
		} catch (e) {
			interceptLog('wsSend error', { type: obj.type, error: e?.message || String(e) });
			setConnected(false);
			void connectCoordinator();
			return false;
		}
	}
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(obj));
		return true;
	}
	return false;
}

/** @deprecated use wsSendAsync */
function wsSend(obj) {
	if (useOffscreenWs) {
		if (!connected) return false;
		try {
			chrome.runtime.sendMessage({ type: 'VELOCE_WS_SEND', payload: obj });
			return true;
		} catch {
			return false;
		}
	}
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(obj));
		return true;
	}
	return false;
}

/** Attach tab page URL as referer — required for signed CDN links (403 without it). */
async function enrichDownloadPayload(payload, tabId) {
	const out = { ...payload };
	let pageUrl = out.pageUrl || out.referer;

	if (!pageUrl && tabId != null && tabId >= 0) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab?.url && /^https?:/i.test(tab.url)) {
				pageUrl = tab.url.split('#')[0];
			}
		} catch { /* ignore */ }
	}
	if (!pageUrl) {
		try {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab?.url && /^https?:/i.test(tab.url)) {
				pageUrl = tab.url.split('#')[0];
			}
		} catch { /* ignore */ }
	}

	if (pageUrl) {
		out.pageUrl = pageUrl;
		out.referer = out.referer || pageUrl;
	}

	// Prefer in-memory directory from SETTINGS / DIRECTORY_SELECTED — avoids a
	// chrome.storage round-trip on every badge click before NEW_DOWNLOAD.
	if (!out.baseDirectory) {
		out.baseDirectory = selectedDirectory
			|| settings?.baseDirectory
			|| settings?.base_dir
			|| undefined;
	}
	if (!out.threads && settings?.defaultThreads) {
		out.threads = settings.defaultThreads;
	}

	if (out.directUrl && BROWSER_ONLY_URL.test(out.directUrl)) {
		delete out.directUrl;
	}
	if (out.url && BROWSER_ONLY_URL.test(out.url) && out.pageUrl) {
		out.url = out.pageUrl;
	}

	const mediaUrl = out.directUrl || out.url;
	if (!out.playlist && mediaUrl && out.url === mediaUrl && out.pageUrl) {
		out.url = out.pageUrl;
	}
	// Do not promote page URLs (Instagram/YouTube watch) into directUrl — that
	// sends HTML to core_engine and fails size discovery.
	const looksLikePage =
		!!mediaUrl &&
		/(?:youtube\.com\/watch|youtu\.be\/|instagram\.com\/(?:p|reel|reels|tv|stories)\/)/i.test(
			mediaUrl
		);
	if (!out.playlist && out.directUrl == null && mediaUrl && out.url !== mediaUrl && !looksLikePage) {
		out.directUrl = mediaUrl;
	}

	return out;
}

async function startDownload(payload, tabId) {
	interceptLog('step 6: queue download requested', {
		fileName: payload?.fileName,
		url: payload?.url,
		directUrl: payload?.directUrl
	});
	const enriched = await enrichDownloadPayload(payload, tabId);
	let linked = await ensureConnected(6000);
	if (!linked) {
		interceptLog('step 6b: FAILED — coordinator offline (run: cd backend && pnpm dev)');
		console.error('[Veloce] Cannot download — coordinator offline. Start backend: cd backend && pnpm dev');
		notify('veloce-offline', 'Veloce offline', 'Start the backend: cd backend && pnpm dev');
		return false;
	}
	let sent = await wsSendAsync({ type: 'NEW_DOWNLOAD', payload: enriched });
	if (!sent) {
		interceptLog('step 6c: retrying WS connection…');
		linked = await ensureConnected(4000);
		sent = linked && await wsSendAsync({ type: 'NEW_DOWNLOAD', payload: enriched });
	}
	if (!sent) {
		interceptLog('step 6b: FAILED — could not reach coordinator WebSocket');
		console.error('[Veloce] WS send failed — reload extension and ensure pnpm dev is running on port 14921');
		notify('veloce-ws-fail', 'Veloce connection failed', 'Reload the extension and check backend on port 14921');
		return false;
	}
	interceptLog('step 7: sent to coordinator OK', { url: enriched.url, directUrl: enriched.directUrl, fileName: enriched.fileName });
	return true;
}

async function requestFormatsFromCoordinator(url, sendResponse, prefetch = false, force = false) {
	const key = normalizeFormatUrl(url);
	traceFormats('coordinator request start', { url: key, prefetch, force });
	const ok = await ensureConnected(2500);
	if (!ok) {
		traceFormats('coordinator OFFLINE', { url: key });
		sendResponse({ type: 'FORMATS_ERROR', error: 'Local Coordinator offline' });
		return;
	}

	const requestId = crypto.randomUUID();
	inflightFormatUrls.add(key);
	pendingFormatRequests.set(requestId, { sendResponse, url: key, prefetch });
	traceFormats('WS LIST_FORMATS send', { requestId, url: key, force, prefetch });
	const sent = await wsSendAsync({
		type: 'LIST_FORMATS',
		requestId,
		payload: { url: key, force: force === true }
	});
	if (!sent) {
		traceFormats('WS send FAILED', { requestId, url: key });
		inflightFormatUrls.delete(key);
		pendingFormatRequests.delete(requestId);
		sendResponse({ type: 'FORMATS_ERROR', error: 'Local Coordinator offline' });
		return;
	}
	setTimeout(() => {
		if (pendingFormatRequests.has(requestId)) {
			traceFormats('WS TIMEOUT (22s)', { requestId, url: key, prefetch });
			inflightFormatUrls.delete(key);
			pendingFormatRequests.delete(requestId);
			sendResponse({ type: 'FORMATS_ERROR', error: 'Format list timed out' });
		}
	}, 22000);
}

async function listFormats(url, sendResponse, sender, force = false) {
	const key = normalizeFormatUrl(url);
	traceFormats('listFormats start', {
		url: key,
		force,
		tabId: sender?.tab?.id,
		failCached: isFormatFailed(key)
	});
	if (force) clearFormatFail(key);

	let cached = getFormatCache(key);
	// Badge click (force): do not wait on a stuck prefetch — start a fresh coordinator request.
	if (!force && !cached?.length) {
		traceFormats('waiting inflight prefetch', { url: key });
		cached = await waitForInflightFormats(key);
	}
	if (cached?.length) {
		traceFormats('cache HIT', { url: key, count: cached.length });
		sendResponse({ type: 'FORMATS_LIST', formats: cached, cached: true });
		return;
	}

	// User click — jump the queue; never block on a prefetch-only fail.
	if (!force) {
		traceFormats('enqueue prefetch (non-force path)', { url: key });
		enqueuePrefetch(key, true);
		await waitForInflightFormats(key);
		cached = getFormatCache(key);
		if (cached?.length) {
			traceFormats('prefetch cache HIT after wait', { url: key, count: cached.length });
			sendResponse({ type: 'FORMATS_LIST', formats: cached, cached: true });
			return;
		}
	}

	traceFormats('delegating to coordinator', { url: key, force });
	await requestFormatsFromCoordinator(key, sendResponse, false, force);
}

function scheduleKeepaliveAlarm() {
	chrome.alarms.create('veloce-keepalive', { periodInMinutes: 1 });
}

function interceptLog(step, detail) {
	// Debug logging moved to Rust backend
}

function traceFormats(step, detail) {
	// Debug logging moved to Rust backend
}

const BROWSER_ONLY_URL = /^(blob:|data:|mediastream:)/i;

const INTERCEPT_MEDIA_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|iso)(\?|#|$)/i;

/** True when the browser started a download of an actual file, not a redirect/API hop. */
function isInterceptableMediaUrl(url) {
	try {
		const u = new URL(url);
		if (!/^https?:$/i.test(u.protocol)) return false;
		return INTERCEPT_MEDIA_EXT.test(u.pathname);
	} catch {
		return false;
	}
}

/** App-store redirects, API endpoints, etc. — not the video the user wanted. */
function isInterceptTrapUrl(url) {
	try {
		const u = new URL(url);
		const path = u.pathname.toLowerCase();
		if (/\/redirect|\/pkg\/|\/api\/|\/graphql|\/download\?/i.test(path)) return true;
		if (/redirect|download/i.test(u.searchParams.get('a') || '')) return true;
		if (isInterceptableMediaUrl(url)) return false;
		return !INTERCEPT_MEDIA_EXT.test(u.pathname);
	} catch {
		return false;
	}
}

/** Pick the URL we ask the coordinator to list formats for. */
function resolveInterceptListUrl(pageUrl, interceptUrl) {
	if (interceptUrl && isInterceptableMediaUrl(interceptUrl) && !isInterceptTrapUrl(interceptUrl)) {
		return interceptUrl;
	}
	if (pageUrl && /^https?:/i.test(pageUrl)) return pageUrl;
	return interceptUrl || pageUrl || '';
}

async function resolveInterceptTabId(tabId) {
	if (tabId != null && tabId >= 0) return tabId;
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (tab?.id != null && tab.id >= 0) return tab.id;
	} catch { /* ignore */ }
	return tabId;
}

function formatsFromInterceptUrl(url, fileName) {
	if (!url || !/^https?:/i.test(url)) return null;
	let name = fileName || 'download';
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot) : '.mp4';
	const label = dot > 0 ? name.slice(0, dot).replace(/_/g, ' ') : name;
	return [{ id: 'intercept', label, url, ext }];
}

async function openInterceptFormatMenu(tabId, payload) {
	const resolvedTabId = await resolveInterceptTabId(tabId);
	if (resolvedTabId == null || resolvedTabId < 0) {
		interceptLog('step C2: FAILED — no tab id for format menu', payload);
		return false;
	}
	try {
		const preloadedFormats = payload.preloadedFormats ||
			formatsFromInterceptUrl(payload.interceptUrl || payload.url, payload.fileName);
		await chrome.tabs.sendMessage(resolvedTabId, {
			type: 'VELOCE_INTERCEPT_OPEN_MENU',
			...payload,
			preloadedFormats: preloadedFormats || undefined
		});
		interceptLog('step C1: format menu opened in tab', { tabId: resolvedTabId, listUrl: payload.listUrl });
		return true;
	} catch (e) {
		interceptLog('step C2: format menu message failed — refresh the page', {
			tabId: resolvedTabId,
			error: e?.message || String(e),
			listUrl: payload.listUrl
		});
		notify(
			`veloce-intercept-err-${Date.now()}`,
			'Veloce intercept',
			'Could not open format picker on this tab. Refresh the page and try again.'
		);
		return false;
	}
}

function extFromMime(mime) {
	const m = (mime || '').toLowerCase().split(';')[0].trim();
	const map = {
		'image/png': '.png',
		'image/jpeg': '.jpg',
		'image/jpg': '.jpg',
		'image/webp': '.webp',
		'image/gif': '.gif',
		'image/svg+xml': '.svg',
		'application/pdf': '.pdf'
	};
	return map[m] || '.bin';
}

/** Parse a data: URL in the service worker (no tab required). */
function parseDataUrl(url) {
	try {
		const m = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
		if (!m) return null;
		const mime = m[1] || 'application/octet-stream';
		const payload = m[3];
		const base64 = m[2] ? payload.replace(/\s/g, '') : btoa(decodeURIComponent(payload));
		return { base64, mime, size: Math.ceil(base64.length * 0.75) };
	} catch {
		return null;
	}
}

/** Fetch blob bytes from the page context (MAIN world can read page blob URLs). */
async function materializeBlobUrl(tabId, blobUrl) {
	const resolvedTabId = await resolveInterceptTabId(tabId);
	if (resolvedTabId == null || resolvedTabId < 0) return null;

	const fetchInPage = async (u) => {
		const res = await fetch(u);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const buf = await blob.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		const chunk = 8192;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return {
			base64: btoa(binary),
			mime: blob.type || 'application/octet-stream',
			size: bytes.length
		};
	};

	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId: resolvedTabId },
			world: 'MAIN',
			func: fetchInPage,
			args: [blobUrl]
		});
		if (results?.[0]?.result?.base64) return results[0].result;
	} catch (e) {
		console.warn('[Veloce] MAIN-world blob fetch failed, trying content script', e);
	}

	return new Promise((resolve) => {
		chrome.tabs.sendMessage(resolvedTabId, { type: 'VELOCE_FETCH_BLOB', url: blobUrl }, (resp) => {
			if (chrome.runtime.lastError || !resp?.ok) resolve(null);
			else resolve(resp);
		});
	});
}

async function startBlobDownload({ base64, mime, fileName, baseDirectory, sourceUrl, pageUrl }) {
	const ok = await ensureConnected();
	if (!ok) {
		console.error('[Veloce] Cannot save blob — coordinator offline');
		return false;
	}
	let name = fileName || 'download';
	if (!/\.\w{2,5}$/.test(name) && mime) {
		name = name.replace(/\.\w+$/, '') + extFromMime(mime);
	}
	return wsSendAsync({
		type: 'SAVE_BLOB',
		payload: {
			base64,
			mime,
			fileName: name,
			baseDirectory,
			sourceUrl: sourceUrl || pageUrl || 'blob:browser',
			pageUrl
		}
	});
}

// ── Intercept native browser downloads when coordinator is online ─────────────
chrome.downloads.onCreated.addListener(async (item) => {
	const url = item.url || item.finalUrl;
	interceptLog('step A: chrome.downloads.onCreated', {
		url,
		id: item.id,
		tabId: item.tabId,
		fileName: item.filename,
		referrer: item.referrer
	});

	if (!connected) {
		interceptLog('step A1: waiting for coordinator connection…');
		await ensureConnected(2000);
	}
	if (!connected) {
		interceptLog('step A2: SKIP — coordinator offline (start backend: pnpm dev)');
		return;
	}

	const { veloce_intercept } = await chrome.storage.local.get('veloce_intercept');
	if (veloce_intercept === false) {
		interceptLog('step A2: SKIP — intercept disabled in popup');
		return;
	}

	if (!url) {
		interceptLog('step A2: SKIP — empty url');
		return;
	}

	const { veloce_base_dir } = await chrome.storage.local.get('veloce_base_dir');
	const baseDirectory = veloce_base_dir || selectedDirectory || undefined;
	let pageUrl = item.referrer || undefined;
	if (!pageUrl && item.tabId >= 0) {
		try {
			const tab = await chrome.tabs.get(item.tabId);
			if (tab?.url && /^https?:/i.test(tab.url)) {
				pageUrl = tab.url.split('#')[0];
			}
		} catch { /* ignore */ }
	}
	if (!pageUrl) {
		try {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab?.url && /^https?:/i.test(tab.url)) {
				pageUrl = tab.url.split('#')[0];
			}
		} catch { /* ignore */ }
	}

	let fileName = item.filename || '';
	if (!fileName) {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			fileName = parts.pop() || 'download';
		} catch {
			fileName = 'download';
		}
	}

	if (BROWSER_ONLY_URL.test(url)) {
		interceptLog('blob/data url — materializing in browser', { url: url.slice(0, 80) });
		let materialized = null;
		if (url.startsWith('data:')) {
			materialized = parseDataUrl(url);
		} else if (url.startsWith('blob:')) {
			materialized = await materializeBlobUrl(item.tabId, url);
		}
		if (!materialized?.base64) {
			interceptLog('blob read failed — leaving native download alone');
			return;
		}
		try {
			await chrome.downloads.cancel(item.id);
			interceptLog('cancelled native download', { id: item.id });
		} catch (e) {
			interceptLog('cancel failed', e?.message);
		}
		await startBlobDownload({
			base64: materialized.base64,
			mime: materialized.mime,
			fileName,
			baseDirectory,
			sourceUrl: url,
			pageUrl
		});
		interceptLog('blob queued to coordinator', { fileName, bytes: materialized.size });
		return;
	}

	const listUrl = resolveInterceptListUrl(pageUrl, url);
	interceptLog('step C: routing to format menu in tab', {
		listUrl,
		interceptUrl: url,
		pageUrl,
		fileName,
		tabId: item.tabId,
		directFile: isInterceptableMediaUrl(url),
		trapUrl: isInterceptTrapUrl(url)
	});

	// Open the Veloce menu FIRST. Only cancel the native download once we know the
	// menu is up — otherwise a tab with no content script (just opened, or orphaned
	// by an extension reload) loses the download entirely with nothing to replace it.
	const opened = await openInterceptFormatMenu(item.tabId, {
		pageUrl: pageUrl || url,
		interceptUrl: url,
		listUrl,
		fileName
	});
	if (!opened) {
		interceptLog('step D: FAILED to open format menu — leaving native download running', { tabId: item.tabId });
		return;
	}

	try {
		await chrome.downloads.cancel(item.id);
		interceptLog('step B: cancelled native browser download (menu is up)', { id: item.id });
	} catch (e) {
		interceptLog('step B: cancel failed', e?.message);
	}
	interceptLog('step D: format menu message sent', { tabId: item.tabId });
});

// Relay from the persistent offscreen WebSocket holder.
chrome.runtime.onMessage.addListener((msg, sender) => {
	if (!msg?.type?.startsWith('VELOCE_WS_')) return;
	if (!sender?.url?.includes('offscreen.html')) return;
	handleOffscreenWsRelay(msg);
});

// ── Messages from popup & content scripts ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	switch (msg.type) {
		case 'VELOCE_CONNECT':
			(async () => {
				await ensureConnected();
				sendResponse({ connected, downloads, selectedDirectory, settings });
			})();
			return true;

		case 'VELOCE_GET_STATE':
			(async () => {
				await ensureConnected(3000);
				const really = await isCoordinatorLinkedAsync();
				if (connected && !really) setConnected(false);
				else if (!connected && really) setConnected(true);
				sendResponse({ connected: really, downloads, selectedDirectory, settings });
			})();
			return true;

		case 'VELOCE_INTERCEPT_LOG':
			interceptLog(`content: ${msg.step || 'event'}`, msg.detail);
			sendResponse({ ok: true });
			return false;

		case 'VELOCE_SET_SETTINGS':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'SET_SETTINGS', payload: msg.payload }) });
			})();
			return true;

		case 'VELOCE_GET_SETTINGS':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'GET_SETTINGS' }) });
			})();
			return true;

		case 'VELOCE_NEW_DOWNLOAD':
			(async () => {
				sendResponse({ ok: await startDownload(msg.payload, _sender.tab?.id) });
			})();
			return true;

		case 'VELOCE_LIST_FORMATS':
			listFormats(msg.url, sendResponse, _sender, msg.force === true);
			return true;

		case 'VELOCE_PEEK_FORMATS': {
			const key = normalizeFormatUrl(msg.url);
			const cached = getFormatCache(key);
			traceFormats('peek', { url: key, hit: !!cached?.length, count: cached?.length ?? 0 });
			sendResponse(cached?.length ? { formats: cached, cached: true } : { formats: [] });
			return false;
		}

		case 'VELOCE_PREFETCH_FORMATS':
			if (!isForegroundTab(_sender.tab?.id)) return false;
			prefetchFormats(msg.url);
			return false;

		case 'VELOCE_PREFETCH_BATCH':
			if (!isForegroundTab(_sender.tab?.id)) return false;
			prefetchBatch(msg.urls);
			return false;

		case 'VELOCE_PREFETCH_FOCUS': {
			if (!isForegroundTab(_sender.tab?.id)) return false;
			const keep = new Set(
				(Array.isArray(msg.keep) ? msg.keep : [])
					.map((u) => normalizeFormatUrl(u))
					.filter(Boolean)
			);
			for (let i = prefetchQueue.length - 1; i >= 0; i--) {
				const key = prefetchQueue[i];
				if (!keep.has(key)) {
					prefetchQueue.splice(i, 1);
					prefetchQueued.delete(key);
				}
			}
			drainPrefetchQueue();
			return false;
		}

		case 'VELOCE_AM_I_FOREGROUND':
			(async () => {
				if (foregroundTabId == null) await refreshForegroundTab();
				sendResponse({ active: isForegroundTab(_sender.tab?.id) });
			})();
			return true;

		case 'VELOCE_WARMUP':
			connectWs();
			return false;

		case 'VELOCE_CONTROL':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: msg.action, downloadId: msg.downloadId }) });
			})();
			return true;

		case 'VELOCE_DIRECTORY_PICKER':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'REQUEST_DIRECTORY_PICKER' }) });
			})();
			return true;

		default:
			return false;
	}
});

function setupContextMenus() {
	if (!chrome.contextMenus) return;
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'veloce-download-link',
			title: 'Download link with Veloce',
			contexts: ['link']
		});
		chrome.contextMenus.create({
			id: 'veloce-download-media',
			title: 'Download media with Veloce',
			contexts: ['image', 'video', 'audio']
		});
		chrome.contextMenus.create({
			id: 'veloce-download-page-links',
			title: 'Download all media links on page',
			contexts: ['page']
		});
	});
}

const VIDEO_HOST = /youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vimeo\.com|facebook\.com|twitch\.tv|mediafire\.com/i;

function needsFormatPicker(url) {
	if (!url || !/^https?:/i.test(url)) return false;
	try {
		const u = new URL(url);
		if (/mediafire\.com/i.test(u.hostname) && /\/file\//i.test(u.pathname)) return true;
		if (!VIDEO_HOST.test(u.hostname)) return false;
		if (INTERCEPT_MEDIA_EXT.test(u.pathname)) return false;
		if (/googlevideo\.com/i.test(u.hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

function isManifestMediaUrl(url) {
	if (!url || !/^https?:/i.test(url)) return false;
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (host === 'manifest.googlevideo.com' || host.endsWith('.manifest.googlevideo.com')) {
			return true;
		}
	} catch { /* ignore */ }
	const u = url.toLowerCase();
	return (
		u.includes('.m3u8') ||
		u.includes('.mpd') ||
		u.includes('/manifest/') ||
		u.includes('playlist_type') ||
		/\bformat=m3u8/i.test(u)
	);
}

function shouldUseDirectUrl(url) {
	if (!url || !/^https?:/i.test(url)) return false;
	if (isManifestMediaUrl(url)) return false;
	if (needsFormatPicker(url)) return false;
	try {
		const u = new URL(url);
		return INTERCEPT_MEDIA_EXT.test(u.pathname) || isInterceptableMediaUrl(url);
	} catch {
		return false;
	}
}

/** Fallback when the content script is not reachable (e.g. tab just opened). */
async function resolveContextMediaInTab(tabId, srcUrl, mediaType) {
	try {
		const resp = await chrome.tabs.sendMessage(tabId, {
			type: 'VELOCE_RESOLVE_CONTEXT_MEDIA',
			srcUrl,
			mediaType
		});
		if (resp?.ok) return resp;
	} catch { /* content script unavailable */ }

	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			func: (src, type) => {
				const pageUrl = location.href.split('#')[0];
				const host = location.hostname.toLowerCase();
				if (/^(blob:|data:|mediastream:)/i.test(src || '')) {
					if (host.includes('youtube.com') || host === 'youtu.be') {
						try {
							const u = new URL(location.href);
							if (u.pathname === '/watch' && u.searchParams.get('v')) {
								const url = `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
								return { ok: true, url, pageUrl, needsFormatMenu: true };
							}
							const shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/);
							if (shorts) {
								const url = `https://www.youtube.com/shorts/${shorts[1]}`;
								return { ok: true, url, pageUrl, needsFormatMenu: true };
							}
						} catch { /* ignore */ }
					}
					if (host.includes('instagram.com') && /\/(p|reel|tv)\//i.test(location.pathname)) {
						const url = pageUrl.split('?')[0].replace(/\/reels\//i, '/reel/');
						return { ok: true, url, pageUrl, needsFormatMenu: true };
					}
					return { ok: false };
				}
				if (/^https?:/i.test(src || '')) {
					return { ok: true, url: src, pageUrl, needsFormatMenu: false, directUrl: src };
				}
				if (type === 'video' && host.includes('youtube.com')) {
					try {
						const u = new URL(location.href);
						if (u.pathname === '/watch' && u.searchParams.get('v')) {
							const url = `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
							return { ok: true, url, pageUrl, needsFormatMenu: true };
						}
					} catch { /* ignore */ }
				}
				return { ok: false };
			},
			args: [srcUrl, mediaType]
		});
		return results?.[0]?.result || null;
	} catch {
		return null;
	}
}

async function downloadFromContext(url, tabId, opts = {}) {
	if (!url && !opts.mediaType) return;

	const { veloce_base_dir } = await chrome.storage.local.get('veloce_base_dir');
	const baseDirectory = veloce_base_dir || selectedDirectory || undefined;
	let resolvedUrl = url;
	let directUrl;
	let pageUrl = opts.pageUrl;

	if (BROWSER_ONLY_URL.test(url || '') && tabId != null) {
		const resolved = await resolveContextMediaInTab(tabId, url, opts.mediaType);
		if (resolved?.needsFormatMenu && resolved.url) {
			await openInterceptFormatMenu(tabId, {
				listUrl: resolved.url,
				pageUrl: resolved.pageUrl || opts.pageUrl,
				fileName: 'download'
			});
			return;
		}
		if (resolved?.url) {
			resolvedUrl = resolved.url;
			directUrl = resolved.directUrl;
			pageUrl = resolved.pageUrl || pageUrl;
		} else {
			const blob = await materializeBlobUrl(tabId, url);
			if (blob) {
				await startBlobDownload({
					...blob,
					fileName: 'download',
					baseDirectory,
					sourceUrl: url,
					pageUrl: pageUrl || opts.pageUrl
				});
				return;
			}
			notify(
				`veloce-context-blob-${Date.now()}`,
				'Veloce',
				'Could not resolve this media — use the Veloce badge on the page instead.'
			);
			return;
		}
	}

	if (resolvedUrl && needsFormatPicker(resolvedUrl)) {
		await openInterceptFormatMenu(tabId, {
			listUrl: resolvedUrl,
			pageUrl: pageUrl || resolvedUrl,
			fileName: 'download'
		});
		return;
	}

	if (BROWSER_ONLY_URL.test(resolvedUrl || '')) {
		notify(
			`veloce-context-proto-${Date.now()}`,
			'Veloce',
			'Browser-only media URL — use the Veloce badge on the page instead.'
		);
		return;
	}

	let fileName = 'download';
	try {
		const parts = new URL(directUrl || resolvedUrl).pathname.split('/').filter(Boolean);
		fileName = decodeURIComponent(parts.pop() || 'download');
	} catch { /* keep default */ }

	const payload = {
		url: resolvedUrl,
		fileName,
		baseDirectory,
		threads: 8,
		pageUrl
	};
	if (directUrl && shouldUseDirectUrl(directUrl)) {
		payload.directUrl = directUrl;
	} else if (shouldUseDirectUrl(resolvedUrl)) {
		payload.directUrl = resolvedUrl;
	}

	await startDownload(payload, tabId);
}

if (chrome.contextMenus) {
	chrome.contextMenus.onClicked.addListener(async (info, tab) => {
		if (info.menuItemId === 'veloce-download-link') {
			await downloadFromContext(info.linkUrl, tab?.id, { pageUrl: info.pageUrl });
		} else if (info.menuItemId === 'veloce-download-media') {
			await downloadFromContext(info.srcUrl || info.linkUrl, tab?.id, {
				mediaType: info.mediaType,
				pageUrl: info.pageUrl
			});
		} else if (info.menuItemId === 'veloce-download-page-links' && tab?.id != null) {
			try {
				const results = await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					func: () => {
						const re = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|iso)(\?|#|$)/i;
						return Array.from(document.querySelectorAll('a[href]'))
							.map((a) => a.href)
							.filter((h) => /^https?:/i.test(h) && re.test(h));
					}
				});
				const urls = [...new Set((results?.[0]?.result) || [])];
				for (const u of urls) await downloadFromContext(u, tab?.id);
				notify(`veloce-pagelinks-${Date.now()}`, 'Veloce', `Queued ${urls.length} link(s) from the page.`);
			} catch (e) {
				console.warn('[Veloce] page-links scan failed', e);
			}
		}
	});
}

chrome.runtime.onInstalled.addListener((details) => {
	chrome.storage.local.set({ veloce_intercept: true });
	scheduleKeepaliveAlarm();
	setupContextMenus();
	void connectCoordinator();
	if (details.reason === 'update' || details.reason === 'install') {
		void reinjectContentOnActiveTab();
	}
});

chrome.runtime.onStartup.addListener(() => {
	void connectCoordinator();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'veloce-keepalive' && !connected) void connectCoordinator();
});

chrome.runtime.onConnect.addListener((port) => {
	if (!['veloce-popup', 'veloce-busy', 'veloce-tab'].includes(port.name)) return;

	livePorts.add(port);
	if (!connected) connectWs();
	// Prefetch only when the connecting tab is the foreground tab.
	if (port.name === 'veloce-tab' && isForegroundTab(port.sender?.tab?.id)) {
		drainPrefetchQueue();
	}

	port.onMessage.addListener((msg) => {
		if (msg?.type === 'ping') {
			try { port.postMessage({ type: 'pong', connected }); } catch { /* ignore */ }
		}
	});

	// Tell this tab whether it is the foreground capture target.
	if (port.name === 'veloce-tab' && port.sender?.tab?.id != null) {
		const tabId = port.sender.tab.id;
		void (async () => {
			if (foregroundTabId == null) await refreshForegroundTab();
			try {
				port.postMessage({
					type: 'VELOCE_FOREGROUND_STATE',
					active: isForegroundTab(tabId)
				});
			} catch { /* ignore */ }
		})();
	}

	port.onDisconnect.addListener(() => {
		livePorts.delete(port);
	});
});

chrome.tabs.onRemoved.addListener(() => {
	// tab closed — foreground refresh handles prefetch gating
});

chrome.tabs.onActivated.addListener(() => { void refreshForegroundTab(); });
chrome.windows.onFocusChanged.addListener((windowId) => {
	if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshForegroundTab();
});
void refreshForegroundTab();

scheduleKeepaliveAlarm();
void connectCoordinator();
