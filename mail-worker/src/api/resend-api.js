import resendService from '../service/resend-service';
import app from '../hono/hono';

// Resend signs webhooks with Svix. Requests are only accepted when the Worker has a
// `resend_webhook_secret` (the "whsec_..." signing secret) and the signature matches.
const TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

async function verifyResendSignature(secret, headers, body) {
	const id = headers['svix-id'];
	const timestamp = headers['svix-timestamp'];
	const signatures = headers['svix-signature'];
	if (!secret || !id || !timestamp || !signatures) {
		return false;
	}

	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) {
		return false;
	}

	let keyBytes;
	try {
		keyBytes = base64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
	} catch {
		return false;
	}

	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	const signedContent = new TextEncoder().encode(`${id}.${timestamp}.${body}`);

	for (const entry of signatures.split(' ')) {
		const [version, signature] = entry.split(',');
		if (version !== 'v1' || !signature) {
			continue;
		}
		try {
			if (await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), signedContent)) {
				return true;
			}
		} catch {
			// malformed signature, try the next one
		}
	}
	return false;
}

app.post('/webhooks',async (c) => {
	const body = await c.req.text();
	if (!await verifyResendSignature(c.env.resend_webhook_secret, c.req.header(), body)) {
		return c.text('invalid signature', 401);
	}
	try {
		await resendService.webhooks(c, JSON.parse(body));
		return c.text('success', 200)
	} catch (e) {
		return  c.text(e.message, 500)
	}
})
