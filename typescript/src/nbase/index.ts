/**
 * NBase connection-string and adapter configuration.
 *
 * NBase is configured through the connection string alone:
 *
 *    createAn5Adapter({ connectionString: 'nbase://localhost:1307' })
 *
 * Accepted forms are `nbase://host:port`, `nbase:host:port` and an explicit
 * scheme, with optional `?token=…&timeoutMs=…&method=…` options. An adapter
 * created this way is vector-only: it has no relational database, so a search
 * returns the NBase hits instead of table rows.
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

/** Matches `nbase:`, `nbase://` and `nbase=http(s)://` at the start of a value. */
const NBASE_PREFIX = /^nbase:(?:\/\/)?/i;

/** True when the whole connection string points at NBase. */
export function isNBaseConnectionString(connectionString: string): boolean {
  return NBASE_PREFIX.test(connectionString.trim());
}

/** Builds options from a URL and an optional query string. */
function buildOptions(url: string, query?: string): NBaseAdapterConfig {
  const params = new URLSearchParams(query ?? '');
  const trimmed = url.trim().replace(/\/+$/, '');
  // `nbase://host:port` is shorthand for the same host over HTTP; an explicit
  // scheme is used as-is so https deployments work.
  const withScheme = !trimmed
    ? 'http://localhost:1307'
    : /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
  return {
    url: withScheme,
    ...(params.get('token') ? { token: params.get('token') as string } : {}),
    ...(params.get('timeoutMs') ? { timeoutMs: Number(params.get('timeoutMs')) } : {}),
    ...(params.get('idField') ? { idField: params.get('idField') as string } : {}),
    ...(params.get('modelField') ? { modelField: params.get('modelField') as string } : {}),
    ...(params.get('method') ? { method: params.get('method') as 'hnsw' | 'clustered' } : {}),
  };
}

/**
 * Parses an NBase connection string.
 *
 * Accepts `nbase:http://host:port`, `nbase://host:port` and
 * `nbase:host:port`, with optional `?token=…&timeoutMs=…` options.
 */
export function parseNBaseConnectionString(connectionString: string): NBaseAdapterConfig {
  const raw = connectionString.trim();
  if (!isNBaseConnectionString(raw)) {
    throw new Error(`Not an NBase connection string: ${raw}`);
  }

  const [url, query] = raw.replace(NBASE_PREFIX, '').split('?');
  return buildOptions(url ?? '', query);
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
