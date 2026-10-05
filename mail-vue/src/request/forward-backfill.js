import http from '@/axios/index.js';

const options = {noMsg: true, timeout: 120000};

export function previewForwardBackfill(params) {
    return http.post('/setting/forwardBackfill/preview', params, options);
}

export function startForwardBackfill(params) {
    return http.post('/setting/forwardBackfill/start', params, options);
}

export function processForwardBackfill(jobId) {
    return http.post('/setting/forwardBackfill/process', {jobId}, options);
}

export function forwardBackfillStatus(jobId) {
    return http.get('/setting/forwardBackfill/status', {
        ...options,
        params: jobId ? {jobId} : {}
    });
}

export function forwardBackfillHistory() {
    return http.get('/setting/forwardBackfill/history', options);
}

export function retryForwardBackfill(jobId) {
    return http.post('/setting/forwardBackfill/retry', {jobId}, options);
}
