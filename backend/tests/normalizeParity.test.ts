import { describe, it, expect } from 'vitest';
import { normalizeFormatUrl } from '../src/lib/server/extractor';

/**
 * Canonical cache-key contract (see doc/SITE_MODEL.md).
 *
 * The extension service worker (`background.js` `normalizeFormatUrl`), the
 * extension content script (`content.js` `normalizeBadgeKey`) and the Rust
 * coordinator (`desktop/src-tauri/src/formats.rs` `normalize_url`) must all
 * produce these exact strings for these inputs, or the prefetch → cache → click
 * handshake silently misses and every badge click re-runs yt-dlp.
 *
 * This file pins the Node/backend reference. Any change here is a deliberate
 * contract change and must be mirrored in the other three implementations.
 */
const CASES: Array<[input: string, expected: string]> = [
	// YouTube — canonical watch URL, playlist / index / radio params stripped
	['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
	['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
	[
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM&index=2&start_radio=1',
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
	],
	['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
	// YouTube Shorts — KEPT in /shorts/ form (see SITE_MODEL.md "Known deviation")
	['https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/shorts/abc123'],
	['https://www.youtube.com/shorts/abc123?feature=share', 'https://www.youtube.com/shorts/abc123'],

	// Instagram — query dropped, trailing slash dropped, /reels/ → /reel/
	['https://www.instagram.com/p/ABC123/', 'https://www.instagram.com/p/ABC123'],
	[
		'https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link&igsh=x',
		'https://www.instagram.com/p/ABC123'
	],
	['https://www.instagram.com/reels/AbCdEf/?igsh=1', 'https://www.instagram.com/reel/AbCdEf'],
	['https://www.instagram.com/reel/AbCdEf', 'https://www.instagram.com/reel/AbCdEf'],

	// Generic — hash stripped, query and trailing slash PRESERVED
	['https://cdn.example.com/video.mp4?token=abc#frag', 'https://cdn.example.com/video.mp4?token=abc'],
	['https://example.com/page/', 'https://example.com/page/'],

	// Non-URL input passes through unchanged
	['not a url', 'not a url']
];

describe('normalizeFormatUrl — cross-layer cache-key contract', () => {
	for (const [input, expected] of CASES) {
		it(`${input} → ${expected}`, () => {
			expect(normalizeFormatUrl(input)).toBe(expected);
		});
	}

	it('is idempotent (normalize(normalize(x)) === normalize(x))', () => {
		for (const [input] of CASES) {
			const once = normalizeFormatUrl(input);
			expect(normalizeFormatUrl(once)).toBe(once);
		}
	});
});
