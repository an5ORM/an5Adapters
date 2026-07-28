"use strict";
// ─── Retry helper ─────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_DELAY = exports.MAX_RETRIES = void 0;
exports.withRetry = withRetry;
exports.MAX_RETRIES = 3;
exports.BASE_DELAY = 1000;
async function withRetry(fn, attempt = 1) {
    try {
        return await fn();
    }
    catch (err) {
        const code = err?.code || err?.status || err?.response?.status;
        if ((code === 429 || code === 500 || code === 503) && attempt <= exports.MAX_RETRIES) {
            const delay = exports.BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, attempt + 1);
        }
        if (code === 403 && err?.errors?.[0]?.reason === 'rateLimitExceeded' && attempt <= exports.MAX_RETRIES) {
            const delay = exports.BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, attempt + 1);
        }
        throw err;
    }
}
