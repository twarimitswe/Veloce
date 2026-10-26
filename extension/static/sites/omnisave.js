// OmniSave / MovieBox / netfilm — download-modal intercept (Class D).
(function () {
	const STORAGE_KEY = 'veloce_omni_links';

	function createOmniSaveSite(ctx) {
		const { isHttpUrl, interceptLog, openFormatMenu, showVeloceToast, formatsFromDownloadAnchor, closeMenu } = ctx;

		let links = [];
		let captions = [];
		let movieTitle = '';
		let pendingSubtitleLabel = '';
		let pendingQualityLabel = '';
		let qualityRetryGen = 0;
		let subtitleRetryGen = 0;
		let lastRawStorage = null;

		const RETRY_POLL_MS = 300;
		const RETRY_TIMEOUT_MS = 2500;

		function isHost() {
			const h = location.hostname.toLowerCase();
			return /videodownloader\.site|moviebox\.|netfilm\.|aoneroom\.com/i.test(h);
		}

		function sanitizeFileStem(name) {
			return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'download';
		}

		function isRandomDownloadName(name) {
			const n = String(name || '').trim();
			if (!n) return true;
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i.test(n)) return true;
			if (/^[0-9a-f]{16,}(\.[a-z0-9]+)?$/i.test(n)) return true;
			return /^download(?:_\d+)?(\.[a-z0-9]+)?$/i.test(n);
		}

		function extractPageTitle() {
			const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
			if (og && !/moviebox|watch online|free movies/i.test(og)) {
				return og.replace(/\s*[-|–—]\s*Moviebox.*$/i, '').trim();
			}
			for (const sel of ['h1', 'h2', '[class*="detail"] h1', '[class*="detail"] h2']) {
				const el = document.querySelector(sel);
				const text = el?.textContent?.replace(/\s+/g, ' ').trim();
				if (text && text.length > 2 && text.length < 180) return text;
			}
			try {
				const slug = location.pathname.match(/\/(?:moviedetail|movies|videoPlayPage\/movies)\/([^/?#]+)/i);
				if (slug?.[1]) {
					return decodeURIComponent(slug[1]).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
				}
			} catch { /* ignore */ }
			return '';
		}

		function resolveMediaTitle(modalTitle) {
			return sanitizeFileStem(modalTitle || movieTitle || extractPageTitle());
		}

		function loadFromStorage() {
			try {
				const raw = sessionStorage.getItem(STORAGE_KEY);
				if (!raw || raw === lastRawStorage) return;
				lastRawStorage = raw;
				const data = JSON.parse(raw);
				if (Date.now() - (data.ts || 0) > 600000) return;
				links = Array.isArray(data.links) ? data.links : [];
				captions = Array.isArray(data.captions) ? data.captions : [];
				if (data.movie) movieTitle = data.movie;
			} catch { /* ignore */ }
		}

		function normalizeQualityKey(label) {
			return String(label || '').replace(/\s+/g, '').replace(/p$/i, '').toLowerCase();
		}

		function findQualityLink(qualityLabel) {
			const key = normalizeQualityKey(qualityLabel);
			if (!key || !links.length) return null;
			return links.find((l) => {
				const r = normalizeQualityKey(l.resolution ?? l.res ?? l.quality ?? l.label ?? '');
				return r === key;
			}) || null;
		}

		function findCaption(label) {
			const key = String(label || '').replace(/\s+/g, '').toLowerCase();
			if (!key || !captions.length) return null;
			return captions.find((c) => {
				const name = String(c.lanName || c.label || c.lan || '').replace(/\s+/g, '').toLowerCase();
				const code = String(c.lan || '').replace(/\s+/g, '').toLowerCase();
				return name === key || code === key || name.includes(key) || key.includes(name);
			}) || null;
		}

		function formatFromQualityLink(link, qualityLabel, movie) {
			const url = link.url || link.downloadUrl || link.href;
			if (!url || !isHttpUrl(url)) return null;
			const res = link.resolution ?? link.res ?? qualityLabel ?? 'download';
			const resLabel = /^\d+$/.test(String(res)) ? `${res}p` : String(res);
			const fmt = (link.format || 'mp4').toLowerCase().replace(/^hevc$/, 'mp4');
			const title = resolveMediaTitle(movie);
			const fileName = `${title}_${resLabel}.${fmt.replace(/^\./, '')}`;
			return [{
				id: 'intercept',
				label: `${qualityLabel} — ${fmt.toUpperCase()}`,
				url,
				ext: `.${fmt.replace(/^\./, '')}`,
				fileName
			}];
		}

		function formatFromCaption(caption, label, movie) {
			const url = caption.url || caption.downloadUrl || caption.href;
			if (!url || !isHttpUrl(url)) return null;
			const lang = sanitizeFileStem(caption.lanName || label || caption.lan || 'subtitle');
			const title = resolveMediaTitle(movie);
			let ext = '.srt';
			try {
				const pathExt = new URL(url).pathname.match(/(\.[a-z0-9]+)$/i);
				if (pathExt) ext = pathExt[1].toLowerCase();
			} catch { /* ignore */ }
			const fileName = `${title}_${lang}${ext}`;
			return [{
				id: 'intercept-subtitle',
				label: `${lang} subtitle`,
				url,
				ext,
				fileName
			}];
		}

		function qualityLabelToResLabel(label) {
			const digits = String(label || '').match(/(\d{3,4})/);
			return digits ? `${digits[1]}p` : sanitizeFileStem(label || 'quality');
		}

		function renameInterceptFormats(formats, subtitleLabel) {
			if (!formats?.length || !isHost()) return formats;
			const title = resolveMediaTitle('');
			if (!title || title === 'download') return formats;
			return formats.map((fmt) => {
				if (fmt.fileName && !isRandomDownloadName(fmt.fileName)) return fmt;
				const href = fmt.url || '';
				const isSubtitle = /\.(srt|vtt|ass|ssa)(\?|#|$)/i.test(href) || fmt.id === 'intercept-subtitle';
				if (isSubtitle) {
					const lang = sanitizeFileStem(subtitleLabel || pendingSubtitleLabel || 'subtitle');
					const ext = fmt.ext || '.srt';
					return {
						...fmt,
						label: `${lang} subtitle`,
						fileName: `${title}_${lang}${ext}`
					};
				}
				if (pendingQualityLabel) {
					const resLabel = qualityLabelToResLabel(pendingQualityLabel);
					const ext = fmt.ext || '.mp4';
					return {
						...fmt,
						label: `${pendingQualityLabel} — ${ext.replace(/^\./, '').toUpperCase()}`,
						fileName: `${title}_${resLabel}${ext}`
					};
				}
				return fmt;
			});
		}

		function patchDownloadAnchorFormats(formats, fileName, href) {
			if (!isHost() || !formats?.length || !isRandomDownloadName(fileName)) return formats;
			const title = resolveMediaTitle('');
			if (!title || title === 'download') return formats;
			if (/\.(srt|vtt|ass|ssa)(\?|#|$)/i.test(href || '')) {
				const lang = sanitizeFileStem(pendingSubtitleLabel || 'subtitle');
				const ext = formats[0].ext || '.srt';
				return formats.map((fmt) => ({
					...fmt,
					label: `${lang} subtitle`,
					fileName: `${title}_${lang}${ext}`
				}));
			}
			if (pendingQualityLabel) {
				const resLabel = qualityLabelToResLabel(pendingQualityLabel);
				const ext = formats[0].ext || '.mp4';
				return formats.map((fmt) => ({
					...fmt,
					label: `${pendingQualityLabel} — ${ext.replace(/^\./, '').toUpperCase()}`,
					fileName: `${title}_${resLabel}${ext}`
				}));
			}
			return formats;
		}

		function retryLoadAndOpen(modalBtn, sectionKind, gen, startedAt) {
			const current = sectionKind === 'quality' ? qualityRetryGen : subtitleRetryGen;
			if (gen !== current) return;
			loadFromStorage();
			const movie = modalBtn.movie || movieTitle;
			if (sectionKind === 'quality') {
				const link = findQualityLink(modalBtn.label);
				const formats = link ? formatFromQualityLink(link, modalBtn.label, movie) : null;
				if (formats) {
					interceptLog('step 2b: cached link arrived after wait — opening menu', formats[0]);
					openFormatMenu(location.href.split('#')[0], modalBtn.btn, modalBtn.btn, formats);
					return;
				}
			} else {
				const caption = findCaption(modalBtn.label);
				const formats = caption ? formatFromCaption(caption, modalBtn.label, movie) : null;
				if (formats) {
					interceptLog('step 2b: cached subtitle arrived after wait — opening menu', formats[0]);
					openFormatMenu(location.href.split('#')[0], modalBtn.btn, modalBtn.btn, formats);
					return;
				}
			}
			if (Date.now() - startedAt >= RETRY_TIMEOUT_MS) {
				if (sectionKind === 'quality') {
					pendingQualityLabel = modalBtn.label || '';
					showVeloceToast('Veloce: click the quality again once the download starts', true);
				} else {
					pendingSubtitleLabel = modalBtn.label || '';
				}
				return;
			}
			setTimeout(() => retryLoadAndOpen(modalBtn, sectionKind, gen, startedAt), RETRY_POLL_MS);
		}

		function parseDownloadModalButton(target) {
			const title = document.getElementById('download-modal-title');
			if (!title) return null;
			const modal = title.closest('[role="dialog"]')
				|| title.closest('.animate-modal')
				|| title.closest('[class*="z-[80]"]')
				|| title.closest('.fixed.inset-0');
			if (!modal) return null;
			const btn = target.closest?.('button');
			if (!btn || !modal.contains(btn)) return null;

			let sectionKind = 'unknown';
			let section = btn.parentElement;
			for (let i = 0; i < 8 && section && section !== modal; i++) {
				const h3 = section.querySelector(':scope > h3, :scope > div > h3');
				const heading = h3?.textContent || '';
				if (/select quality|quality/i.test(heading)) { sectionKind = 'quality'; break; }
				if (/select subtitle|subtitle/i.test(heading)) { sectionKind = 'subtitle'; break; }
				section = section.parentElement;
			}
			if (sectionKind === 'unknown') {
				const labelGuess = btn.querySelector('.font-semibold')?.textContent?.trim()
					|| btn.textContent?.replace(/\s+/g, ' ').trim() || '';
				if (/^\d{3,4}\s*P$/i.test(labelGuess)) sectionKind = 'quality';
			}

			const label = btn.querySelector('.font-semibold')?.textContent?.trim()
				|| btn.textContent?.replace(/\s+/g, ' ').trim().slice(0, 48);
			const movie = modal.querySelector('h3.mb-1')?.textContent?.trim()
				|| modal.querySelector('.grid h3')?.textContent?.trim();

			return { modal, btn, sectionKind, label, movie };
		}

		function onDownloadLinksMessage(data) {
			links = Array.isArray(data.links) ? data.links : [];
			captions = Array.isArray(data.captions) ? data.captions : [];
			if (data.movie) movieTitle = data.movie;
			interceptLog('step 0: cached OmniSave links', {
				count: links.length,
				captions: captions.length,
				qualities: links.map((l) => l.resolution || l.res || l.quality)
			});
		}

		function handleDocumentClick(e) {
			if (!isHost()) return false;
			const modalBtn = parseDownloadModalButton(e.target);
			if (!modalBtn) return false;

			loadFromStorage();

			interceptLog('step 1: OmniSave modal button', {
				section: modalBtn.sectionKind,
				label: modalBtn.label,
				movie: modalBtn.movie,
				coordinatorOnline: ctx.coordinatorOnline,
				cachedLinks: links.length,
				qualities: links.map((l) => l.resolution ?? l.res)
			});

			if (modalBtn.sectionKind === 'quality' && ctx.coordinatorOnline) {
				const link = findQualityLink(modalBtn.label);
				const movie = modalBtn.movie || movieTitle;
				const formats = link ? formatFromQualityLink(link, modalBtn.label, movie) : null;
				if (formats) {
					interceptLog('step 2: opening Veloce menu (cached link)', formats[0]);
					e.preventDefault();
					e.stopImmediatePropagation();
					openFormatMenu(location.href.split('#')[0], modalBtn.btn, modalBtn.btn, formats);
					return true;
				}
				if (!links.length) {
					interceptLog('step 1c: cache empty — waiting for Download Options API response', { label: modalBtn.label });
					retryLoadAndOpen(modalBtn, 'quality', ++qualityRetryGen, Date.now());
				} else {
					pendingQualityLabel = modalBtn.label || '';
					interceptLog('step 1c: no cached link for label — falling back to anchor intercept', {
						label: modalBtn.label,
						qualities: links.map((l) => l.resolution ?? l.res)
					});
				}
			}

			if (modalBtn.sectionKind === 'subtitle' && ctx.coordinatorOnline) {
				const movie = modalBtn.movie || movieTitle;
				const caption = findCaption(modalBtn.label);
				if (caption) {
					const formats = formatFromCaption(caption, modalBtn.label, movie);
					if (formats) {
						interceptLog('step 2: opening Veloce menu (cached subtitle)', formats[0]);
						e.preventDefault();
						e.stopImmediatePropagation();
						openFormatMenu(location.href.split('#')[0], modalBtn.btn, modalBtn.btn, formats);
						return true;
					}
				}
				if (!captions.length) {
					interceptLog('step 1d: cache empty — waiting for Download Options API response', { label: modalBtn.label });
					retryLoadAndOpen(modalBtn, 'subtitle', ++subtitleRetryGen, Date.now());
				} else {
					pendingSubtitleLabel = modalBtn.label || '';
					interceptLog('step 1d: subtitle click — waiting for anchor intercept', {
						label: modalBtn.label,
						cachedCaptions: captions.map((c) => c.lanName || c.lan)
					});
				}
			}

			if (!ctx.coordinatorOnline) {
				interceptLog('step 1b: coordinator OFFLINE — pnpm dev + click Veloce icon');
				showVeloceToast('Veloce offline — run: cd backend && pnpm dev', true);
			}
			return true;
		}

		function handleInterceptRequest(detail) {
			if (!isHost()) return false;
			const { href, download, source } = detail || {};
			interceptLog('step 4: page hook → content script', { href, download, source, coordinatorOnline: ctx.coordinatorOnline });
			if (!ctx.coordinatorOnline) {
				interceptLog('step 4b: ABORT — coordinator offline (pnpm dev + open Veloce popup, refresh tab)');
				return true;
			}
			const fake = {
				href,
				getAttribute: (k) => (k === 'download' ? (download || '') : null)
			};
			const formats = renameInterceptFormats(formatsFromDownloadAnchor(fake));
			if (!formats) {
				interceptLog('step 4b: ABORT — could not build format', { href, download });
				return true;
			}
			pendingSubtitleLabel = '';
			pendingQualityLabel = '';
			interceptLog('step 5: opening Veloce format menu', formats[0]);
			closeMenu();
			openFormatMenu(location.href.split('#')[0], document.body, document.body, formats);
			return true;
		}

		function setup() {
			try {
				const omniModalObs = new MutationObserver(() => {
					if (document.getElementById('download-modal-title')) {
						loadFromStorage();
						if (links.length || captions.length) {
							interceptLog('step 0: OmniSave modal open — links ready', {
								count: links.length,
								captions: captions.length,
								qualities: links.map((l) => l.resolution ?? l.res)
							});
						}
					}
				});
				omniModalObs.observe(document.documentElement, { childList: true, subtree: true });
			} catch { /* ignore */ }
		}

		function onInit() {
			if (!isHost()) return;
			loadFromStorage();
			setup();
			interceptLog('MovieBox / OmniSave family detected — page hook + modal intercept active', {
				host: location.hostname,
				cachedLinks: links.length,
				cachedCaptions: captions.length
			});
		}

		return {
			id: 'omnisave',
			isHost,
			onInit,
			onDownloadLinksMessage,
			handleDocumentClick,
			handleInterceptRequest,
			renameInterceptFormats,
			patchDownloadAnchorFormats,
			loadFromStorage
		};
	}

	window.__veloceRegisterSite('omnisave', createOmniSaveSite);
})();
