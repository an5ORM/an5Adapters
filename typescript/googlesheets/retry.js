"use strict";
// ─── Rate Limit & Retry helper ─────────────────────────────────────────────────
//
// Google Sheets API quota (default): 100 requests per 100 seconds per project.
// Strategy:
//   1. Token-bucket rate limiter  — proactively throttles before hitting quota
//   2. Concurrency limiter         — max N parallel requests to avoid burst
//   3. Exponential backoff + jitter — reactive recovery when 429/403/5xx hit
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConcurrencyLimiter = exports.TokenBucket = exports.RATE_LIMIT_RPS = exports.MAX_CONCURRENCY = exports.MAX_DELAY = exports.BASE_DELAY = exports.MAX_RETRIES = void 0;
exports.withRetry = withRetry;
// ─── Config ────────────────────────────────────────────────────────────────────
exports.MAX_RETRIES = 5;
exports.BASE_DELAY = 1000; // ms
exports.MAX_DELAY = 32000; // ms cap for backoff
exports.MAX_CONCURRENCY = 4; // parallel in-flight requests
exports.RATE_LIMIT_RPS = 0.9; // tokens/second (stay under 1 req/s safely)
// ─── Token Bucket ──────────────────────────────────────────────────────────────
class TokenBucket {
    constructor(ratePerSecond, capacity) {
        this.ratePerMs = ratePerSecond / 1000;
        this.capacity = capacity;
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }
    /** Wait until a token is available, then consume one. */
    async acquire() {
        while (true) {
            const now = Date.now();
            const elapsed = now - this.lastRefill;
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
            this.lastRefill = now;
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            // Wait for enough time to refill one token
            const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
}
exports.TokenBucket = TokenBucket;
// ─── Concurrency Limiter ───────────────────────────────────────────────────────
class ConcurrencyLimiter {
    constructor(max) {
        this.max = max;
        this.running = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.running < this.max) {
            this.running++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
        this.running++;
    }
    release() {
        this.running--;
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        }
    }
}
exports.ConcurrencyLimiter = ConcurrencyLimiter;
// ─── Singleton shared across all adapter instances ─────────────────────────────
const _bucket = new TokenBucket(exports.RATE_LIMIT_RPS, 10);
const _concurrency = new ConcurrencyLimiter(exports.MAX_CONCURRENCY);
// ─── Error classification ──────────────────────────────────────────────────────
function isRetryableError(err) {
    const code = err?.code || err?.status || err?.response?.status;
    if (code === 429)
        return true;
    if (code === 500 || code === 503 || code === 502)
        return true;
    if (code === 403) {
        const reason = err?.errors?.[0]?.reason || '';
        if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
            return true;
        if (typeof err?.body === 'string' && err.body.includes('rateLimitExceeded'))
            return true;
        if (typeof err?.message === 'string' && err.message.includes('rateLimitExceeded'))
            return true;
    }
    return false;
}
function getRetryDelay(err, attempt) {
    // Honour server-provided Retry-After
    if (err?.retryAfter)
        return err.retryAfter * 1000;
    // Full jitter exponential backoff: random in [0, min(cap, base * 2^attempt)]
    const cap = Math.min(exports.MAX_DELAY, exports.BASE_DELAY * Math.pow(2, attempt));
    return Math.random() * cap;
}
// ─── Public API ────────────────────────────────────────────────────────────────
async function withRetry(fn, attempt = 1) {
    await _bucket.acquire();
    await _concurrency.acquire();
    try {
        return await fn();
    }
    catch (err) {
        if (isRetryableError(err) && attempt <= exports.MAX_RETRIES) {
            const delay = getRetryDelay(err, attempt);
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, attempt + 1);
        }
        throw err;
    }
    finally {
        _concurrency.release();
    }
}
