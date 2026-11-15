import type { SqliteVectorSupport, VectorStrategyPreference } from '../sqlite/vector';

export type Dialect = 'mssql' | 'postgres' | 'mysql' | 'sqlite' | 'googlesheets';

export interface An5AdapterConfig {
  connectionString?: string;
  /**
   * NBase (Neural Vector Database) endpoint, written as a connection string,
   * e.g. `nbase://localhost:1307`. Attach it here when vector search should
   * run in NBase while the rows stay in `connectionString`'s database.
   */
  nbase?: string;
  /**
   * Path to sqlite-vec or the AN5 native vector extension. On SQLite it is loaded before the
   * vector capabilities are probed, so `vectorSearch` ranks inside the database
   * instead of loading the table into memory. Other providers ignore it.
   */
  sqliteVec?: string;
  /**
   * Pin the SQLite vector search strategy. `auto` (the default) probes for
   * sqlite-vec, a driver function and JSON1, and uses the first that works.
   */
  vectorStrategy?: VectorStrategyPreference;
  engine?: QueryEngine;
  db?: any;
  driver?: any;
  poolMax?: number;
  requestTimeout?: number;
  connectionTimeout?: number;
}

export interface TransactionHandle {
  exec<T>(query: string, params?: Record<string, any>): Promise<T[]>;
  executeRaw(query: string, params?: Record<string, any>): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface QueryEngine {
  dialect: Dialect;
  exec<T>(query: string, params?: Record<string, any>): Promise<T[]>;
  executeRaw(query: string, params?: Record<string, any>): Promise<number>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  beginTransaction(): Promise<TransactionHandle>;
  /** SQLite only: extension loading and distance-function registration. */
  vectorSupport?: SqliteVectorSupport;
}
