import BizError from '../error/biz-error';
import settingService from './setting-service';
import emailService from './email-service';
import r2Service from './r2-service';
import userContext from '../security/user-context';
import { Resend } from 'resend';
import { parseHTML } from 'linkedom';
import { FORWARD_BACKFILL_SCHEMA } from '../lib/forward-backfill-schema';

export const FORWARD_BACKFILL_LIMITS = { emails: 1000, deliveries: 2000, batch: 3 };
const LEASE_MS = 5 * 60 * 1000;
const SEND_TIMEOUT_MS = 30 * 1000;
const RESEND_INTERVAL_MS = 700;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const ADDRESS = /^[^\s@<>\r\n,]+@[^\s@<>\r\n,]+\.[^\s@<>\r\n,]+$/;
const initializedSchemas = new WeakSet();
const REJECTED_CLOUDFLARE_CODES = new Set([
	'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
	'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED',
	'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED',
	'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED',
	'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG',
	'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lowerAddress = value => String(value || '').trim().toLowerCase();
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const cleanHeader = value => String(value || '').replace(/[\r\n]/g, ' ').trim();

export async function ensureForwardBackfillSchema(c) {
	const db = c.env.db;
	if (!db?.prepare || !db?.batch) throw new BizError('历史邮件补转数据库未绑定，请检查 D1 绑定', 503);
	if (initializedSchemas.has(db)) return;
	try {
		// Concurrent requests may each run the idempotent DDL. Never share an in-flight
		// D1 I/O promise across Cloudflare request contexts.
		await db.batch(FORWARD_BACKFILL_SCHEMA.map(sql => db.prepare(sql)));
		initializedSchemas.add(db);
	}
	catch (error) {
		console.error('历史邮件补转表升级失败', error);
		throw new BizError('历史邮件补转数据库升级失败，请稍后重试或检查 D1 绑定', 503);
	}
}

function administrator(c) {
	const user = userContext.getUser(c);
	if (!user?.userId || user.email !== c.env.admin) {
		throw new BizError('只有管理员可以补转历史邮件', 403);
	}
	return user.userId;
}

function addresses(value) {
	const list = Array.isArray(value) ? value : String(value || '').split(',');
	const result = [...new Set(list.map(lowerAddress).filter(Boolean))];
	if (!result.length || result.length > 50 || result.some(value => !ADDRESS.test(value))) {
		throw new BizError('请配置有效的第三方转发邮箱（最多 50 个）', 400);
	}
	return result;
}

function dateInput(value, label) {
	if (value == null || value === '') return null;
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new BizError(`${label}必须是有效的 ISO 日期时间`, 400);
	}
	return new Date(value).toISOString();
}

function filters(params = {}) {
	const accountId = Number(params.accountId ?? 0);
	if (!Number.isSafeInteger(accountId) || accountId < 0) throw new BizError('邮箱编号无效', 400);
	const startTime = dateInput(params.startTime, '开始时间');
	const endTime = dateInput(params.endTime, '结束时间');
	if (startTime && endTime && startTime > endTime) throw new BizError('开始时间不能晚于结束时间', 400);
	return { accountId, startTime, endTime };
}

function idInput(value, label) {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new BizError(`${label}无效`, 400);
	return value;
}

function provider(c, setting, accountEmail) {
	const binding = c.env.backfill_email || c.env.email;
	if (binding && typeof binding.send === 'function') return { name: 'cloudflare', binding };
	const domain = accountEmail.split('@').pop().toLowerCase();
	const token = setting.resendTokens?.[domain];
	return token ? { name: 'resend', token } : null;
}

async function forwardingConfig(c) {
	const setting = await settingService.query(c);
	if (Number(setting.forwardStatus) !== 0) throw new BizError('请先启用第三方邮箱转发', 400);
	const targets = addresses(setting.forwardEmail);
	const ruleEmails = Number(setting.ruleType) === 1
		? [...new Set(String(setting.ruleEmail || '').split(',').map(lowerAddress).filter(Boolean))] : null;
	if (ruleEmails && ruleEmails.length > 50) throw new BizError('转发规则超过 50 个，请缩小规则范围', 400);
	return { setting, targets, ruleEmails };
}

function selectionSql(userId, filter, ruleEmails, cutoffId) {
	const where = [
		'e.user_id = ?', 'a.user_id = ?', 'a.is_del = 0',
		'e.type = 0', 'e.status = 0', 'e.is_del = 0', 'e.unread = 0', 'e.email_id <= ?'
	];
	const values = [userId, userId, cutoffId];
	if (filter.accountId) { where.push('e.account_id = ?'); values.push(filter.accountId); }
	if (filter.startTime) { where.push('julianday(e.create_time) >= julianday(?)'); values.push(filter.startTime); }
	if (filter.endTime) { where.push('julianday(e.create_time) <= julianday(?)'); values.push(filter.endTime); }
	if (ruleEmails) {
		if (!ruleEmails.length) where.push('0 = 1');
		else {
			where.push(`COALESCE(NULLIF(e.to_email, ''), a.email) COLLATE NOCASE IN (${ruleEmails.map(() => '?').join(',')})`);
			values.push(...ruleEmails);
		}
	}
	return { where: where.join(' AND '), values };
}

async function selection(c, userId, params, cutoffId) {
	const filter = filters(params);
	const config = await forwardingConfig(c);
	const accountRows = (await c.env.db.prepare(
		'SELECT account_id AS accountId, email FROM account WHERE user_id = ? AND is_del = 0 ORDER BY email'
	).bind(userId).all()).results;
	if (filter.accountId && !accountRows.some(a => a.accountId === filter.accountId)) {
		throw new BizError('只能补转当前账号拥有的邮箱', 403);
	}
	if (cutoffId == null) {
		const max = await c.env.db.prepare(
			'SELECT COALESCE(MAX(e.email_id), 0) AS cutoffId FROM email e JOIN account a ON a.account_id = e.account_id WHERE e.user_id = ? AND a.user_id = ? AND a.is_del = 0'
		).bind(userId, userId).first();
		cutoffId = max.cutoffId;
	}
	if (!Number.isSafeInteger(cutoffId) || cutoffId < 0) throw new BizError('邮件预览已失效，请重新预览', 400);
	const clause = selectionSql(userId, filter, config.ruleEmails, cutoffId);
	const rows = (await c.env.db.prepare(
		`SELECT e.email_id AS emailId, e.account_id AS accountId, e.subject, a.email AS accountEmail
		 FROM email e JOIN account a ON a.account_id = e.account_id
		 WHERE ${clause.where} ORDER BY e.email_id LIMIT ${FORWARD_BACKFILL_LIMITS.emails + 1}`
	).bind(...clause.values).all()).results;
	if (rows.length > FORWARD_BACKFILL_LIMITS.emails || rows.length * config.targets.length > FORWARD_BACKFILL_LIMITS.deliveries) {
		throw new BizError('每次最多补转 1000 封邮件或 2000 次投递，请缩小时间范围或选择单个邮箱', 400);
	}
	const ledger = rows.length ? (await c.env.db.prepare(
		`SELECT i.email_id AS emailId, i.target, i.status
		 FROM forward_backfill_item i JOIN email e ON e.email_id = i.email_id
		 JOIN account a ON a.account_id = e.account_id
		 WHERE ${clause.where} AND i.target IN (SELECT value FROM json_each(?))`
	).bind(...clause.values, JSON.stringify(config.targets)).all()).results : [];
	const existing = new Map(ledger.map(i => [`${i.emailId}:${lowerAddress(i.target)}`, i.status]));
	const available = rows.flatMap(row => config.targets
		.filter(target => !existing.has(`${row.emailId}:${target}`))
		.map(target => ({ ...row, target })));
	const domains = [...new Set(available.filter(row => !provider(c, config.setting, row.accountEmail))
		.map(row => row.accountEmail.split('@').pop()))];
	const preview = {
		total: new Set(available.map(row => row.emailId)).size,
		deliveryTotal: available.length,
		targets: config.targets,
		accounts: accountRows,
		cutoffId,
		sendReady: Number(config.setting.send) === 0 && !domains.length,
		unavailableDomains: domains,
		alreadySent: ledger.filter(item => item.status === 'sent').length,
		reservedDeliveries: ledger.filter(item => item.status !== 'sent').length,
		selectedTotal: rows.length
	};
	return { preview, config, filter, clause };
}

async function ownedJob(c, userId, jobId) {
	const row = await c.env.db.prepare('SELECT * FROM forward_backfill_job WHERE job_id = ? AND user_id = ?').bind(jobId, userId).first();
	if (!row) throw new BizError('补转任务不存在或不属于当前账号', 404);
	return row;
}

async function recoverExpired(c, job) {
	if (job.lease_until > Date.now()) return;
	// Never replay an interrupted provider call. It may already have accepted the email.
	// A failed receipt write can also leave a processing item after its job lease was released.
	await c.env.db.batch([
		c.env.db.prepare(`UPDATE forward_backfill_item SET status = 'unknown', message = ?, updated_at = CURRENT_TIMESTAMP
			WHERE job_id = ? AND status = 'processing'
			AND EXISTS (SELECT 1 FROM forward_backfill_job WHERE job_id = ? AND lease_token IS ? AND lease_until <= ?)`)
			.bind('发送进程中断，投递结果未知；请核对目标邮箱，系统不会自动重发', job.job_id, job.job_id, job.lease_token, Date.now()),
		c.env.db.prepare('UPDATE forward_backfill_job SET lease_token = NULL, lease_until = 0 WHERE job_id = ? AND lease_token IS ? AND lease_until <= ?')
			.bind(job.job_id, job.lease_token, Date.now())
	]);
}

async function snapshot(c, userId, jobId) {
	const job = await ownedJob(c, userId, jobId);
	await recoverExpired(c, job);
	// Derive status in the UPDATE itself so a concurrent status poll cannot overwrite a newer retry.
	// A transaction returns a consistent status/count/error view in one D1 round trip.
	const [updated, aggregate, failures] = await c.env.db.batch([
		c.env.db.prepare(`UPDATE forward_backfill_job SET status = CASE
			WHEN lease_until > ? OR EXISTS (SELECT 1 FROM forward_backfill_item WHERE job_id = ? AND status IN ('pending', 'processing')) THEN 'running'
			WHEN EXISTS (SELECT 1 FROM forward_backfill_item WHERE job_id = ? AND status = 'unknown') THEN 'needs_review'
			WHEN EXISTS (SELECT 1 FROM forward_backfill_item WHERE job_id = ? AND status = 'failed') THEN 'completed_with_errors'
			ELSE 'completed' END, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND user_id = ? RETURNING status`)
			.bind(Date.now(), jobId, jobId, jobId, jobId, userId),
		c.env.db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT email_id) AS sourceTotal,
			SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed,
			SUM(status = 'pending') AS pending, SUM(status = 'processing') AS processing,
			SUM(status = 'unknown') AS unknown,
			SUM(delivery_status = 'delivered') AS delivered,
			SUM(delivery_status IN ('bounced', 'delivery_failed')) AS deliveryFailed
			FROM forward_backfill_item WHERE job_id = ? AND user_id = ?`).bind(jobId, userId),
		c.env.db.prepare(`SELECT email_id AS emailId, subject, target, message, status
			FROM forward_backfill_item WHERE job_id = ? AND user_id = ? AND status IN ('failed', 'unknown') ORDER BY item_id LIMIT 100`)
			.bind(jobId, userId)
	]);
	const counts = aggregate.results[0];
	for (const key of ['total', 'sourceTotal', 'sent', 'failed', 'pending', 'processing', 'unknown', 'delivered', 'deliveryFailed']) counts[key] = Number(counts[key]) || 0;
	const status = updated.results[0]?.status;
	if (!status) throw new BizError('补转任务不存在或不属于当前账号', 404);
	const errors = failures.results;
	return { jobId, ...counts, status, targets: JSON.parse(job.targets), errors, createdAt: job.created_at,
		providerAccepted: counts.sent, deliveryConfirmed: counts.total > 0 && counts.delivered === counts.total };
}

async function readableMail(c, userId, item) {
	const row = await c.env.db.prepare(`SELECT e.*, a.email AS account_email, a.name AS account_name
		FROM email e JOIN account a ON a.account_id = e.account_id
		WHERE e.email_id = ? AND e.account_id = ? AND e.user_id = ? AND a.user_id = ?
		AND a.is_del = 0 AND e.type = 0 AND e.status = 0 AND e.is_del = 0 AND e.unread = 0`)
		.bind(item.email_id, item.account_id, userId, userId).first();
	if (!row) throw new BizError('原邮件已删除、已读或邮箱归属发生变化，未发送', 400);
	return row;
}

async function finalMailGuard(c, userId, item, jobId, token) {
	// Recheck every authorization/state predicate immediately before sending without
	// rereading the potentially large body. Verify both the job lease and item claim.
	const row = await c.env.db.prepare(`SELECT e.email_id, e.to_email, a.email AS account_email
		FROM email e JOIN account a ON a.account_id = e.account_id
		WHERE e.email_id = ? AND e.account_id = ? AND e.user_id = ? AND a.user_id = ?
		AND a.is_del = 0 AND e.type = 0 AND e.status = 0 AND e.is_del = 0 AND e.unread = 0
		AND EXISTS (SELECT 1 FROM forward_backfill_job j WHERE j.job_id = ? AND j.user_id = ?
			AND j.lease_token = ? AND j.lease_until > ?)
		AND EXISTS (SELECT 1 FROM forward_backfill_item i WHERE i.item_id = ? AND i.job_id = ?
			AND i.user_id = ? AND i.email_id = e.email_id AND i.account_id = e.account_id
			AND i.status = 'processing' AND i.claim_token = ?)`)
		.bind(item.email_id, item.account_id, userId, userId, jobId, userId, token, Date.now(),
			item.item_id, jobId, userId, token).first();
	if (!row) throw new BizError('原邮件已删除、已读、邮箱归属或任务执行凭据发生变化，未发送', 400);
	return row;
}

function permittedMail(row, config, target) {
	const sourceTo = lowerAddress(row.to_email || row.account_email);
	if (!config.targets.includes(lowerAddress(target)) || (config.ruleEmails && !config.ruleEmails.includes(sourceTo))) {
		throw new BizError('转发目标或规则已更改，请恢复设置后重试', 400);
	}
	if (Number(config.setting.send) !== 0) throw new BizError('系统已关闭邮件发送，未发送', 400);
}

export async function buildForwardBackfillMessage(c, row, target, setting) {
	const attachments = (await c.env.db.prepare(
		'SELECT * FROM attachments WHERE email_id = ? AND user_id = ? AND account_id = ? AND status = 0 ORDER BY att_id'
	).bind(row.email_id, row.user_id, row.account_id).all()).results;
	if (attachments.length > 32) throw new BizError('邮件附件超过 32 个，整封邮件未发送', 400);
	let html = row.content || '';
	const outgoing = [];
	const inlineIds = new Set();
	const inlineSources = new Map();
	// Account for MIME/base64 expansion as well as per-part and forwarding headers.
	let bytes = Math.ceil(new TextEncoder().encode(html + (row.text || '')).byteLength / 3) * 4 + 4096;
	if (bytes > MAX_MESSAGE_BYTES) throw new BizError('邮件正文编码后的大小超过 5 MB，未发送', 400);
	for (const attachment of attachments) {
		const object = await r2Service.getObj(c, attachment.key);
		if (!object) throw new BizError(`附件“${attachment.filename || attachment.key}”缺失，整封邮件未发送`, 400);
		const content = object instanceof ArrayBuffer ? object : await object.arrayBuffer();
		if (attachment.size != null && content.byteLength !== Number(attachment.size)) {
			throw new BizError(`附件“${attachment.filename || attachment.key}”不完整，整封邮件未发送`, 400);
		}
		bytes += Math.ceil(content.byteLength / 3) * 4 + 1024;
		if (bytes > MAX_MESSAGE_BYTES) throw new BizError('邮件及附件编码后的大小超过 5 MB，未发送', 400);
		const inline = Number(attachment.type) === 1 || !!attachment.content_id || attachment.disposition === 'inline';
		const contentId = inline ? String(attachment.content_id || `backfill-${row.email_id}-${attachment.att_id}@cloud-mail`).replace(/^<|>$/g, '') : null;
		if (contentId) {
			inlineIds.add(contentId);
			inlineSources.set(`{{domain}}${attachment.key}`, `cid:${contentId}`);
			inlineSources.set(attachment.key, `cid:${contentId}`);
			if (setting.r2Domain) {
				const domain = /^https?:\/\//.test(setting.r2Domain) ? setting.r2Domain : `https://${setting.r2Domain}`;
				inlineSources.set(`${domain.replace(/\/$/, '')}/${attachment.key}`, `cid:${contentId}`);
			}
		}
		outgoing.push({ content, filename: attachment.filename || `attachment-${attachment.att_id}`,
			mimeType: attachment.mime_type || 'application/octet-stream', ...(contentId ? { contentId } : {}) });
	}
	if (html && inlineSources.size) {
		const { document } = parseHTML(html);
		for (const element of document.querySelectorAll('*')) {
			for (const attribute of Array.from(element.attributes)) {
				let value = attribute.value;
				for (const [source, cid] of [...inlineSources].sort((a, b) => b[0].length - a[0].length)) {
					if (value === source) value = cid;
					else if (attribute.name === 'style' || attribute.name === 'srcset') value = value.split(source).join(cid);
				}
				if (value !== attribute.value) element.setAttribute(attribute.name, value);
			}
		}
		html = document.toString();
	}
	if (/\{\{domain\}\}attachments\//.test(html)) throw new BizError('正文内嵌附件信息缺失，整封邮件未发送', 400);
	for (const match of html.matchAll(/cid:([^\s"'<>\)]+)/g)) {
		if (!inlineIds.has(match[1])) throw new BizError('正文内嵌附件缺失，整封邮件未发送', 400);
	}
	const sender = row.name ? `${cleanHeader(row.name)} <${cleanHeader(row.send_email)}>` : cleanHeader(row.send_email);
	const sourceTo = row.to_email || row.account_email;
	const receivedTime = `${cleanHeader(row.create_time)} UTC`;
	const originalSubject = cleanHeader(row.subject) || '（无主题）';
	const summary = `历史邮件补转\n原发件人：${sender}\n原收件人：${cleanHeader(sourceTo)}\n收件时间：${receivedTime}\n原主题：${originalSubject}\n\n`;
	const header = `<div style="padding:12px;border-bottom:1px solid #ddd"><strong>历史邮件补转</strong><br>原发件人：${escapeHtml(sender)}<br>原收件人：${escapeHtml(sourceTo)}<br>收件时间：${escapeHtml(receivedTime)}<br>原主题：${escapeHtml(originalSubject)}</div>`;
	const parsed = html ? parseHTML(html).document : null;
	const text = summary + (row.text || parsed?.body?.textContent || parsed?.documentElement?.textContent || '');
	const replyTo = ADDRESS.test(lowerAddress(row.send_email)) ? cleanHeader(row.send_email) : null;
	return {
		from: row.account_email, name: cleanHeader(row.account_name) || 'Cloud Mail', to: target,
		subject: `Fwd: ${originalSubject}`, text,
		html: html ? header + html : header + `<pre style="white-space:pre-wrap">${escapeHtml(row.text || '')}</pre>`,
		attachments: outgoing, replyTo
	};
}

class UnknownSendError extends Error {}
class RejectedSendError extends Error {}

async function sendMessage(selectedProvider, message, idempotencyKey) {
	const send = async () => {
		if (selectedProvider.name === 'cloudflare') {
			const form = {
				from: { email: message.from, name: message.name }, to: message.to,
				subject: message.subject, text: message.text, html: message.html,
				attachments: await emailService.toCloudflareAttachments(message.attachments)
			};
			if (message.replyTo) form.replyTo = message.replyTo;
			let response;
			try { response = await selectedProvider.binding.send(form); }
			catch (error) {
				// Cloudflare's explicit validation/auth/recipient failures guarantee no acceptance.
				const code = error.code || String(error.message || '').match(/\bE_[A-Z_]+\b/)?.[0];
				if (REJECTED_CLOUDFLARE_CODES.has(code)) {
					throw new RejectedSendError(error.message);
				}
				throw new UnknownSendError(error.message || '发信服务没有返回明确结果');
			}
			if (!response?.messageId) throw new UnknownSendError('发信服务未返回回执，投递结果未知');
			return { provider: 'cloudflare', providerId: response.messageId };
		}
		const resend = new Resend(selectedProvider.token);
		const form = {
			from: `${message.name} <${message.from}>`, to: [message.to],
			subject: message.subject, text: message.text, html: message.html,
			attachments: await Promise.all(message.attachments.map(async attachment => ({
				filename: attachment.filename,
				content: await emailService.toAttachmentBase64(attachment),
				contentType: attachment.mimeType,
				...(attachment.contentId ? { contentId: attachment.contentId } : {})
			})))
		};
		if (message.replyTo) form.replyTo = message.replyTo;
		let response;
		try { response = await resend.emails.send(form, { idempotencyKey }); }
		catch (error) { throw new UnknownSendError(error.message || '发信服务没有返回明确结果'); }
		if (response.error) {
			if (Number(response.error.statusCode) >= 500 || response.error.name === 'application_error') {
				throw new UnknownSendError(response.error.message);
			}
			throw new RejectedSendError(response.error.message || '发信服务明确拒绝了邮件');
		}
		if (!response.data?.id) throw new UnknownSendError('发信服务未返回回执，投递结果未知');
		return { provider: 'resend', providerId: response.data.id };
	};
	let timer;
	try {
		return await Promise.race([send(), new Promise((_, reject) => {
			timer = setTimeout(() => reject(new UnknownSendError('发信服务超时，投递结果未知；系统不会自动重发')), SEND_TIMEOUT_MS);
		})]);
	} finally { clearTimeout(timer); }
}

const forwardBackfillService = {
	async preview(c, params) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		return (await selection(c, userId, params)).preview;
	},

	async start(c, params) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		const cutoffId = Number(params.cutoffId);
		if (!Number.isSafeInteger(cutoffId) || cutoffId < 0) throw new BizError('请先预览待补转邮件', 400);
		const selected = await selection(c, userId, params, cutoffId);
		const submittedTargets = addresses(params.targets);
		if ([...submittedTargets].sort().join(',') !== [...selected.config.targets].sort().join(',')) {
			throw new BizError('转发目标已更改，请重新预览并确认', 400);
		}
		if (!selected.preview.sendReady) throw new BizError('请先开启发件并为所选域名配置 Cloudflare 发件绑定或 Resend Token', 400);
		const active = await c.env.db.prepare("SELECT job_id FROM forward_backfill_job WHERE user_id = ? AND status = 'running'").bind(userId).first();
		if (active) {
			const state = await snapshot(c, userId, active.job_id);
			if (state.status === 'running') throw new BizError('已有补转任务，请先继续当前任务', 409);
		}
		if (!selected.preview.deliveryTotal) throw new BizError('没有可补转的未读邮件；已处理记录可在原任务查看或重试', 400);
		const jobId = crypto.randomUUID();
		const { filter, clause } = selected;
		try {
			// One D1 batch is a transaction. Duplicate starts cannot allocate the same mail/target.
			await c.env.db.batch([
				c.env.db.prepare(`INSERT INTO forward_backfill_job
					(job_id, user_id, account_id, start_time, end_time, cutoff_id, targets)
					VALUES (?, ?, ?, ?, ?, ?, ?)`)
					.bind(jobId, userId, filter.accountId, filter.startTime, filter.endTime, cutoffId, JSON.stringify(submittedTargets)),
				c.env.db.prepare(`INSERT INTO forward_backfill_item (job_id, user_id, email_id, account_id, target, subject)
					SELECT ?, e.user_id, e.email_id, e.account_id, t.value, COALESCE(e.subject, '')
					FROM email e JOIN account a ON a.account_id = e.account_id CROSS JOIN json_each(?) t
					WHERE ${clause.where} AND NOT EXISTS
					(SELECT 1 FROM forward_backfill_item i WHERE i.email_id = e.email_id AND i.target = t.value COLLATE NOCASE)`)
					.bind(jobId, JSON.stringify(submittedTargets), ...clause.values)
			]);
		} catch (error) {
			if (/UNIQUE constraint failed/.test(error.message || '')) throw new BizError('另一个补转任务已启动，请刷新查看', 409);
			throw error;
		}
		return snapshot(c, userId, jobId);
	},

	async status(c, params = {}) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		if (params.jobId) return snapshot(c, userId, idInput(params.jobId, '任务编号'));
		const job = await c.env.db.prepare('SELECT job_id FROM forward_backfill_job WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').bind(userId).first();
		return job ? snapshot(c, userId, job.job_id) : null;
	},

	async history(c) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		const rows = (await c.env.db.prepare(`SELECT j.job_id AS jobId, j.status, j.targets, j.created_at AS createdAt,
			COUNT(i.item_id) AS total, COUNT(DISTINCT i.email_id) AS sourceTotal,
			COALESCE(SUM(i.status = 'sent'), 0) AS sent, COALESCE(SUM(i.status = 'failed'), 0) AS failed,
			COALESCE(SUM(i.status = 'pending'), 0) AS pending, COALESCE(SUM(i.status = 'processing'), 0) AS processing,
			COALESCE(SUM(i.status = 'unknown'), 0) AS unknown
			FROM forward_backfill_job j LEFT JOIN forward_backfill_item i ON i.job_id = j.job_id
			WHERE j.user_id = ? GROUP BY j.job_id ORDER BY j.rowid DESC LIMIT 20`).bind(userId).all()).results;
		return { jobs: rows.map(row => ({ ...row, targets: JSON.parse(row.targets) })) };
	},

	async process(c, params) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		const jobId = idInput(params.jobId, '任务编号');
		await snapshot(c, userId, jobId);
		const token = crypto.randomUUID();
		const claim = await c.env.db.prepare(`UPDATE forward_backfill_job SET lease_token = ?, lease_until = ?
			WHERE job_id = ? AND user_id = ? AND status = 'running' AND lease_until <= ?`)
			.bind(token, Date.now() + LEASE_MS, jobId, userId, Date.now()).run();
		if (!claim.meta.changes) return snapshot(c, userId, jobId);
		try {
			const claimed = await c.env.db.prepare(`UPDATE forward_backfill_item SET status = 'processing',
				claim_token = ?, started_at = ?, attempts = attempts + 1, message = NULL, updated_at = CURRENT_TIMESTAMP
				WHERE item_id IN (SELECT item_id FROM forward_backfill_item
					WHERE job_id = ? AND user_id = ? AND status = 'pending' ORDER BY item_id LIMIT ${FORWARD_BACKFILL_LIMITS.batch})
				AND job_id = ? AND user_id = ? AND status = 'pending'
				AND EXISTS (SELECT 1 FROM forward_backfill_job WHERE job_id = ? AND user_id = ? AND lease_token = ? AND lease_until > ?)
				RETURNING *`).bind(token, Date.now(), jobId, userId, jobId, userId, jobId, userId, token, Date.now()).all();
			// Cloudflare items can overlap, while every Resend attempt shares this request's
			// serial queue. Queue ownership stays under the persistent job lease.
			let resendTail = Promise.resolve();
			const queueResend = action => {
				const task = resendTail.then(action);
				resendTail = task.catch(() => {});
				return task;
			};
			const processItem = async item => {
				let submitted = false;
				try {
					const config = await forwardingConfig(c);
					const row = await readableMail(c, userId, item);
					permittedMail(row, config, item.target);
					if (!provider(c, config.setting, row.account_email)) throw new BizError('原收件域名尚未配置发信服务，未发送', 400);
					const message = await buildForwardBackfillMessage(c, row, item.target, config.setting);
					const deliver = async (insideResendQueue = false) => {
						const finalConfig = await forwardingConfig(c);
						const proposedProvider = provider(c, finalConfig.setting, row.account_email);
						if (!proposedProvider) throw new BizError('原收件域名的发信服务已被移除，未发送', 400);
						if (proposedProvider.name === 'resend' && !insideResendQueue) {
							return queueResend(() => deliver(true));
						}
						// A queued Resend item rechecks here, after waiting its turn, rather than
						// relying on a stale authorization/read/lease check made before queuing.
						const current = await finalMailGuard(c, userId, item, jobId, token);
						permittedMail(current, finalConfig, item.target);
						const selectedProvider = provider(c, finalConfig.setting, current.account_email);
						if (!selectedProvider) throw new BizError('原收件域名的发信服务已被移除，未发送', 400);
						if (selectedProvider.name === 'resend' && !insideResendQueue) {
							return queueResend(() => deliver(true));
						}
						if (current.account_email !== message.from) throw new BizError('原收件邮箱地址发生变化，未发送', 400);
						submitted = true;
						try {
							const receipt = await sendMessage(selectedProvider, message, `cloud-mail-backfill-${item.item_id}-${item.attempts}`);
							// Persist each receipt immediately; do not wait for other providers in the batch.
							await c.env.db.prepare(`UPDATE forward_backfill_item SET status = 'sent', provider = ?, provider_id = ?,
								delivery_status = 'provider_accepted', message = NULL, updated_at = CURRENT_TIMESTAMP
								WHERE item_id = ? AND status = 'processing' AND claim_token = ?`)
								.bind(receipt.provider, receipt.providerId, item.item_id, token).run();
						} finally {
							// Retain the conservative Resend cadence, including after the last
							// attempt, so a following batch cannot burst on the same provider.
							if (selectedProvider.name === 'resend') await sleep(RESEND_INTERVAL_MS);
						}
					};
					await deliver();
				} catch (error) {
					const unknown = error instanceof UnknownSendError || (submitted && !(error instanceof RejectedSendError));
					const message = unknown ? `${cleanHeader(error.message)}；投递结果未知，请核对目标邮箱，系统不会自动重发` : cleanHeader(error.message || '发送失败');
					await c.env.db.prepare(`UPDATE forward_backfill_item SET status = ?, message = ?, updated_at = CURRENT_TIMESTAMP
						WHERE item_id = ? AND status = 'processing' AND claim_token = ?`)
						.bind(unknown ? 'unknown' : 'failed', message.slice(0, 1500), item.item_id, token).run();
				}
			};
			// An unexpected receipt/ledger failure must not release the job lease while
			// another provider call is still in flight. Drain every item before finally.
			const results = await Promise.allSettled(claimed.results.map(processItem));
			const unexpectedFailure = results.find(result => result.status === 'rejected');
			if (unexpectedFailure) throw unexpectedFailure.reason;
		} finally {
			await c.env.db.prepare('UPDATE forward_backfill_job SET lease_token = NULL, lease_until = 0 WHERE job_id = ? AND lease_token = ?')
				.bind(jobId, token).run();
		}
		return snapshot(c, userId, jobId);
	},

	async retry(c, params) {
		const userId = administrator(c);
		await ensureForwardBackfillSchema(c);
		const jobId = idInput(params.jobId, '任务编号');
		const state = await snapshot(c, userId, jobId);
		const job = await ownedJob(c, userId, jobId);
		if (state.processing || job.lease_until > Date.now()) throw new BizError('任务仍在执行，请等待当前批次完成', 409);
		if (!state.failed) return state;
		const other = await c.env.db.prepare("SELECT job_id FROM forward_backfill_job WHERE user_id = ? AND status = 'running' AND job_id <> ?").bind(userId, jobId).first();
		if (other) throw new BizError('请先完成当前补转任务，再重试这个任务', 409);
		try {
			await c.env.db.batch([
				c.env.db.prepare(`UPDATE forward_backfill_job SET status = 'running', updated_at = CURRENT_TIMESTAMP
					WHERE job_id = ? AND user_id = ? AND lease_until <= ?`).bind(jobId, userId, Date.now()),
				c.env.db.prepare(`UPDATE forward_backfill_item SET status = 'pending', claim_token = NULL, started_at = NULL,
					message = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND user_id = ? AND status = 'failed'
					AND EXISTS (SELECT 1 FROM forward_backfill_job WHERE job_id = ? AND lease_until <= ?)`)
					.bind(jobId, userId, jobId, Date.now())
			]);
		} catch (error) {
			if (/UNIQUE constraint failed/.test(error.message || '')) throw new BizError('另一个补转任务已启动，请先完成当前任务', 409);
			throw error;
		}
		return snapshot(c, userId, jobId);
	}
};

