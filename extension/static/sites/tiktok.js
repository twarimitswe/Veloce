// TikTok — feed cards (For You/profile), video permalink pages, feed-scroll prefetch.
// Badge anchor is resolved structurally (nearest ancestor holding the video's own
// permalink <a href="/@user/video/ID">), not by hit-testing a point in the card —
// TikTok's own overlay UI (like/comment/share rail, captions) blocks the center
// of the card, which breaks point hit-testing. See AGENTS.md "IG/TikTok overlays
// block center".
(function () {
	const VIDEO_URL_RE = /\/@([^/]+)\/video\/(\d+)/;
	const FEED_CARD =
		'[data-e2e="recommend-list-item-container"], [data-e2e="explore-item"], ' +
		'[data-e2e="user-post-item"], [data-e2e="search_video-item"], ' +
		'div[class*="DivItemContainer"], article';

	function createTiktokSite(ctx) {
		const {
			captureActive,
			placeBadge,
			removeBadge,
			shouldAttemptBadge,
			badges,
			badgeKeys,
			normalizeBadgeKey,
			SCANNED_ATTR,
			CARD_WATCH_ATTR,
			BADGE_MARGIN_PX,
			isNearViewport,
			shouldStartPrefetch: coreShouldStartPrefetch,
			closeMenu,
			resetScanStateDeep,
			cardIo,
			watchElement,
			cardViewportScore,
			eagerPrefetch,
			setPrefetchFocus
		} = ctx;

		let scrollScanTimer = null;

		function isHost() {
			return /tiktok\.com/i.test(location.hostname);
		}

		function canonicalUrl(href = location.href) {
			try {
				const u = new URL(href, location.origin);
				const m = u.pathname.match(VIDEO_URL_RE);
				if (m) return `https://www.tiktok.com/@${m[1]}/video/${m[2]}`;
			} catch { /* ignore */ }
			return null;
		}

		function normalizeKey(url) {
			return canonicalUrl(url);
		}

		function isVideoPermalinkPage() {
			return !!canonicalUrl(location.href);
		}

		// Structural fallback when no FEED_CARD selector matches (markup drift):
		// walk ancestors until a subtree contains exactly one video-permalink anchor.
		function findCardByAnchorWalk(el) {
			let node = el?.parentElement;
			for (let i = 0; i < 10 && node; i++) {
				const anchors = node.querySelectorAll?.('a[href*="/video/"]') || [];
				if (anchors.length === 1) return node;
				if (anchors.length > 1) return node;
				node = node.parentElement;
			}
			return null;
		}

		function findFeedCard(el) {
			return el?.closest?.(FEED_CARD) || findCardByAnchorWalk(el);
		}

		function findWatchLinkInCard(card) {
			if (!card) return null;
			const anchors = card.querySelectorAll?.('a[href*="/video/"]') || [];
			for (const a of anchors) {
				const url = canonicalUrl(a.getAttribute('href') || a.href);
				if (url) return { anchor: a, url };
			}
			return null;
		}

		function findVideoUrl(el) {
			const card = findFeedCard(el);
			if (card) {
				const hit = findWatchLinkInCard(card);
				if (hit) return hit.url;
			}
			if (isVideoPermalinkPage()) return canonicalUrl();
			return null;
		}

		function resolveDownloadUrl(raw, anchor) {
			if (!isHost() || !anchor) return null;
			if (ctx.isBrowserOnlyUrl(raw)) return findVideoUrl(anchor);
			return null;
		}

		function findBadgeRoot(anchor) {
			return findFeedCard(anchor) || anchor;
		}

		function shouldBadgeElement(el) {
			return !isHost() || el.tagName === 'VIDEO';
		}

		function shouldStartPrefetch(resolvedUrl, anchor) {
			return isHost() ? true : null;
		}

		function processFeedCard(card) {
			if (!captureActive() || !card) return null;
			const hit = findWatchLinkInCard(card);
			if (!hit) return null;

			const { anchor, url } = hit;
			const urlKey = normalizeBadgeKey(url);
			if (!shouldAttemptBadge?.(urlKey, anchor)) return null;
			if (anchor.getAttribute(SCANNED_ATTR)) {
				if (!badges.has(urlKey)) anchor.removeAttribute(SCANNED_ATTR);
				else return url;
			}

			const video = card.querySelector?.('video') || anchor;
			const startPrefetch = coreShouldStartPrefetch(url, anchor);
			const placed = placeBadge(url, video, url, startPrefetch);
			if (!placed) return null;

			anchor.setAttribute(SCANNED_ATTR, '1');
			return url;
		}

		function processVideoPage() {
			if (!captureActive() || !isVideoPermalinkPage()) return null;
			const url = canonicalUrl();
			const video = document.querySelector('video');
			if (!url || !video) return null;

			const urlKey = normalizeBadgeKey(url);
			if (!shouldAttemptBadge?.(urlKey, video)) return null;
			if (video.getAttribute(SCANNED_ATTR) && badges.has(urlKey)) return url;

			const placed = placeBadge(url, video, url, true);
			if (!placed) return null;
			video.setAttribute(SCANNED_ATTR, '1');
			return url;
		}

		function processMediaElement(el) {
			const card = findFeedCard(el);
			if (card) return processFeedCard(card);
			if (isVideoPermalinkPage()) return processVideoPage();
			return null;
		}

		function queryFeedCards() {
			return Array.from(document.querySelectorAll(FEED_CARD));
		}

		function watchFeedCard(card) {
			if (!captureActive() || !card || card.getAttribute(CARD_WATCH_ATTR)) return;
			card.setAttribute(CARD_WATCH_ATTR, '1');
			cardIo.observe(card);
		}

		function scanFeedCardsVisible() {
			if (!captureActive() || !isHost()) return;
			const cards = queryFeedCards()
				.filter((card) => isNearViewport(card, BADGE_MARGIN_PX))
				.sort((a, b) => cardViewportScore(a) - cardViewportScore(b));
			for (const card of cards) {
				watchFeedCard(card);
				processFeedCard(card);
			}
		}

		function scanFeedCards(watchBudgetRef) {
			for (const card of queryFeedCards()) {
				watchFeedCard(card);
				if (watchBudgetRef.value <= 0) continue;
				if (isNearViewport(card, BADGE_MARGIN_PX)) {
					watchBudgetRef.value--;
					processFeedCard(card);
				}
			}
		}

		function scheduleScrollScan() {
			if (!isHost()) return;
			clearTimeout(scrollScanTimer);
			scrollScanTimer = setTimeout(scanFeedCardsVisible, 120);
		}

		function resetCapture() {
			closeMenu();
			for (const key of [...badgeKeys]) removeBadge(key);
			resetScanStateDeep(document.documentElement);
		}

		function navigationKey() {
			return canonicalUrl() || `${location.pathname}${location.search}`;
		}

		function hookNavigation() {
			if (!isHost() || hookNavigation.done) return;
			hookNavigation.done = true;
			let lastKey = navigationKey();

			const onRoute = () => {
				const key = navigationKey();
				if (key === lastKey) return;
				const prevUrl = canonicalUrl(lastKey) || null;
				lastKey = key;
				resetCapture();
				if (captureActive()) {
					const url = canonicalUrl();
					if (url) {
						setPrefetchFocus?.(url, prevUrl);
						eagerPrefetch(url);
					}
					ctx.invokeScan?.();
				}
			};

			window.addEventListener('popstate', onRoute);
			const push = history.pushState.bind(history);
			const replace = history.replaceState.bind(history);
			history.pushState = (...args) => { push(...args); onRoute(); };
			history.replaceState = (...args) => { replace(...args); onRoute(); };
		}

		function scan(watchBudgetRef) {
			if (!isHost()) return false;
			if (isVideoPermalinkPage()) {
				document.querySelectorAll('video').forEach((v) => watchElement(v));
				processVideoPage();
				const url = canonicalUrl();
				if (url) eagerPrefetch(url);
			}
			scanFeedCards(watchBudgetRef);
			scanFeedCardsVisible();
			return true;
		}

		function scanSubtree() {
			if (!isHost()) return false;
			scanFeedCardsVisible();
			return true;
		}

		function handleMutationNodes(nodes) {
			if (!isHost()) return false;
			for (const node of nodes) {
				if (node.nodeType !== 1) continue;
				if (node.matches?.(FEED_CARD)) watchFeedCard(node);
				if (node.querySelectorAll) {
					for (const card of node.querySelectorAll?.(FEED_CARD) || []) {
						watchFeedCard(card);
					}
				}
			}
			scanFeedCardsVisible();
			return true;
		}

		function getWatchBudget() {
			return isHost() ? 400 : null;
		}

		function getScanDebounceMs() {
			return isHost() ? 200 : null;
		}

		function onSpaNavigation() {
			resetCapture();
		}

		return {
			id: 'tiktok',
			feedCardSelector: FEED_CARD,
			isHost,
			canonicalUrl,
			normalizeKey,
			findFeedCard,
			resolveDownloadUrl,
			findBadgeRoot,
			shouldBadgeElement,
			shouldStartPrefetch,
			processFeedCard,
			processMediaElement,
			watchFeedCard,
			scan,
			scanSubtree,
			handleMutationNodes,
			getWatchBudget,
			getScanDebounceMs,
			scheduleScrollScan,
			resetCapture,
			hookNavigation,
			onSpaNavigation,
			processWatchPage: processVideoPage
		};
	}

	window.__veloceRegisterSite('tiktok', createTiktokSite);
})();
