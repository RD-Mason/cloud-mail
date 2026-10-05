// Keep these statements additive and idempotent: existing mail/attachment tables are untouched.
export const FORWARD_BACKFILL_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS forward_backfill_job (
		job_id TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL DEFAULT 0,
		start_time TEXT,
		end_time TEXT,
		cutoff_id INTEGER NOT NULL,
		targets TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'running',
		lease_token TEXT,
		lease_until INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE TABLE IF NOT EXISTS forward_backfill_item (
		item_id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT,
		user_id INTEGER NOT NULL,
		email_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		target TEXT NOT NULL COLLATE NOCASE,
		subject TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'pending',
		attempts INTEGER NOT NULL DEFAULT 0,
		claim_token TEXT,
		started_at INTEGER,
		provider TEXT,
		provider_id TEXT,
		delivery_status TEXT,
		message TEXT,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(email_id, target)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_forward_backfill_job_user ON forward_backfill_job(user_id, created_at)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_forward_backfill_active_user ON forward_backfill_job(user_id) WHERE status = 'running'`,
	`CREATE INDEX IF NOT EXISTS idx_forward_backfill_item_job ON forward_backfill_item(job_id, status, item_id)`,
	`CREATE INDEX IF NOT EXISTS idx_forward_backfill_item_provider ON forward_backfill_item(provider, provider_id)`
];
