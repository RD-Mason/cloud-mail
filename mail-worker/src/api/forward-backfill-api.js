import app from '../hono/hono';
import result from '../model/result';
import forwardBackfillService from '../service/forward-backfill-service';

app.post('/setting/forwardBackfill/preview', async c => {
	return c.json(result.ok(await forwardBackfillService.preview(c, await c.req.json())));
});

app.post('/setting/forwardBackfill/start', async c => {
	return c.json(result.ok(await forwardBackfillService.start(c, await c.req.json())));
});

app.post('/setting/forwardBackfill/process', async c => {
	return c.json(result.ok(await forwardBackfillService.process(c, await c.req.json())));
});

app.get('/setting/forwardBackfill/status', async c => {
	return c.json(result.ok(await forwardBackfillService.status(c, c.req.query())));
});

app.get('/setting/forwardBackfill/history', async c => {
	return c.json(result.ok(await forwardBackfillService.history(c)));
});

app.post('/setting/forwardBackfill/retry', async c => {
	return c.json(result.ok(await forwardBackfillService.retry(c, await c.req.json())));
});
