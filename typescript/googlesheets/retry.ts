// ─── Retry helper ─────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const BASE_DELAY = 1000;

export async function withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const code = err?.code || err?.status || err?.response?.status;
    if ((code === 429 || code === 500 || code === 503) && attempt <= MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, attempt + 1);
    }
    if (code === 403 && err?.errors?.[0]?.reason === 'rateLimitExceeded' && attempt <= MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}
