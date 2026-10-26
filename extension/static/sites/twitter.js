// X / Twitter — timeline cards and single-tweet permalink pages; blob→status URL resolution.
(function () {
	const HOST_RE = /twitter\.com|x\.com/i;
	const STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

	function createTwitterSite(ctx) {
		function isHost() {
			return HOST_RE.test(location.hostname);
		}

		function canonicalStatusUrl(href) {
			try {
				const u = new URL(href, location.origin);
				if (!HOST_RE.test(u.hostname)) return null;
				const m = u.pathname.match(STATUS_RE);
				if (!m) return null;
				return `${u.origin}/${m[1]}/status/${m[2]}`;
			} catch {
				return null;
			}
		}

		function isStatusPage() {
			return isHost() && !!canonicalStatusUrl(location.href);
		}

		function findTweetArticle(el) {
			return el?.closest?.('[data-testid="tweet"], article[role="article"], article') || null;
		}

		/** Prefer the tweet's own timestamp link — quote-tweets nest a second status link. */
		function bestStatusLinkIn(root) {
			if (!root?.querySelectorAll) return null;
			let best = null;
			let bestScore = -1;
			for (const a of root.querySelectorAll('a[href*="/status/"]')) {
				const url = canonicalStatusUrl(a.getAttribute('href') || a.href);
				if (!url) continue;
				const score = a.querySelector('time') ? 10 : 1;
				if (score > bestScore) {
					bestScore = score;
					best = url;
				}
			}
			return best;
		}

		function findStatusUrl(el) {
			const article = findTweetArticle(el);
			const inArticle = article && bestStatusLinkIn(article);
			if (inArticle) return inArticle;
			let node = el;
			for (let i = 0; i < 20 && node; i++) {
				if (node.matches?.('a[href*="/status/"]')) {
					const url = canonicalStatusUrl(node.getAttribute('href') || node.href);
					if (url) return url;
				}
				node = node.parentElement;
			}
			return null;
		}

		function resolveDownloadUrl(raw, anchor) {
			if (!isHost() || !ctx.isBrowserOnlyUrl(raw)) return null;
			const url = anchor && findStatusUrl(anchor);
			if (url) return url;
			return isStatusPage() ? canonicalStatusUrl(location.href) : null;
		}

		return {
			id: 'twitter',
			isHost,
			canonicalStatusUrl,
			resolveDownloadUrl
		};
	}

	window.__veloceRegisterSite('twitter', createTwitterSite);
})();
