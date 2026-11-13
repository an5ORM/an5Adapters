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

export interface MilvusClientConfig extends BaseVectorClientConfig {
  /** Milvus collection name (default: 'an5'). */
  collection?: string;
  /** Optional Milvus database name. */
  dbName?: string;
}

const MILVUS_PREFIX = /^milvus:(?:\/\/)?/i;

export function isMilvusConnectionString(connectionString: string): boolean {
  return MILVUS_PREFIX.test(connectionString.trim());
}

export function parseMilvusConnectionString(connectionString: string): MilvusClientConfig {
  const raw = connectionString.trim();
  if (!isMilvusConnectionString(raw)) {
    throw new Error(`Not a Milvus connection string: ${raw}`);
  }
  const [withoutPrefix, query] = raw.replace(MILVUS_PREFIX, '').split('?');
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

  const url = normalizeBaseUrl(rawUrl, 'http', 'localhost:19530');
  const token = params.get('token') ?? params.get('apiKey') ?? undefined;

  return {
    url,
    ...(collection ? { collection } : {}),
    ...(params.get('dbName') ? { dbName: params.get('dbName') as string } : {}),
    ...(token ? { token } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
  };
}

export class MilvusVectorClient implements VectorStoreProvider {
  readonly provider = 'milvus' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  private readonly collection: string;
  private readonly dbName?: string | undefined;
  private readonly token?: string | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchImpl?: typeof fetch | undefined;

  constructor(config: MilvusClientConfig) {
    this.endpoint = normalizeBaseUrl(config.url, 'http', 'localhost:19530');
    this.collection = config.collection ?? 'an5';
    this.dbName = config.dbName;
    this.token = config.token ?? config.apiKey;
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
      defaultHeaders: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
    };
  }

  private assertOk(res: { code?: number; message?: string }, path: string): void {
    if (res.code !== undefined && res.code !== 0 && res.code !== 200) {
      throw new VectorProviderError(
        this.provider,
        `milvus request ${path} failed (code ${res.code}): ${res.message ?? 'unknown error'}`,
      );
    }
  }

  async health(): Promise<VectorHealthResult> {
    try {
      const body: Record<string, unknown> = {};
      if (this.dbName) body.dbName = this.dbName;
      const res = await requestJson<{ code?: number; data?: unknown; message?: string }>(
        this.httpOpts,
        '/v2/vectordb/collections/list',
        { method: 'POST', body: JSON.stringify(body) },
      );
      this.assertOk(res, '/v2/vectordb/collections/list');
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
    const col = options?.collection ?? this.collection;
    const data = vectors.map((v) => ({
      id: v.id,
      vector: v.vector,
      ...(v.metadata ?? {}),
    }));
    const body: Record<string, unknown> = {
      collectionName: col,
      data,
    };
    if (this.dbName) body.dbName = this.dbName;

    const res = await requestJson<{ code?: number; message?: string; data?: { upsertCount?: number } }>(
      this.httpOpts,
      '/v2/vectordb/entities/upsert',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    this.assertOk(res, '/v2/vectordb/entities/upsert');
    return { count: res.data?.upsertCount ?? vectors.length };
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const col = options.collection ?? this.collection;
    const body: Record<string, unknown> = {
      collectionName: col,
      data: [vector],
      limit: options.k ?? 10,
      outputFields: options.includeMetadata === false ? ['id'] : ['*'],
    };
    if (this.dbName) body.dbName = this.dbName;
    if (options.filter && typeof options.filter.expr === 'string') {
      body.filter = options.filter.expr;
    }

    const res = await requestJson<{
      code?: number;
      message?: string;
      data?: Array<Record<string, unknown>>;
    }>(this.httpOpts, '/v2/vectordb/entities/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    this.assertOk(res, '/v2/vectordb/entities/search');

    return (res.data ?? []).map((item) => {
      const { id, distance, vector: vec, ...rest } = item;
      return {
        id: (id as string | number) ?? '',
        distance: Number(distance ?? 0),
        ...(Object.keys(rest).length > 0 ? { metadata: rest } : {}),
        ...(Array.isArray(vec) ? { vector: vec as number[] } : {}),
      };
    });
  }

  async delete(
    ids: Array<string | number>,
    options?: VectorDeleteOptions,
  ): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const col = options?.collection ?? this.collection;
    const quotedIds = ids.map((id) => (typeof id === 'number' ? String(id) : `"${String(id).replace(/"/g, '\\"')}"`));
    const body: Record<string, unknown> = {
      collectionName: col,
      filter: `id in [${quotedIds.join(', ')}]`,
    };
    if (this.dbName) body.dbName = this.dbName;

    const res = await requestJson<{ code?: number; message?: string }>(
      this.httpOpts,
      '/v2/vectordb/entities/delete',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    this.assertOk(res, '/v2/vectordb/entities/delete');
    return { deleted: ids.length };
  }
}

export function createMilvusClient(config: MilvusClientConfig | string): MilvusVectorClient {
  const opts = typeof config === 'string' ? parseMilvusConnectionString(config) : config;
  return new MilvusVectorClient(opts);
}
