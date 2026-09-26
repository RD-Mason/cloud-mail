/*
 * Response hardening.
 *
 * Incoming mail is attacker-controlled. The UI renders message bodies in a
 * script-less sandboxed iframe (mail-vue/src/components/shadow-html); these
 * headers are the second line of defence:
 *  - app pages get a CSP without 'unsafe-inline' scripts, so injected markup
 *    (onerror=..., javascript: URLs) cannot execute even if it reaches the DOM;
 *  - stored objects (attachments, inline images) are served inert, so an HTML
 *    or SVG attachment opened on this origin cannot run script;
 *  - the Telegram preview page may only run its own nonce'd script.
 */

const APP_CSP = [
	"default-src 'self'",
	"script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
	"style-src 'self' 'unsafe-inline' https:",
	"img-src 'self' data: blob: https: http:",
	"font-src 'self' data: https:",
	"media-src 'self' data: blob: https:",
	"connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com https://api.github.com https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com",
	"frame-src 'self' https://challenges.cloudflare.com",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'self'"
];

// HTTPS only for this hostname; no includeSubDomains so other (DNS-only) subdomains are unaffected.
const HSTS = 'max-age=31536000';

const OBJECT_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

// Types a browser only ever displays passively. Anything else is sent as a download.
const PASSIVE_TYPE = /^(image\/(png|jpe?g|pjpeg|gif|webp|bmp|avif|apng|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)\s*(;|$)/i;

let inlineScriptHashes = null;

async function sha256Base64(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let binary = '';
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

// index.html carries a small inline theme script; allow exactly that script by hash.
// Every HTML route serves the same index.html, so the hashes are computed once per isolate.
async function getInlineScriptHashes(env, requestUrl) {
	if (inlineScriptHashes) {
		return inlineScriptHashes;
	}
	try {
		const res = await env.assets.fetch(new Request(new URL('/', requestUrl)));
		const html = await res.text();
		const hashes = [];
		for (const match of html.matchAll(/<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
			if (match[1].trim()) {
				hashes.push(`'sha256-${await sha256Base64(match[1].replace(/\r\n?/g, '\n'))}'`);
			}
		}
		inlineScriptHashes = hashes;
	} catch (e) {
		console.error('CSP: failed to hash inline scripts', e);
		return [];
	}
	return inlineScriptHashes;
}

function cleanNullHeaders(headers) {
	// kv-obj-service passes `null` for missing metadata, which ends up as the literal string "null".
	for (const name of ['Content-Disposition', 'Cache-Control']) {
		if (headers.get(name) === 'null') {
			headers.delete(name);
		}
	}
}

export async function secureAssetResponse(env, req, res) {
	const hashes = await getInlineScriptHashes(env, req.url);
	const csp = APP_CSP.map(directive =>
		directive.startsWith('script-src ') && hashes.length ? `${directive} ${hashes.join(' ')}` : directive
	).join('; ');

	const out = new Response(res.body, res);
	out.headers.set('Content-Security-Policy', csp);
	out.headers.set('X-Content-Type-Options', 'nosniff');
	out.headers.set('Strict-Transport-Security', HSTS);
	out.headers.set('X-Frame-Options', 'SAMEORIGIN');
	out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	return out;
}

export function secureObjectResponse(res) {
	const out = new Response(res.body, res);
	cleanNullHeaders(out.headers);
	out.headers.set('Content-Security-Policy', OBJECT_CSP);
	out.headers.set('X-Content-Type-Options', 'nosniff');
	out.headers.set('Strict-Transport-Security', HSTS);

	const type = (out.headers.get('Content-Type') || '').trim();
	if (!PASSIVE_TYPE.test(type)) {
		const disposition = out.headers.get('Content-Disposition') || '';
		out.headers.set('Content-Disposition', /^\s*attachment\b/i.test(disposition)
			? disposition
			: disposition.replace(/^\s*[^;]*/, 'attachment'));
	}
	return out;
}

export function secureTelegramPage(res) {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const nonce = btoa(String.fromCharCode(...bytes));

	const rewritten = new HTMLRewriter().on('script', {
		element(el) {
			if (!el.hasAttribute('src')) {
				el.setAttribute('nonce', nonce);
			}
		}
	}).transform(res);

	const out = new Response(rewritten.body, rewritten);
	out.headers.set('Content-Security-Policy', [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline' https:",
		"img-src 'self' data: blob: https: http:",
		"font-src 'self' data: https:",
		"media-src 'self' data: blob: https:",
		"base-uri 'none'",
		"form-action 'none'"
	].join('; '));
	out.headers.set('X-Content-Type-Options', 'nosniff');
	out.headers.set('Strict-Transport-Security', HSTS);
	out.headers.set('Referrer-Policy', 'no-referrer');
	return out;
}

export function secureApiResponse(res) {
	const out = new Response(res.body, res);
	out.headers.set('X-Content-Type-Options', 'nosniff');
	out.headers.set('Strict-Transport-Security', HSTS);
	if (!out.headers.has('Content-Security-Policy')) {
		out.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
	}
	return out;
}
