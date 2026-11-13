import { VectorProviderError, type VectorProviderName } from './types';

export const DEFAULT_VECTOR_TIMEOUT_MS = 30_000;

export interface HttpClientOptions {
  provider: VectorProviderName;
  baseUrl: string;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
}

export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  const impl = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!impl) {
    throw new Error('No fetch implementation available. Node 18+ or a fetch polyfill is required.');
  }
  return impl;
}

export function normalizeBaseUrl(rawUrl: string, defaultScheme: 'http' | 'https' = 'http', fallbackHost?: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return fallbackHost ? `${defaultScheme}://${fallbackHost}` : '';
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `${defaultScheme}://${trimmed}`;
}

export async function requestJson<T>(
  opts: HttpClientOptions,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(opts.defaultHeaders ?? {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const detail =
        body && typeof body === 'object'
          ? ('error' in (body as Record<string, unknown>)
              ? String((body as Record<string, unknown>).error)
              : 'message' in (body as Record<string, unknown>)
                ? String((body as Record<string, unknown>).message)
                : 'status' in (body as Record<string, unknown>) && typeof (body as Record<string, unknown>).status === 'object'
                  ? JSON.stringify((body as Record<string, unknown>).status)
                  : undefined)
          : undefined;
      throw new VectorProviderError(
        opts.provider,
        `${opts.provider} request ${path} failed: ${detail ?? `HTTP ${response.status}`}`,
        response.status,
        body,
      );
    }

    return body as T;
  } catch (err) {
    if (err instanceof VectorProviderError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new VectorProviderError(
        opts.provider,
        `${opts.provider} request ${path} timed out after ${timeoutMs}ms`,
      );
    }
    throw new VectorProviderError(
      opts.provider,
      `Could not reach ${opts.provider} at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converts a similarity score (higher = more similar) into a distance
 * (lower = more similar) when the backend returns similarity for cosine/dot.
 */
export function similarityToDistance(
  score: number,
  metric: 'cosine' | 'euclidean' | 'dot' = 'cosine',
): number {
  if (metric === 'euclidean') return score;
  if (metric === 'dot') return -score;
  return 1 - score;
}