// New incoming mail uses the same durable ledger so an unread but already forwarded mail is skipped.
export async function recordAutomaticForward(c, emailRow, target) {
	const userId = Number(emailRow.userId ?? emailRow.user_id);
	const accountId = Number(emailRow.accountId ?? emailRow.account_id);
	const emailId = Number(emailRow.emailId ?? emailRow.email_id);
	if (!userId || !accountId || !emailId || !ADDRESS.test(lowerAddress(target))) return;
	await ensureForwardBackfillSchema(c);
	await c.env.db.prepare(`INSERT INTO forward_backfill_item
		(job_id, user_id, email_id, account_id, target, subject, status, provider, delivery_status)
		VALUES (NULL, ?, ?, ?, ?, ?, 'sent', 'routing', 'provider_accepted')
		ON CONFLICT(email_id, target) DO UPDATE SET status = 'sent', provider = 'routing',
		delivery_status = 'provider_accepted', message = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE forward_backfill_item.status IN ('pending', 'failed')`)
		.bind(userId, emailId, accountId, lowerAddress(target), emailRow.subject || '').run();
}

// Resend delivery webhooks belong to the ledger, not to (and never mutate) the original inbox email.
export async function handleForwardBackfillWebhook(c, body) {
	const statuses = {
		'email.sent': 'provider_accepted', 'email.delivered': 'delivered', 'email.bounced': 'bounced',
		'email.complained': 'complained', 'email.delivery_delayed': 'delayed', 'email.failed': 'delivery_failed'
	};
	const deliveryStatus = statuses[body.type];
	if (!deliveryStatus || !body.data?.email_id) return false;
	await ensureForwardBackfillSchema(c);
	const result = await c.env.db.prepare(`UPDATE forward_backfill_item SET delivery_status = ?, updated_at = CURRENT_TIMESTAMP
		WHERE provider = 'resend' AND provider_id = ?`).bind(deliveryStatus, body.data.email_id).run();
	return !!result.meta.changes;
}

export default forwardBackfillService;
