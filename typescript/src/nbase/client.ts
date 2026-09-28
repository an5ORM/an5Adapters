/**
 * NBase — Neural Vector Database client.
 *
 * NBase is a vector database with HNSW/LSH/KNN indexing exposed over a REST
 * API. an5 uses it to move similarity search out of the database process: the
 * vectors live in NBase, the rows stay in the relational table, and the search
 * results are hydrated from the table by the id kept in vector metadata.
 *
 * The client only uses the global `fetch`, so it works in Node 18+ and in the
 * browser without pulling in a dependency.
 */

export interface NBaseVector {
  id: string | number;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface NBaseSearchOptions {
  /** Number of neighbours to return. */
  k?: number;
  /** Distance metric; NBase accepts `cosine` and `euclidean`. */
  distanceMetric?: 'cosine' | 'euclidean';
  /** `hnsw` uses the graph index, anything else uses the clustered path. */
  method?: 'hnsw' | 'clustered';
  efSearch?: number;
  filters?: Record<string, unknown> | Array<Record<string, unknown>>;
  includeMetadata?: boolean;
  includeVectors?: boolean;
  skipCache?: boolean;
  searchTimeoutMs?: number;
  rerank?: boolean;
  rerankingMethod?: string;
  rerankLambda?: number;
  partitionIds?: string[];
}

export interface NBaseSearchResult {
  id: string | number;
  /** Distance from the query vector. Lower is more similar. */
  dist: number;
  metadata?: Record<string, unknown>;
  vector?: number[];
  dimension?: number;
}

export interface NBaseClientConfig {
  /** Base URL, e.g. `http://localhost:1307`. */
  url: string;
  /** Optional bearer token, for deployments behind an auth proxy. */
  token?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable for tests and for runtimes without a global fetch. */
  fetchImpl?: typeof fetch;
}

export interface NBaseStats {
  vectorCount?: number;
  metadataCount?: number;
  memoryUsage?: number;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class NBaseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'NBaseError';
  }
}

export class NBaseVectorClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: NBaseClientConfig) {
    this.baseUrl = String(config.url).replace(/\/+$/, '');
    const impl = config.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!impl) {
      throw new NBaseError('No fetch implementation available. Node 18+ or a fetch polyfill is required.');
    }
    this.fetchImpl = impl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
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
        const message =
          (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
            ? String((body as Record<string, unknown>).error)
            : undefined) ?? `HTTP ${response.status}`;
        throw new NBaseError(`NBase request ${path} failed: ${message}`, response.status, body);
      }
      return body as T;
    } catch (err) {
      if (err instanceof NBaseError) throw err;
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new NBaseError(`NBase request ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new NBaseError(
        `Could not reach NBase at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness probe. NBase mounts its status routes at the server root. */
  async health(): Promise<{ status: string; version?: string }> {
    return this.request<{ status: string; version?: string }>('/health');
  }

  /** Vector count, memory use and other database statistics. */
  async stats(): Promise<NBaseStats> {
    return this.request<NBaseStats>('/stats');
  }

  /** Adds or replaces vectors. NBase accepts a single vector or a bulk array. */
  async addVectors(vectors: NBaseVector[]): Promise<{ count: number; ids?: Array<string | number> }> {
    if (vectors.length === 0) return { count: 0 };
    const result = await this.request<{ count: number; addedIds?: Array<string | number> }>(
      '/api/vectors',
      { method: 'POST', body: JSON.stringify({ vectors: vectors.length === 1 ? vectors[0] : vectors }) },
    );
    return { count: result.count ?? vectors.length, ...(result.addedIds ? { ids: result.addedIds } : {}) };
  }

  /** Nearest-neighbour search. Results are ordered by ascending `dist`. */
  async search(vector: number[], options: NBaseSearchOptions = {}): Promise<NBaseSearchResult[]> {
    const body = await this.request<{ results?: NBaseSearchResult[] }>('/api/search', {
      method: 'POST',
      body: JSON.stringify({
        query: vector,
        k: options.k ?? 10,
        ...(options.distanceMetric ? { distanceMetric: options.distanceMetric } : {}),
        ...(options.method ? { method: options.method } : {}),
        ...(options.efSearch !== undefined ? { efSearch: options.efSearch } : {}),
        ...(options.filters ? { filters: options.filters } : {}),
        ...(options.includeMetadata !== undefined ? { includeMetadata: options.includeMetadata } : {}),
        ...(options.includeVectors !== undefined ? { includeVectors: options.includeVectors } : {}),
        ...(options.skipCache !== undefined ? { skipCache: options.skipCache } : {}),
        ...(options.searchTimeoutMs !== undefined ? { searchTimeoutMs: options.searchTimeoutMs } : {}),
        ...(options.rerank !== undefined ? { rerank: options.rerank } : {}),
        ...(options.rerankingMethod ? { rerankingMethod: options.rerankingMethod } : {}),
        ...(options.rerankLambda !== undefined ? { rerankLambda: options.rerankLambda } : {}),
        ...(options.partitionIds ? { partitionIds: options.partitionIds } : {}),
      }),
    });
    return body.results ?? [];
  }

  /** Reads a single vector. Returns undefined when the id is unknown. */
  async get(id: string | number): Promise<NBaseSearchResult | undefined> {
    try {
      return await this.request<NBaseSearchResult>(`/api/vectors/${encodeURIComponent(String(id))}`);
    } catch (err) {
      if (err instanceof NBaseError && err.status === 404) return undefined;
      throw err;
    }
  }

  async exists(id: string | number): Promise<boolean> {
    const result = await this.request<{ exists?: boolean }>(
      `/api/vectors/${encodeURIComponent(String(id))}/exists`,
    );
    return result.exists === true;
  }

  async delete(id: string | number): Promise<boolean> {
    await this.request(`/api/vectors/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    return true;
  }

  async updateMetadata(id: string | number, metadata: Record<string, unknown>): Promise<boolean> {
    await this.request(`/api/vectors/${encodeURIComponent(String(id))}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify(metadata),
    });
    return true;
  }
}

/** Creates an NBase vector client. */
export function createNBaseVectorClient(config: NBaseClientConfig): NBaseVectorClient {
  return new NBaseVectorClient(config);
}
