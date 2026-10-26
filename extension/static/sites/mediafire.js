// MediaFire — file page badge on download UI (Class C: backend scrapes CDN link).
(function () {
	function createMediafireSite(ctx) {
		const {
			captureActive,
			placeBadge,
			removeBadge,
			isDismissedBadge,
			shouldAttemptBadge,
			dismissedBadges,
			badges,
			badgeKeys,
			normalizeBadgeKey,
			SCANNED_ATTR,
			BADGE_MARGIN_PX,
			isNearViewport,
			clipRectToViewport,
			closeMenu,
			resetScanStateDeep,
			watchElement,
			eagerPrefetch,
			invokeScan
		} = ctx;

		let filePagePoll = null;
		let lastBadgeKey = null;

		function isHost() {
			return /mediafire\.com/i.test(location.hostname);
		}

		function isFilePage(href = location.href) {
			try {
				const u = new URL(href, location.origin);
				return /mediafire\.com/i.test(u.hostname) && /^\/file\/[^/]+\/[^/]+/i.test(u.pathname);
			} catch {
				return false;
			}
		}

		function canonicalFilePageUrl(href = location.href) {
			try {
				const u = new URL(href, location.origin);
				if (!/mediafire\.com/i.test(u.hostname)) return null;
				const m = u.pathname.match(/^\/file\/([^/]+)\/([^/]+)/i);
				if (!m) return null;
				const key = m[1];
				const name = decodeURIComponent(m[2]);
				u.search = '';
				u.hash = '';
				u.pathname = `/file/${key}/${encodeURIComponent(name)}/file`;
				return u.href.replace(/\/+$/, '');
			} catch {
				return null;
			}
		}

		function normalizeKey(url) {
			return canonicalFilePageUrl(url);
		}

		function isCdnDownloadUrl(raw) {
			try {
				return /^download\d+\.mediafire\.com$/i.test(new URL(raw).hostname);
			} catch {
				return false;
			}
		}

		function resolveDownloadUrl(raw, anchor) {
			if (!isHost()) return null;
			const page = canonicalFilePageUrl(location.href);
			if (!page) return null;
			if (!raw) return page;
			if (isFilePage(raw) || isCdnDownloadUrl(raw)) return page;
			if (anchor && isFilePage()) return page;
			return null;
		}

		function findDownloadAnchor() {
			const selectors = [
				'#downloadButton',
				'a#downloadButton',
				'#click_download',
				'a.download_link',
				'a.popsok',
				'.download-btn a[href]',
				'#download-btn a[href]',
				'a[aria-label*="Download" i][href]',
				'a[href*="download"][href*="mediafire.com"]',
				'button#download-btn',
				'#download-btn'
			];
			for (const sel of selectors) {
				const el = document.querySelector(sel);
				if (!el?.getBoundingClientRect) continue;
				const r = el.getBoundingClientRect();
				if (r.width >= 48 && r.height >= 24) return el;
			}
			for (const sel of ['.dl-info', '.filename', '.file-name', 'h1.title', 'main h1', 'main']) {
				const el = document.querySelector(sel);
				if (!el?.getBoundingClientRect) continue;
				const r = el.getBoundingClientRect();
				if (r.width >= 120 && r.height >= 40) return el;
			}
			return null;
		}

		function findBadgeRoot(anchor) {
			return anchor?.closest?.('.dl-btn-wrap, .download-section, main, #content, body') || anchor;
		}

		function shouldBadgeElement() {
			return isFilePage() ? true : null;
		}

		function isElementForeground(el) {
			if (!isHost() || !isFilePage()) return null;
			if (!el?.isConnected) return false;
			const r = clipRectToViewport(el.getBoundingClientRect());
			return !!(r && r.width >= 48 && r.height >= 24 && isNearViewport(el, BADGE_MARGIN_PX));
		}

		function shouldWatchLink(a) {
			if (!isHost() || !isFilePage()) return null;
			const href = a?.href || a?.getAttribute?.('href') || '';
			if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
				return a?.id === 'downloadButton' || a?.id === 'click_download';
			}
			if (isFilePage(href) || isCdnDownloadUrl(href)) return true;
			return true;
		}

		function shouldPrefetchUrl(url) {
			if (!isHost()) return null;
			return !!canonicalFilePageUrl(url);
		}

		function processFilePage() {
			if (!captureActive() || !isFilePage()) return null;

			const url = canonicalFilePageUrl();
			if (!url) return null;
			const urlKey = normalizeBadgeKey(url);
			const anchor = findDownloadAnchor();
			if (!anchor) return null;

			if (lastBadgeKey && lastBadgeKey !== urlKey && badges.has(lastBadgeKey)) {
				removeBadge(lastBadgeKey);
			}
			lastBadgeKey = urlKey;

			if (!shouldAttemptBadge?.(urlKey, anchor)) return null;
			if (anchor.getAttribute(SCANNED_ATTR) && badges.has(urlKey)) {
				stopFilePagePoll();
				return url;
			}

			const placed = placeBadge(url, anchor, url, true);
			if (!placed) return null;
			anchor.setAttribute(SCANNED_ATTR, '1');
			stopFilePagePoll();
			return url;
		}

		function scanFilePage() {
			if (!captureActive() || !isFilePage()) return;
			processFilePage();
			for (const a of document.querySelectorAll('a[href]')) {
				if (shouldWatchLink(a)) watchElement(a);
			}
		}

		function startFilePagePoll() {
			if (filePagePoll) return;
			if (!isFilePage()) return;
			const url = canonicalFilePageUrl();
			const anchor = url && findDownloadAnchor();
			if (anchor?.getAttribute(SCANNED_ATTR) && badges.has(normalizeBadgeKey(url))) return;
			filePagePoll = setInterval(() => {
				if (!captureActive() || !isHost()) {
					stopFilePagePoll();
					return;
				}
				if (!isFilePage()) {
					stopFilePagePoll();
					return;
				}
				processFilePage();
			}, 600);
		}

		function stopFilePagePoll() {
			if (filePagePoll) {
				clearInterval(filePagePoll);
				filePagePoll = null;
			}
		}

		function resetCapture() {
			closeMenu();
			stopFilePagePoll();
			lastBadgeKey = null;
			dismissedBadges?.clear?.();
			for (const key of [...badgeKeys]) removeBadge(key);
			resetScanStateDeep(document.documentElement);
		}

		function hookNavigation() {
			if (!isHost() || hookNavigation.done) return;
			hookNavigation.done = true;
			let lastKey = canonicalFilePageUrl() || location.pathname;
			const onRoute = () => {
				const key = canonicalFilePageUrl() || location.pathname;
				if (key === lastKey) return;
				lastKey = key;
				resetCapture();
				if (captureActive()) invokeScan?.();
			};
			window.addEventListener('popstate', onRoute);
			const push = history.pushState.bind(history);
			const replace = history.replaceState.bind(history);
			history.pushState = (...args) => { push(...args); onRoute(); };
			history.replaceState = (...args) => { replace(...args); onRoute(); };
		}

		function scan() {
			if (!isHost()) return false;
			if (!isFilePage()) return false;
			scanFilePage();
			startFilePagePoll();
			const url = canonicalFilePageUrl();
			if (url) eagerPrefetch(url);
			return true;
		}

		function scanSubtree() {
			if (!isHost() || !isFilePage()) return false;
			processFilePage();
			return true;
		}

		function handleMutationNodes(nodes) {
			if (!isHost() || !isFilePage()) return false;
			scanFilePage();
			startFilePagePoll();
			return true;
		}

		function processMediaElement(el) {
			if (!isFilePage()) return null;
			return processFilePage();
		}

		function getScanDebounceMs() {
			return isHost() ? 150 : null;
		}

		return {
			id: 'mediafire',
			isHost,
			isFilePage,
			canonicalFilePageUrl,
			normalizeKey,
			resolveDownloadUrl,
			findBadgeRoot,
			shouldBadgeElement,
			isElementForeground,
			shouldWatchLink,
			shouldPrefetchUrl,
			processFilePage,
			processMediaElement,
			scan,
			scanSubtree,
			handleMutationNodes,
			getScanDebounceMs,
			resetCapture,
			hookNavigation
		};
	}

	window.__veloceRegisterSite('mediafire', createMediafireSite);
})();
