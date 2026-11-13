import { normalizeBaseUrl, requestJson } from './http';
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

export interface ChromaClientConfig extends BaseVectorClientConfig {
  /** Collection name (default: 'an5'). */
  collection?: string;
  /** Optional pre-resolved Chroma collection UUID. */
  collectionId?: string;
  /** Chroma tenant (default: 'default_tenant'). */
  tenant?: string;
  /** Chroma database (default: 'default_database'). */
  database?: string;
}

const CHROMA_PREFIX = /^chroma:(?:\/\/)?/i;

export function isChromaConnectionString(connectionString: string): boolean {
  return CHROMA_PREFIX.test(connectionString.trim());
}

export function parseChromaConnectionString(connectionString: string): ChromaClientConfig {
  const raw = connectionString.trim();
  if (!isChromaConnectionString(raw)) {
    throw new Error(`Not a Chroma connection string: ${raw}`);
  }
  const [withoutPrefix, query] = raw.replace(CHROMA_PREFIX, '').split('?');
  const params = new URLSearchParams(query ?? '');

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

  const url = normalizeBaseUrl(rawUrl, 'http', 'localhost:8000');
  const token = params.get('token') ?? params.get('apiKey') ?? undefined;

  return {
    url,
    ...(collection ? { collection } : {}),
    ...(params.get('collectionId') ? { collectionId: params.get('collectionId') as string } : {}),
    ...(params.get('tenant') ? { tenant: params.get('tenant') as string } : {}),
    ...(params.get('database') ? { database: params.get('database') as string } : {}),
    ...(token ? { token } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
  };
}

export class ChromaVectorClient implements VectorStoreProvider {
  readonly provider = 'chroma' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  private readonly collection: string;
  private readonly tenant: string;
  private readonly database: string;
  private readonly token?: string | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchImpl?: typeof fetch | undefined;
  private readonly collectionIds = new Map<string, string>();

  constructor(config: ChromaClientConfig) {
    this.endpoint = normalizeBaseUrl(config.url, 'http', 'localhost:8000');
    this.collection = config.collection ?? 'an5';
    this.tenant = config.tenant ?? 'default_tenant';
    this.database = config.database ?? 'default_database';
    this.token = config.token ?? config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl;
    this.idField = config.idField ?? 'an5Id';
    this.modelField = config.modelField ?? 'an5Model';
    if (config.collectionId) {
      this.collectionIds.set(this.collection, config.collectionId);
    }
  }

  private get httpOpts() {
    return {
      provider: this.provider,
      baseUrl: this.endpoint,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      defaultHeaders: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
    };
  }

  private baseCollectionPath(): string {
    return `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections`;
  }

  private async resolveCollectionId(name: string): Promise<string> {
    const cached = this.collectionIds.get(name);
    if (cached) return cached;

    try {
      const col = await requestJson<{ id: string }>(
        this.httpOpts,
        `${this.baseCollectionPath()}/${encodeURIComponent(name)}`,
      );
      if (col?.id) {
        this.collectionIds.set(name, col.id);
        return col.id;
      }
    } catch {
      // Create if not found or fallback to name
    }

    const created = await requestJson<{ id: string }>(this.httpOpts, this.baseCollectionPath(), {
      method: 'POST',
      body: JSON.stringify({ name, get_or_create: true }),
    });
    const id = created?.id ?? name;
    this.collectionIds.set(name, id);
    return id;
  }

  async health(): Promise<VectorHealthResult> {
    try {
      const res = await requestJson<Record<string, unknown>>(this.httpOpts, '/api/v2/heartbeat');
      return {
        ok: true,
        provider: this.provider,
        endpoint: this.endpoint,
        status: 'ok',
        ...res,
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
    const colId = await this.resolveCollectionId(options?.collection ?? this.collection);
    await requestJson(this.httpOpts, `${this.baseCollectionPath()}/${encodeURIComponent(colId)}/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        ids: vectors.map((v) => String(v.id)),
        embeddings: vectors.map((v) => v.vector),
        metadatas: vectors.map((v) => v.metadata ?? {}),
      }),
    });
    return { count: vectors.length };
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const colId = await this.resolveCollectionId(options.collection ?? this.collection);
    const include: string[] = ['distances'];
    if (options.includeMetadata ?? true) include.push('metadatas');
    if (options.includeVectors) include.push('embeddings');

    const body: Record<string, unknown> = {
      query_embeddings: [vector],
      n_results: options.k ?? 10,
      include,
    };
    if (options.filter) body.where = options.filter;

    const res = await requestJson<{
      ids?: string[][];
      distances?: number[][];
      metadatas?: Array<Array<Record<string, unknown> | null>>;
      embeddings?: Array<Array<number[] | null>>;
    }>(this.httpOpts, `${this.baseCollectionPath()}/${encodeURIComponent(colId)}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const ids = res.ids?.[0] ?? [];
    const distances = res.distances?.[0] ?? [];
    const metadatas = res.metadatas?.[0] ?? [];
    const embeddings = res.embeddings?.[0] ?? [];

    return ids.map((id, idx) => ({
      id,
      distance: distances[idx] ?? 0,
      ...(metadatas[idx] ? { metadata: metadatas[idx] as Record<string, unknown> } : {}),
      ...(embeddings[idx] ? { vector: embeddings[idx] as number[] } : {}),
    }));
  }

  async delete(
    ids: Array<string | number>,
    options?: VectorDeleteOptions,
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const colId = await this.resolveCollectionId(options?.collection ?? this.collection);
    await requestJson(this.httpOpts, `${this.baseCollectionPath()}/${encodeURIComponent(colId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(String) }),
    });
    return { deleted: ids.length };
  }
}

export function createChromaClient(config: ChromaClientConfig | string): ChromaVectorClient {
  const opts = typeof config === 'string' ? parseChromaConnectionString(config) : config;
  return new ChromaVectorClient(opts);
}
