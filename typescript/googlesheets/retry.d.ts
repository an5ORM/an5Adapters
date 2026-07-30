export declare const MAX_RETRIES = 3;
export declare const BASE_DELAY = 1000;
export declare function withRetry<T>(fn: () => Promise<T>, attempt?: number): Promise<T>;
