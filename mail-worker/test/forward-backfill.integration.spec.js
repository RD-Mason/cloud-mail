import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalD1 } from './helpers/local-d1';
import { FORWARD_BACKFILL_SCHEMA } from '../src/lib/forward-backfill-schema';
import forwardBackfillService, { handleForwardBackfillWebhook, recordAutomaticForward } from '../src/service/forward-backfill-service';

const mocks = vi.hoisted(() => ({
	settings: {},
	cloudflareSend: vi.fn(),
	resendSend: vi.fn(),
	getObject: vi.fn()
}));

vi.mock('../src/service/setting-service', () => ({
	default: { query: vi.fn(async () => mocks.settings) }
}));
vi.mock('../src/security/user-context', () => ({
	default: {
		getUser: c => c.get('user'),
		getUserId: c => c.get('user').userId
	}
}));
vi.mock('../src/service/r2-service', () => ({
	default: { getObj: (...args) => mocks.getObject(...args) }
}));
vi.mock('resend', () => ({
	Resend: class {
		constructor() { this.emails = { send: (...args) => mocks.resendSend(...args) }; }
	}
}));

let db;
let c;

async function seedEmail({ emailId = 1, userId = 1, accountId = 1, unread = 0, type = 0, isDel = 0, content = '<p>Original body</p>', subject = 'Original subject' } = {}) {
	await db.prepare(`INSERT INTO email (email_id, user_id, account_id, unread, type, is_del, content, subject,
		send_email, name, to_email, to_name, text, message_id, create_time, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sender@external.example', 'Original Sender', 'tech@example.com', '',
		'Original body', ?, '2026-10-04 12:00:00', 0)`).bind(emailId, userId, accountId, unread, type, isDel, content, subject, `<original-${emailId}@external.example>`).run();
}

async function originalEmail(emailId = 1) {
	return db.prepare('SELECT * FROM email WHERE email_id = ?').bind(emailId).first();
}

async function startJob(params = {}) {
	const preview = await forwardBackfillService.preview(c, params);
	return forwardBackfillService.start(c, { ...params, cutoffId: preview.cutoffId, targets: preview.targets });
}

beforeEach(async () => {
	vi.clearAllMocks();
	db = createLocalD1();
	await db.exec(`CREATE TABLE email (
		email_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
		unread INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0, is_del INTEGER NOT NULL DEFAULT 0,
		send_email TEXT, name TEXT, subject TEXT, content TEXT, text TEXT, to_email TEXT, to_name TEXT,
		message_id TEXT, in_reply_to TEXT DEFAULT '', relation TEXT DEFAULT '', cc TEXT DEFAULT '[]',
		bcc TEXT DEFAULT '[]', recipient TEXT DEFAULT '[]', status INTEGER DEFAULT 0, code TEXT DEFAULT '',
		resend_email_id TEXT, message TEXT, create_time TEXT NOT NULL
	);
	CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, name TEXT,
		status INTEGER DEFAULT 0, is_del INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, all_receive INTEGER DEFAULT 0);
	CREATE TABLE user (user_id INTEGER PRIMARY KEY, email TEXT, type INTEGER DEFAULT 1, is_del INTEGER DEFAULT 0);
	CREATE TABLE attachments (att_id INTEGER PRIMARY KEY, user_id INTEGER, email_id INTEGER,
		account_id INTEGER, key TEXT, filename TEXT, mime_type TEXT, size INTEGER,
		type INTEGER DEFAULT 0, status INTEGER DEFAULT 0, content_id TEXT, disposition TEXT,
		related TEXT, encoding TEXT, create_time TEXT DEFAULT CURRENT_TIMESTAMP);
	INSERT INTO account (account_id,user_id,email,name) VALUES (1,1,'tech@example.com','Tech'), (2,2,'other@example.com','Other');
	INSERT INTO user (user_id,email) VALUES (1,'admin@example.com'), (2,'other@example.com');`);
	await db.batch(FORWARD_BACKFILL_SCHEMA.map(sql => db.prepare(sql)));
	mocks.settings = {
		forwardStatus: 0,
		forwardEmail: 'destination@gmail.com',
		ruleType: 0,
		ruleEmail: '',
		domainList: ['@example.com'],
		r2Domain: 'https://mail.example.com',
		resendTokens: {},
		send: 0
	};
	mocks.cloudflareSend.mockResolvedValue({ messageId: 'cf-provider-id' });
	mocks.resendSend.mockResolvedValue({ data: { id: 'resend-provider-id' }, error: null });
	mocks.getObject.mockResolvedValue(null);
	c = {
		env: {
			db,
			admin: 'admin@example.com',
			domain: ['example.com'],
			backfill_email: { send: (...args) => mocks.cloudflareSend(...args) }
		},
		get: key => key === 'user' ? { userId: 1, email: 'admin@example.com' } : undefined
	};
});

