import { normalizeBaseUrl, requestJson, similarityToDistance } from './http';
import type {
  BaseVectorClientConfig,
  VectorDeleteOptions,
  VectorHealthResult,
  VectorRecord,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStoreProvider,
  VectorUpsertOptions,
} from './types';

export interface QdrantClientConfig extends BaseVectorClientConfig {
  /** Default collection name (default: 'an5'). */
  collection?: string;
}

const QDRANT_PREFIX = /^qdrant:(?:\/\/)?/i;

export function isQdrantConnectionString(connectionString: string): boolean {
  return QDRANT_PREFIX.test(connectionString.trim());
}

export function parseQdrantConnectionString(connectionString: string): QdrantClientConfig {
  const raw = connectionString.trim();
  if (!isQdrantConnectionString(raw)) {
    throw new Error(`Not a Qdrant connection string: ${raw}`);
  }
  const [withoutPrefix, query] = raw.replace(QDRANT_PREFIX, '').split('?');
  const params = new URLSearchParams(query ?? '');

  // Extract optional trailing /collection if the host doesn't already have a scheme+path,
  // or read ?collection=...
  let rawUrl = (withoutPrefix ?? '').trim().replace(/\/+$/, '');
  let collection = params.get('collection') ?? undefined;
  if (rawUrl && !/^[a-z]+:\/\//i.test(rawUrl)) {
    const slashIdx = rawUrl.indexOf('/');
    if (slashIdx !== -1) {
      const pathPart = rawUrl.slice(slashIdx + 1);
      if (pathPart && !collection) {
        collection = pathPart;
      }
      rawUrl = rawUrl.slice(0, slashIdx);
    }
  }

  const url = normalizeBaseUrl(rawUrl, 'http', 'localhost:6333');
  const apiKey = params.get('apiKey') ?? params.get('token') ?? undefined;

  return {
    url,
    ...(collection ? { collection } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
  };
}

export class QdrantVectorClient implements VectorStoreProvider {
  readonly provider = 'qdrant' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  private readonly collection: string;
  private readonly apiKey?: string | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchImpl?: typeof fetch | undefined;

  constructor(config: QdrantClientConfig) {
    this.endpoint = normalizeBaseUrl(config.url, 'http', 'localhost:6333');
    this.collection = config.collection ?? 'an5';
    this.apiKey = config.apiKey ?? config.token;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl;
    this.idField = config.idField ?? 'an5Id';
    this.modelField = config.modelField ?? 'an5Model';
  }

  private get httpOpts() {
    return {
      provider: this.provider,
      baseUrl: this.endpoint,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      defaultHeaders: this.apiKey ? { 'api-key': this.apiKey } : undefined,
    };
  }

  async health(): Promise<VectorHealthResult> {
    try {
      const res = await requestJson<{ title?: string; version?: string; status?: string }>(
        this.httpOpts,
        '/healthz',
      );
      return {
        ok: true,
        provider: this.provider,
        endpoint: this.endpoint,
        status: res?.status ?? 'ok',
        ...(res?.version ? { version: res.version } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.provider,
        endpoint: this.endpoint,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createCollection(
    name: string,
    dimension: number,
    distance: 'Cosine' | 'Euclid' | 'Dot' = 'Cosine',
  ): Promise<void> {
    await requestJson(this.httpOpts, `/collections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: dimension, distance },
      }),
    });
  }

  async upsert(
    vectors: VectorRecord[],
    options?: VectorUpsertOptions,
  ): Promise<{ count: number }> {
    if (vectors.length === 0) return { count: 0 };
    const col = options?.collection ?? this.collection;
    const points = vectors.map((v) => ({
      id: v.id,
      vector: v.vector,
      ...(v.metadata ? { payload: v.metadata } : {}),
    }));
    await requestJson(
      this.httpOpts,
      `/collections/${encodeURIComponent(col)}/points?wait=true`,
      {
        method: 'PUT',
        body: JSON.stringify({ points }),
      },
    );
    return { count: vectors.length };
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const col = options.collection ?? this.collection;
    const metric = options.distanceMetric ?? 'cosine';
    const body: Record<string, unknown> = {
      vector,
      limit: options.k ?? 10,
      with_payload: options.includeMetadata ?? true,
      with_vector: options.includeVectors ?? false,
    };
    if (options.filter) body.filter = options.filter;

    const res = await requestJson<{
      result?: Array<{
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
        vector?: number[];
      }>;
    }>(this.httpOpts, `/collections/${encodeURIComponent(col)}/points/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return (res.result ?? []).map((item) => ({
      id: item.id,
      distance: similarityToDistance(item.score, metric),
      ...(item.payload ? { metadata: item.payload } : {}),
      ...(item.vector ? { vector: item.vector } : {}),
    }));
  }

  async delete(
    ids: Array<string | number>,
    options?: VectorDeleteOptions,
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const col = options?.collection ?? this.collection;
    await requestJson(
      this.httpOpts,
      `/collections/${encodeURIComponent(col)}/points/delete?wait=true`,
      {
        method: 'POST',
        body: JSON.stringify({ points: ids }),
      },
    );
    return { deleted: ids.length };
  }
}

export function createQdrantClient(config: QdrantClientConfig | string): QdrantVectorClient {
  const opts = typeof config === 'string' ? parseQdrantConnectionString(config) : config;
  return new QdrantVectorClient(opts);
}
