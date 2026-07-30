"use strict";
// ─── Retry helper ─────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_DELAY = exports.MAX_RETRIES = void 0;
exports.withRetry = withRetry;
exports.MAX_RETRIES = 3;
exports.BASE_DELAY = 1000;
function isRateLimitError(err) {
    const code = err?.code || err?.status || err?.response?.status;
    if (code === 429)
        return true;
    if (code === 500 || code === 503)
        return true;
    if (code === 403) {
        const reason = err?.errors?.[0]?.reason || '';
        if (reason === 'rateLimitExceeded')
            return true;
        if (typeof err?.body === 'string' && err.body.includes('rateLimitExceeded'))
            return true;
        if (typeof err?.message === 'string' && err.message.includes('rateLimitExceeded'))
            return true;
    }
    return false;
}
async function withRetry(fn, attempt = 1) {
    try {
        return await fn();
    }
    catch (err) {
        if (isRateLimitError(err) && attempt <= exports.MAX_RETRIES) {
            const delay = err.retryAfter
                ? err.retryAfter * 1000
                : exports.BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, attempt + 1);
        }
        throw err;
    }
}