afterEach(() => db?.close());

describe('history forwarding with real SQLite and mocked email providers', () => {
	it('can apply the additive migration twice without changing stored mail', async () => {
		await seedEmail();
		const before = await originalEmail();
		await db.batch(FORWARD_BACKFILL_SCHEMA.map(sql => db.prepare(sql)));
		expect(await originalEmail()).toEqual(before);
	});

	it('creates missing forwarding tables on first use without changing the original mailbox', async () => {
		await seedEmail();
		const original = await originalEmail();
		await db.exec('DROP TABLE forward_backfill_item; DROP TABLE forward_backfill_job;');
		// A new binding wrapper represents a cold Worker isolate, with no cached schema initialization.
		c.env.db = { ...db };
		expect(await forwardBackfillService.status(c, {})).toBe(null);
		expect(await forwardBackfillService.preview(c, {})).toMatchObject({ total: 1, deliveryTotal: 1 });
		const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'forward_backfill_%' ORDER BY name").all()).results;
		expect(tables).toEqual([{ name: 'forward_backfill_item' }, { name: 'forward_backfill_job' }]);
		expect(await originalEmail()).toEqual(original);
	});

	it('limits an administrator to their own unread, received, undeleted mail', async () => {
		await seedEmail();
		await seedEmail({ emailId: 2, unread: 1 });
		await seedEmail({ emailId: 3, type: 1 });
		await seedEmail({ emailId: 4, isDel: 1 });
		await seedEmail({ emailId: 5, userId: 2, accountId: 2 });
		await seedEmail({ emailId: 6, userId: 1, accountId: 2 });
		expect(await forwardBackfillService.preview(c, {})).toMatchObject({ total: 1, deliveryTotal: 1, selectedTotal: 1 });
		await expect(forwardBackfillService.preview(c, { accountId: 2 })).rejects.toThrow('只能补转');
		const unauthorized = { ...c, get: () => ({ userId: 2, email: 'other@example.com' }) };
		await expect(forwardBackfillService.preview(unauthorized, {})).rejects.toThrow('只有管理员');
	});

	it('does not let another administrator context inspect, process, or retry someone else\'s job', async () => {
		await seedEmail();
		const job = await startJob();
		const other = {
			...c,
			env: { ...c.env, admin: 'other@example.com' },
			get: () => ({ userId: 2, email: 'other@example.com' })
		};
		for (const action of ['status', 'process', 'retry']) {
			await expect(forwardBackfillService[action](other, { jobId: job.jobId })).rejects.toThrow('不属于当前账号');
		}
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
	});

	it('keeps the preview cutoff so newer mail is not included when the task starts', async () => {
		await seedEmail();
		const preview = await forwardBackfillService.preview(c, {});
		await seedEmail({ emailId: 2 });
		const job = await forwardBackfillService.start(c, { cutoffId: preview.cutoffId, targets: preview.targets });
		expect(job).toMatchObject({ total: 1, sourceTotal: 1 });
		expect((await db.prepare('SELECT email_id FROM forward_backfill_item WHERE job_id = ?').bind(job.jobId).all()).results)
			.toEqual([{ email_id: 1 }]);
	});

	it('allocates only one job when two start requests race', async () => {
		await seedEmail();
		const preview = await forwardBackfillService.preview(c, {});
		const params = { cutoffId: preview.cutoffId, targets: preview.targets };
		const results = await Promise.allSettled([
			forwardBackfillService.start(c, params), forwardBackfillService.start(c, params)
		]);
		expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
		expect((await db.prepare('SELECT COUNT(*) AS total FROM forward_backfill_job').first()).total).toBe(1);
		expect((await db.prepare('SELECT COUNT(*) AS total FROM forward_backfill_item').first()).total).toBe(1);
	});

	it('sends once across concurrent processing requests and leaves original mail unchanged', async () => {
		await seedEmail();
		const original = await originalEmail();
		const job = await startJob();
		await Promise.all([
			forwardBackfillService.process(c, { jobId: job.jobId }),
			forwardBackfillService.process(c, { jobId: job.jobId })
		]);
		expect(mocks.cloudflareSend).toHaveBeenCalledTimes(1);
		expect(await forwardBackfillService.status(c, { jobId: job.jobId }))
			.toMatchObject({ sent: 1, pending: 0, failed: 0, status: 'completed', deliveryConfirmed: false });
		expect(await originalEmail()).toEqual(original);
	});

	it('skips a successful mail/target across later jobs even while the original remains unread', async () => {
		await seedEmail();
		const first = await startJob();
		await forwardBackfillService.process(c, { jobId: first.jobId });
		await seedEmail({ emailId: 2 });
		expect(await forwardBackfillService.preview(c, {})).toMatchObject({ total: 1, alreadySent: 1, selectedTotal: 2 });
		const second = await startJob();
		await forwardBackfillService.process(c, { jobId: second.jobId });
		expect(mocks.cloudflareSend).toHaveBeenCalledTimes(2);
		expect((await db.prepare('SELECT COUNT(*) AS total FROM forward_backfill_item WHERE email_id = 1').first()).total).toBe(1);
		expect((await originalEmail()).unread).toBe(0);
	});

	it('keeps older failed jobs in history and allows retry after a newer job finishes', async () => {
		await seedEmail();
		mocks.cloudflareSend.mockRejectedValueOnce(Object.assign(new Error('Recipient is not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' }));
		const first = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: first.jobId })).toMatchObject({ failed: 1 });
		await seedEmail({ emailId: 2 });
		const second = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: second.jobId })).toMatchObject({ sent: 1, status: 'completed' });
		const history = await forwardBackfillService.history(c);
		expect(history.jobs.map(job => job.jobId)).toEqual([second.jobId, first.jobId]);
		expect(history.jobs.find(job => job.jobId === first.jobId)).toMatchObject({ failed: 1 });
		expect(await forwardBackfillService.status(c, { jobId: first.jobId })).toMatchObject({ failed: 1 });
		expect(await forwardBackfillService.retry(c, { jobId: first.jobId })).toMatchObject({ pending: 1, failed: 0 });
		expect(await forwardBackfillService.process(c, { jobId: first.jobId })).toMatchObject({ sent: 1, status: 'completed' });
		expect(mocks.cloudflareSend).toHaveBeenCalledTimes(3);
	});

	it('excludes mail already forwarded by the automatic incoming handler', async () => {
		await seedEmail();
		await recordAutomaticForward(c, { emailId: 1, userId: 1, accountId: 1, subject: 'Original subject' }, 'Destination@Gmail.com');
		await recordAutomaticForward(c, { emailId: 1, userId: 1, accountId: 1, subject: 'Original subject' }, 'destination@gmail.com');
		expect(await forwardBackfillService.preview(c, {})).toMatchObject({ total: 0, deliveryTotal: 0, alreadySent: 1 });
		expect((await db.prepare('SELECT COUNT(*) AS total FROM forward_backfill_item').first()).total).toBe(1);
		expect((await originalEmail()).unread).toBe(0);
	});

	it('allows retry after an explicit Cloudflare rejection reported through error.code', async () => {
		await seedEmail();
		mocks.cloudflareSend.mockRejectedValueOnce(Object.assign(new Error('Recipient address is not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' }));
		const job = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: job.jobId }))
			.toMatchObject({ failed: 1, unknown: 0, status: 'completed_with_errors' });
		expect(await forwardBackfillService.retry(c, { jobId: job.jobId })).toMatchObject({ pending: 1, failed: 0 });
		expect(await forwardBackfillService.process(c, { jobId: job.jobId })).toMatchObject({ sent: 1, failed: 0 });
		expect(mocks.cloudflareSend).toHaveBeenCalledTimes(2);
	});

	it('does not retry a provider call with an ambiguous network result', async () => {
		await seedEmail();
		mocks.cloudflareSend.mockRejectedValueOnce(new Error('Connection interrupted'));
		const job = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: job.jobId }))
			.toMatchObject({ unknown: 1, failed: 0, status: 'needs_review' });
		expect(await forwardBackfillService.retry(c, { jobId: job.jobId })).toMatchObject({ unknown: 1, pending: 0 });
		await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(mocks.cloudflareSend).toHaveBeenCalledTimes(1);
	});

	it('falls back to Resend, retries an explicit rejection, and routes delivery webhooks only to the forwarding ledger', async () => {
		await seedEmail();
		const original = await originalEmail();
		delete c.env.backfill_email;
		mocks.settings.resendTokens = { 'example.com': 're_test_local_only' };
		mocks.resendSend.mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Slow down' } });
		const job = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: job.jobId })).toMatchObject({ failed: 1, unknown: 0 });
		await forwardBackfillService.retry(c, { jobId: job.jobId });
		expect(await forwardBackfillService.process(c, { jobId: job.jobId })).toMatchObject({ sent: 1 });
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
		expect(mocks.resendSend).toHaveBeenCalledTimes(2);
		const [form, options] = mocks.resendSend.mock.calls[1];
		expect(form.from).toContain('<tech@example.com>');
		expect(form.replyTo).toBe('sender@external.example');
		expect(options.idempotencyKey).toBeTypeOf('string');
		expect(await handleForwardBackfillWebhook(c, { type: 'email.delivered', data: { email_id: 'resend-provider-id' } })).toBe(true);
		expect((await db.prepare('SELECT delivery_status FROM forward_backfill_item WHERE job_id = ?').bind(job.jobId).first()).delivery_status).toBe('delivered');
		expect(await originalEmail()).toEqual(original);
	});

	it('retries only failed targets after a partially successful batch', async () => {
		await seedEmail();
		mocks.settings.forwardEmail = 'first@gmail.com, second@gmail.com';
		mocks.cloudflareSend.mockImplementation(async form => {
			if (form.to === 'second@gmail.com') {
				throw Object.assign(new Error('Recipient is not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
			}
			return { messageId: `receipt-${form.to}` };
		});
		const job = await startJob();
		expect(await forwardBackfillService.process(c, { jobId: job.jobId }))
			.toMatchObject({ total: 2, sent: 1, failed: 1, unknown: 0 });
		mocks.cloudflareSend.mockResolvedValue({ messageId: 'second-receipt' });
		expect(await forwardBackfillService.retry(c, { jobId: job.jobId })).toMatchObject({ sent: 1, pending: 1 });
		expect(await forwardBackfillService.process(c, { jobId: job.jobId })).toMatchObject({ sent: 2, failed: 0 });
		expect(mocks.cloudflareSend.mock.calls.map(([form]) => form.to))
			.toEqual(['first@gmail.com', 'second@gmail.com', 'second@gmail.com']);
	});

	it('requires manual review after an interrupted sending lease instead of silently resending', async () => {
		await seedEmail();
		const job = await startJob();
		await db.prepare(`UPDATE forward_backfill_job SET lease_token = 'interrupted-worker', lease_until = ? WHERE job_id = ?`)
			.bind(Date.now() - 1, job.jobId).run();
		await db.prepare(`UPDATE forward_backfill_item SET status = 'processing', claim_token = 'interrupted-worker', attempts = 1 WHERE job_id = ?`)
			.bind(job.jobId).run();
		expect(await forwardBackfillService.status(c, { jobId: job.jobId }))
			.toMatchObject({ unknown: 1, processing: 0, status: 'needs_review' });
		await forwardBackfillService.retry(c, { jobId: job.jobId });
		await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
		expect((await originalEmail()).unread).toBe(0);
	});

	it('marks an orphaned processing item as unknown even when its job lease was already released', async () => {
		await seedEmail();
		const job = await startJob();
		await db.prepare("UPDATE forward_backfill_job SET lease_token = NULL, lease_until = 0 WHERE job_id = ?")
			.bind(job.jobId).run();
		await db.prepare("UPDATE forward_backfill_item SET status = 'processing', claim_token = 'previous-worker', attempts = 1 WHERE job_id = ?")
			.bind(job.jobId).run();
		expect(await forwardBackfillService.status(c, { jobId: job.jobId }))
			.toMatchObject({ unknown: 1, processing: 0, status: 'needs_review' });
		expect(await forwardBackfillService.retry(c, { jobId: job.jobId })).toMatchObject({ unknown: 1, pending: 0 });
		await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
		expect((await originalEmail()).unread).toBe(0);
	});

	it('rechecks unread status immediately before sending a queued email', async () => {
		await seedEmail();
		const job = await startJob();
		await db.prepare('UPDATE email SET unread = 1 WHERE email_id = 1').run();
		const state = await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(state).toMatchObject({ sent: 0, failed: 1 });
		expect(state.errors[0].message).toContain('已读');
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
		expect((await originalEmail()).unread).toBe(1);
	});

	it('refuses the entire email when a stored attachment is missing', async () => {
		await seedEmail();
		await db.prepare(`INSERT INTO attachments (att_id,user_id,email_id,account_id,key,filename,mime_type,size)
			VALUES (1,1,1,1,'attachments/missing.pdf','missing.pdf','application/pdf',3)`).run();
		const job = await startJob();
		const state = await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(state).toMatchObject({ failed: 1, sent: 0 });
		expect(state.errors[0].message).toContain('整封邮件未发送');
		expect(mocks.cloudflareSend).not.toHaveBeenCalled();
		expect((await originalEmail()).unread).toBe(0);
	});

	it('reconstructs embedded images and ordinary attachments, uses the owned sender, and preserves unread state', async () => {
		await seedEmail({ content: '<p>Original body</p><img src="{{domain}}attachments/image.png">' });
		await db.exec(`INSERT INTO attachments (att_id,user_id,email_id,account_id,key,filename,mime_type,size,type,content_id)
			VALUES (1,1,1,1,'attachments/image.png','image.png','image/png',3,1,'<original-image>'),
			(2,1,1,1,'attachments/file.pdf','file.pdf','application/pdf',3,0,NULL);`);
		mocks.getObject.mockImplementation(async () => new Uint8Array([1, 2, 3]).buffer);
		const job = await startJob();
		const state = await forwardBackfillService.process(c, { jobId: job.jobId });
		expect(state).toMatchObject({ sent: 1, failed: 0 });
		const form = mocks.cloudflareSend.mock.calls[0][0];
		expect(form.from.email).toBe('tech@example.com');
		expect(form.replyTo).toBe('sender@external.example');
		expect(form.html).toContain('cid:original-image');
		expect(form.html).not.toContain('{{domain}}');
		expect(form.text).toContain('sender@external.example');
		expect(form.attachments).toHaveLength(2);
		expect(form.attachments.find(item => item.filename === 'image.png'))
			.toMatchObject({ contentId: 'original-image', disposition: 'inline', type: 'image/png' });
		expect(form.attachments.find(item => item.filename === 'file.pdf'))
			.toMatchObject({ disposition: 'attachment', type: 'application/pdf' });
		expect((await originalEmail()).unread).toBe(0);
	});
});
