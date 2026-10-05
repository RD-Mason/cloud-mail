import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/forward-backfill.integration.spec.js'],
		fileParallelism: false,
	},
});
