/**
 * Unified vector database provider types for @an5/adapters.
 *
 * Every vector database client (NBase, Qdrant, Chroma, Pinecone, Weaviate,
 * Milvus) implements {@link VectorStoreProvider} so `An5Adapter` and user code
 * can switch providers via connection string without changing query logic.
 */

export type VectorProviderName =
  | 'nbase'
  | 'qdrant'
  | 'chroma'
  | 'pinecone'
  | 'weaviate'
  | 'milvus';

export type VectorDistanceMetric = 'cosine' | 'euclidean' | 'dot';

export interface VectorRecord {
  id: string | number;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  /** Number of nearest neighbours to return (default: 10). */
  k?: number;
  /** Distance metric used to rank results. */
  distanceMetric?: VectorDistanceMetric;
  /** Provider-specific metadata filter. */
  filter?: Record<string, unknown>;
  /** Include stored metadata / payload in hits (default: true). */
  includeMetadata?: boolean;
  /** Include stored vector values in hits (default: false). */
  includeVectors?: boolean;
  /** Override the target collection / class name for this request. */
  collection?: string;
  /** Override the target namespace (Pinecone) for this request. */
  namespace?: string;
}

export interface VectorSearchHit {
  id: string | number;
  /** Distance from the query vector. Lower is more similar. */
  distance: number;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

export interface VectorHealthResult {
  ok: boolean;
  provider: VectorProviderName;
  endpoint?: string | undefined;
  status?: string | undefined;
  error?: string | undefined;
  [key: string]: unknown;
}

export interface VectorUpsertOptions {
  collection?: string | undefined;
  namespace?: string | undefined;
}

export interface VectorDeleteOptions {
  collection?: string | undefined;
  namespace?: string | undefined;
}

export interface BaseVectorClientConfig {
  /** Base HTTP(S) URL of the vector database endpoint. */
  url: string;
  /** Bearer token or API key depending on the provider. */
  token?: string | undefined;
  /** Explicit API key (alias for token on providers like Qdrant/Pinecone/Weaviate). */
  apiKey?: string | undefined;
  /** Per-request timeout in milliseconds (default: 30000). */
  timeoutMs?: number | undefined;
  /** Injectable fetch implementation for tests or custom runtimes. */
  fetchImpl?: typeof fetch | undefined;
  /** Metadata key holding the relational row id (default: 'an5Id'). */
  idField?: string | undefined;
  /** Metadata key holding the model name (default: 'an5Model'). */
  modelField?: string | undefined;
}

export class VectorProviderError extends Error {
  constructor(
    public readonly provider: VectorProviderName,
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'VectorProviderError';
  }
}

export interface VectorStoreProvider {
  readonly provider: VectorProviderName;
  readonly endpoint: string;
  readonly idField: string;
  readonly modelField: string;
  health(): Promise<VectorHealthResult>;
  upsert(vectors: VectorRecord[], options?: VectorUpsertOptions): Promise<{ count: number }>;
  search(vector: number[], options?: VectorSearchOptions): Promise<VectorSearchHit[]>;
  delete(ids: Array<string | number>, options?: VectorDeleteOptions): Promise<{ deleted: number }>;
}
