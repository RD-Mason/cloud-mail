import { DatabaseSync } from 'node:sqlite';

// Execute production SQL against SQLite while exposing the asynchronous D1 shape.
export function createLocalD1() {
	const sqlite = new DatabaseSync(':memory:');

	function statement(sql, values = []) {
		const execute = (method, options = {}) => {
			const compiled = sqlite.prepare(sql);
			const result = compiled[method](...values);
			if (method === 'run') {
				return {
					success: true,
					results: [],
					meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }
				};
			}
			const rows = result.map(row => ({ ...row }));
			if (options.raw) {
				const columns = compiled.columns().map(column => column.name);
				return options.columnNames ? [columns, ...rows.map(row => columns.map(name => row[name]))] : rows.map(row => columns.map(name => row[name]));
			}
			return { success: true, results: rows, meta: { changes: 0 } };
		};

		return {
			bind: (...params) => statement(sql, params),
			run: async () => execute('run'),
			all: async () => execute('all'),
			first: async column => {
				const row = execute('all').results[0] ?? null;
				return column == null ? row : row?.[column] ?? null;
			},
			raw: async options => execute('all', { raw: true, ...options }),
			_execute: () => {
				const compiled = sqlite.prepare(sql);
				return compiled.columns().length ? execute('all') : execute('run');
			}
		};
	}

	return {
		prepare: sql => statement(sql),
		batch: async statements => {
			sqlite.exec('BEGIN');
			try {
				const result = statements.map(item => item._execute());
				sqlite.exec('COMMIT');
				return result;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		},
		exec: async sql => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		close: () => sqlite.close()
	};
}
