import {
  NBaseError,
  NBaseVectorClient,
  isNBaseConnectionString,
  parseNBaseConnectionString,
  type NBaseAdapterConfig,
} from '../nbase';
import { ChromaVectorClient, createChromaClient, isChromaConnectionString, parseChromaConnectionString } from './chroma';
import { MilvusVectorClient, createMilvusClient, isMilvusConnectionString, parseMilvusConnectionString } from './milvus';
import { PineconeVectorClient, createPineconeClient, isPineconeConnectionString, parsePineconeConnectionString } from './pinecone';
import { QdrantVectorClient, createQdrantClient, isQdrantConnectionString, parseQdrantConnectionString } from './qdrant';
import { WeaviateVectorClient, createWeaviateClient, isWeaviateConnectionString, parseWeaviateConnectionString } from './weaviate';
import {
  VectorProviderError,
  type VectorDeleteOptions,
  type VectorHealthResult,
  type VectorProviderName,
  type VectorRecord,
  type VectorSearchHit,
  type VectorSearchOptions,
  type VectorStoreProvider,
  type VectorUpsertOptions,
} from './types';

/**
 * Wraps {@link NBaseVectorClient} so NBase implements {@link VectorStoreProvider}
 * identically to Qdrant, Chroma, Pinecone, Weaviate and Milvus.
 */
export class NBaseVectorStoreAdapter implements VectorStoreProvider {
  readonly provider = 'nbase' as const;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;

  constructor(
    public readonly client: NBaseVectorClient,
    public readonly config: NBaseAdapterConfig,
  ) {
    this.endpoint = config.url;
    this.idField = config.idField ?? 'an5Id';
    this.modelField = config.modelField ?? 'an5Model';
  }

  async health(): Promise<VectorHealthResult> {
    try {
      const res = await this.client.health();
      return {
        ok: res.status === 'ok',
        provider: this.provider,
        endpoint: this.endpoint,
        status: res.status,
        ...(res.version ? { version: res.version } : {}),
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

  async upsert(vectors: VectorRecord[], _options?: VectorUpsertOptions): Promise<{ count: number }> {
    try {
      const res = await this.client.addVectors(vectors);
      return { count: res.count };
    } catch (err) {
      if (err instanceof NBaseError) {
        throw new VectorProviderError('nbase', err.message, err.status, err.body);
      }
      throw err;
    }
  }

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    try {
      const hits = await this.client.search(vector, {
        ...(options.k !== undefined ? { k: options.k } : {}),
        distanceMetric: options.distanceMetric === 'euclidean' ? 'euclidean' : 'cosine',
        includeMetadata: options.includeMetadata ?? true,
        ...(options.includeVectors !== undefined ? { includeVectors: options.includeVectors } : {}),
        ...(options.filter !== undefined ? { filters: options.filter } : {}),
        ...(this.config.method ? { method: this.config.method } : {}),
      });
      return hits.map((h) => ({
        id: h.id,
        distance: h.dist,
        ...(h.metadata ? { metadata: h.metadata } : {}),
        ...(h.vector ? { vector: h.vector } : {}),
      }));
    } catch (err) {
      if (err instanceof NBaseError) {
        throw new VectorProviderError('nbase', err.message, err.status, err.body);
      }
      throw err;
    }
  }

  async delete(ids: Array<string | number>, _options?: VectorDeleteOptions): Promise<{ deleted: number }> {
    try {
      let deleted = 0;
      for (const id of ids) {
        if (await this.client.delete(id)) deleted++;
      }
      return { deleted };
    } catch (err) {
      if (err instanceof NBaseError) {
        throw new VectorProviderError('nbase', err.message, err.status, err.body);
      }
      throw err;
    }
  }
}

export function detectVectorProvider(connectionString: string): VectorProviderName | null {
  const raw = connectionString.trim();
  if (isNBaseConnectionString(raw)) return 'nbase';
  if (isQdrantConnectionString(raw)) return 'qdrant';
  if (isChromaConnectionString(raw)) return 'chroma';
  if (isPineconeConnectionString(raw)) return 'pinecone';
  if (isWeaviateConnectionString(raw)) return 'weaviate';
  if (isMilvusConnectionString(raw)) return 'milvus';
  return null;
}

export function isVectorConnectionString(connectionString: string): boolean {
  return detectVectorProvider(connectionString) !== null;
}

export function createVectorStore(connectionStringOrProvider: string | VectorStoreProvider): VectorStoreProvider {
  if (typeof connectionStringOrProvider !== 'string') {
    return connectionStringOrProvider;
  }
  const provider = detectVectorProvider(connectionStringOrProvider);
  switch (provider) {
    case 'nbase': {
      const cfg = parseNBaseConnectionString(connectionStringOrProvider);
      return new NBaseVectorStoreAdapter(new NBaseVectorClient(cfg), cfg);
    }
    case 'qdrant':
      return createQdrantClient(connectionStringOrProvider);
    case 'chroma':
      return createChromaClient(connectionStringOrProvider);
    case 'pinecone':
      return createPineconeClient(connectionStringOrProvider);
    case 'weaviate':
      return createWeaviateClient(connectionStringOrProvider);
    case 'milvus':
      return createMilvusClient(connectionStringOrProvider);
    default:
      throw new Error(`Unsupported vector database connection string: ${connectionStringOrProvider}`);
  }
}

export {
  VectorProviderError,
  QdrantVectorClient,
  createQdrantClient,
  isQdrantConnectionString,
  parseQdrantConnectionString,
  ChromaVectorClient,
  createChromaClient,
  isChromaConnectionString,
  parseChromaConnectionString,
  PineconeVectorClient,
  createPineconeClient,
  isPineconeConnectionString,
  parsePineconeConnectionString,
  WeaviateVectorClient,
  createWeaviateClient,
  isWeaviateConnectionString,
  parseWeaviateConnectionString,
  MilvusVectorClient,
  createMilvusClient,
  isMilvusConnectionString,
  parseMilvusConnectionString,
};

export type {
  VectorProviderName,
  VectorDistanceMetric,
  VectorRecord,
  VectorSearchOptions,
  VectorSearchHit,
  VectorHealthResult,
  VectorUpsertOptions,
  VectorDeleteOptions,
  BaseVectorClientConfig,
  VectorStoreProvider,
} from './types';
export type { QdrantClientConfig } from './qdrant';
export type { ChromaClientConfig } from './chroma';
export type { PineconeClientConfig } from './pinecone';
export type { WeaviateClientConfig } from './weaviate';
export type { MilvusClientConfig } from './milvus';
