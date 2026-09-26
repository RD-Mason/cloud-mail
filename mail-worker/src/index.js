import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import { secureApiResponse, secureAssetResponse, secureObjectResponse, secureTelegramPage } from './security-headers';

async function getStoredObject(env, key) {
	if (env.r2) {
		const obj = await env.r2.get(key);
		if (obj) {
			const headers = new Headers();
			obj.writeHttpMetadata(headers);
			headers.set('ETag', obj.httpEtag);
			return new Response(obj.body, { headers });
		}
	}
	// Objects stored before an R2 bucket was bound live in KV.
	return await kvObjService.toObjResp({ env }, key);
}

export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			const res = await app.fetch(req, env, ctx);

			if (url.pathname.startsWith('/oss/')) {
				return secureObjectResponse(res);
			}

			if (url.pathname.startsWith('/telegram/') && (res.headers.get('Content-Type') || '').includes('text/html')) {
				return secureTelegramPage(res);
			}

			return secureApiResponse(res);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 const res = await getStoredObject(env, url.pathname.substring(1));
			 if (!res) {
				 return secureApiResponse(new Response('Not Found', { status: 404 }));
			 }
			 return secureObjectResponse(res);
		 }

		return secureAssetResponse(env, req, await env.assets.fetch(req));
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};
