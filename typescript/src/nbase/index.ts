/**
 * NBase connection-string and adapter configuration.
 *
 * An NBase instance can be declared on the adapter directly:
 *
 *   createAn5Adapter({
 *     connectionString: 'sqlserver://…',
 *     nbase: { url: 'http://localhost:1307' },
 *   })
 *
 * …or through a connection string, which keeps the same shape as the other
 * engines:
 *
 *   nbase://localhost:1307/vectors?token=abc
 */
import {
  NBaseVectorClient,
  NBaseError,
  createNBaseVectorClient,
  type NBaseClientConfig,
  type NBaseVector,
  type NBaseSearchOptions,
  type NBaseSearchResult,
  type NBaseStats,
} from './client';

export interface NBaseAdapterConfig extends NBaseClientConfig {
  url: string;
  /**
   * Metadata key that holds the relational row id. `an5Id` by default, which
   * is what `indexTableVectors` writes.
   */
  idField?: string;
  /** Metadata key holding the model name, used to keep collections apart. */
  modelField?: string;
  /** Force the search method instead of letting NBase choose. */
  method?: 'hnsw' | 'clustered';
}

/** Parses `nbase://host:port/path?token=…` into client options. */
export function parseNBaseConnectionString(connectionString: string): NBaseAdapterConfig {
  const raw = connectionString.trim();
  if (!/^nbase:\/\//i.test(raw)) {
    throw new Error(`Not an NBase connection string: ${raw}`);
  }

  const withoutScheme = raw.replace(/^nbase:\/\//i, '');
  const [beforeQuery, query] = withoutScheme.split('?');
  const path = (beforeQuery ?? '').replace(/\/+$/, '');
  const url = path ? `http://${path}` : 'http://localhost:1307';

  const params = new URLSearchParams(query ?? '');
  return {
    url,
    ...(params.get('token') ? { token: params.get('token') as string } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
  };
}

/** Builds the vector id used to link a NBase vector back to a relational row. */
export function buildVectorId(model: string, id: string | number): string {
  return `${model}:${id}`;
}

/** Splits a vector id produced by {@link buildVectorId}. */
export function parseVectorId(vectorId: string | number): { model: string; id: string } {
  const raw = String(vectorId);
  const separator = raw.indexOf(':');
  if (separator === -1) return { model: '', id: raw };
  return { model: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

export function createNBaseClient(config: NBaseAdapterConfig | string): {
  client: NBaseVectorClient;
  options: NBaseAdapterConfig;
} {
  const options: NBaseAdapterConfig = typeof config === 'string' ? parseNBaseConnectionString(config) : config;
  return { client: createNBaseVectorClient(options), options };
}

export { NBaseVectorClient, NBaseError, createNBaseVectorClient };
export type { NBaseClientConfig, NBaseVector, NBaseSearchOptions, NBaseSearchResult, NBaseStats };
