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

export interface PineconeClientConfig extends BaseVectorClientConfig {
  /** Optional Pinecone namespace. */
  namespace?: string;
}

const PINECONE_PREFIX = /^pinecone:(?:\/\/)?/i;

export function isPineconeConnectionString(connectionString: string): boolean {
  return PINECONE_PREFIX.test(connectionString.trim());
}

export function parsePineconeConnectionString(connectionString: string): PineconeClientConfig {
  const raw = connectionString.trim();
  if (!isPineconeConnectionString(raw)) {
    throw new Error(`Not a Pinecone connection string: ${raw}`);
  }
  const [withoutPrefix, query] = raw.replace(PINECONE_PREFIX, '').split('?');
  const params = new URLSearchParams(query ?? '');

  let rawUrl = (withoutPrefix ?? '').trim().replace(/\/+$/, '');
  let namespace = params.get('namespace') ?? undefined;
  if (rawUrl && !/^[a-z]+:\/\//i.test(rawUrl)) {
    const slashIdx = rawUrl.indexOf('/');
    if (slashIdx !== -1) {
      const pathPart = rawUrl.slice(slashIdx + 1);
      if (pathPart && !namespace) {
        namespace = pathPart;
      }
      rawUrl = rawUrl.slice(0, slashIdx);
    }
  }

  const url = normalizeBaseUrl(rawUrl, 'https', 'localhost');
  const apiKey = params.get('apiKey') ?? params.get('token') ?? undefined;

  return {
    url,
    ...(namespace ? { namespace } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
  };
}

export class PineconeVectorClient implements VectorStoreProvider {
  readonly provider = 'pinecone' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  private readonly namespace?: string | undefined;
  private readonly apiKey?: string | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchImpl?: typeof fetch | undefined;

  constructor(config: PineconeClientConfig) {
    this.endpoint = normalizeBaseUrl(config.url, 'https', 'localhost');
    this.namespace = config.namespace;
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
      const stats = await requestJson<Record<string, unknown>>(
        this.httpOpts,
        '/describe_index_stats',
        { method: 'POST', body: JSON.stringify({}) },
      );
      return {
        ok: true,
        provider: this.provider,
        endpoint: this.endpoint,
        status: 'ok',
        ...stats,
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

  async upsert(
    vectors: VectorRecord[],
    options?: VectorUpsertOptions,
  ): Promise<{ count: number }> {
    if (vectors.length === 0) return { count: 0 };
    const ns = options?.namespace ?? this.namespace;
    const body: Record<string, unknown> = {
      vectors: vectors.map((v) => ({
        id: String(v.id),
        values: v.vector,
        ...(v.metadata ? { metadata: v.metadata } : {}),
      })),
    };
    if (ns) body.namespace = ns;

    const res = await requestJson<{ upsertedCount?: number }>(this.httpOpts, '/vectors/upsert', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { count: res.upsertedCount ?? vectors.length };
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const ns = options.namespace ?? this.namespace;
    const metric = options.distanceMetric ?? 'cosine';
    const body: Record<string, unknown> = {
      vector,
      topK: options.k ?? 10,
      includeMetadata: options.includeMetadata ?? true,
      includeValues: options.includeVectors ?? false,
    };
    if (ns) body.namespace = ns;
    if (options.filter) body.filter = options.filter;

    const res = await requestJson<{
      matches?: Array<{
        id: string;
        score?: number;
        metadata?: Record<string, unknown>;
        values?: number[];
      }>;
    }>(this.httpOpts, '/query', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return (res.matches ?? []).map((m) => ({
      id: m.id,
      distance: similarityToDistance(m.score ?? 0, metric),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(m.values ? { vector: m.values } : {}),
    }));
  }

  async delete(
    ids: Array<string | number>,
    options?: VectorDeleteOptions,
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const ns = options?.namespace ?? this.namespace;
    const body: Record<string, unknown> = {
      ids: ids.map(String),
    };
    if (ns) body.namespace = ns;

    await requestJson(this.httpOpts, '/vectors/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { deleted: ids.length };
  }
}

export function createPineconeClient(config: PineconeClientConfig | string): PineconeVectorClient {
  const opts = typeof config === 'string' ? parsePineconeConnectionString(config) : config;
  return new PineconeVectorClient(opts);
}
