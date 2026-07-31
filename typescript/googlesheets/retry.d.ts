export declare const MAX_RETRIES = 5;
export declare const BASE_DELAY = 1000;
export declare const MAX_DELAY = 32000;
export declare const MAX_CONCURRENCY = 4;
export declare const RATE_LIMIT_RPS = 0.9;
declare class TokenBucket {
    private tokens;
    private lastRefill;
    private readonly ratePerMs;
    private readonly capacity;
    constructor(ratePerSecond: number, capacity: number);
    /** Wait until a token is available, then consume one. */
    acquire(): Promise<void>;
}
declare class ConcurrencyLimiter {
    private readonly max;
    private running;
    private queue;
    constructor(max: number);
    acquire(): Promise<void>;
    release(): void;
}
export declare function withRetry<T>(fn: () => Promise<T>, attempt?: number): Promise<T>;
/** Expose for testing / custom configurations */
export { TokenBucket, ConcurrencyLimiter };
