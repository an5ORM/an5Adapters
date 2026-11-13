import { normalizeBaseUrl, requestJson } from './http';
import {
  VectorProviderError,
  type BaseVectorClientConfig,
  type VectorDeleteOptions,
  type VectorHealthResult,
  type VectorRecord,
  type VectorSearchHit,
  type VectorSearchOptions,
  type VectorStoreProvider,
  type VectorUpsertOptions,
} from './types';

export interface WeaviateClientConfig extends BaseVectorClientConfig {
  /** Weaviate class name (default: 'An5Vector'). */
  className?: string;
}

const WEAVIATE_PREFIX = /^weaviate:(?:\/\/)?/i;

export function isWeaviateConnectionString(connectionString: string): boolean {
  return WEAVIATE_PREFIX.test(connectionString.trim());
}

export function parseWeaviateConnectionString(connectionString: string): WeaviateClientConfig {
  const raw = connectionString.trim();
  if (!isWeaviateConnectionString(raw)) {
    throw new Error(`Not a Weaviate connection string: ${raw}`);
  }
  const [withoutPrefix, query] = raw.replace(WEAVIATE_PREFIX, '').split('?');
  const params = new URLSearchParams(query ?? '');

  let rawUrl = (withoutPrefix ?? '').trim().replace(/\/+$/, '');
  let className = params.get('className') ?? params.get('collection') ?? undefined;
  if (rawUrl && !/^[a-z]+:\/\//i.test(rawUrl)) {
    const slashIdx = rawUrl.indexOf('/');
    if (slashIdx !== -1) {
      const pathPart = rawUrl.slice(slashIdx + 1);
      if (pathPart && !className) {
        className = pathPart;
      }
      rawUrl = rawUrl.slice(0, slashIdx);
    }
  }

  const url = normalizeBaseUrl(rawUrl, 'http', 'localhost:8080');
  const apiKey = params.get('apiKey') ?? params.get('token') ?? undefined;

  return {
    url,
    ...(className ? { className } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
  };
}

export class WeaviateVectorClient implements VectorStoreProvider {
  readonly provider = 'weaviate' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  private readonly className: string;
  private readonly apiKey?: string | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchImpl?: typeof fetch | undefined;

  constructor(config: WeaviateClientConfig) {
    this.endpoint = normalizeBaseUrl(config.url, 'http', 'localhost:8080');
    this.className = config.className ?? 'An5Vector';
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
      defaultHeaders: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
    };
  }

  async health(): Promise<VectorHealthResult> {
    try {
      await requestJson(this.httpOpts, '/v1/.well-known/ready');
      return {
        ok: true,
        provider: this.provider,
        endpoint: this.endpoint,
        status: 'ok',
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
    const cls = options?.collection ?? this.className;
    const objects = vectors.map((v) => ({
      class: cls,
      id: String(v.id),
      vector: v.vector,
      properties: v.metadata ?? {},
    }));
    await requestJson(this.httpOpts, '/v1/batch/objects', {
      method: 'POST',
      body: JSON.stringify({ objects }),
    });
    return { count: vectors.length };
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const cls = options.collection ?? this.className;
    const limit = options.k ?? 10;
    const extraFields = ['id', 'distance'];
    if (options.includeVectors) extraFields.push('vector');

    const propFields = options.includeMetadata === false ? '' : `${this.idField} ${this.modelField} `;
    const query = `{ Get { ${cls}(nearVector: { vector: ${JSON.stringify(vector)} }, limit: ${limit}) { ${propFields}_additional { ${extraFields.join(' ')} } } } }`;

    const res = await requestJson<{
      data?: { Get?: Record<string, Array<Record<string, unknown>>> };
      errors?: Array<{ message: string }>;
    }>(this.httpOpts, '/v1/graphql', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });

    if (res.errors && res.errors.length > 0) {
      throw new VectorProviderError(
        this.provider,
        `weaviate graphql error: ${res.errors.map((e) => e.message).join('; ')}`,
      );
    }

    const items = res.data?.Get?.[cls] ?? [];
    return items.map((item) => {
      const additional = (item._additional as Record<string, unknown> | undefined) ?? {};
      const { _additional, ...props } = item;
      return {
        id: String(additional.id ?? ''),
        distance: Number(additional.distance ?? 0),
        ...(Object.keys(props).length > 0 ? { metadata: props } : {}),
        ...(Array.isArray(additional.vector) ? { vector: additional.vector as number[] } : {}),
      };
    });
  }

  async delete(
    ids: Array<string | number>,
    options?: VectorDeleteOptions,
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const cls = options?.collection ?? this.className;
    for (const id of ids) {
      await requestJson(
        this.httpOpts,
        `/v1/objects/${encodeURIComponent(cls)}/${encodeURIComponent(String(id))}`,
        { method: 'DELETE' },
      );
    }
    return { deleted: ids.length };
  }
}

export function createWeaviateClient(config: WeaviateClientConfig | string): WeaviateVectorClient {
  const opts = typeof config === 'string' ? parseWeaviateConnectionString(config) : config;
  return new WeaviateVectorClient(opts);
}
