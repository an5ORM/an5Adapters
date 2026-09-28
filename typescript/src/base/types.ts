export type Dialect = 'mssql' | 'postgres' | 'mysql' | 'sqlite' | 'googlesheets';

export interface An5AdapterConfig {
  connectionString?: string;
  /**
   * NBase (Neural Vector Database) endpoint, written as a connection string,
   * e.g. `nbase://localhost:1307`. Attach it here when vector search should
   * run in NBase while the rows stay in `connectionString`'s database.
   */
  nbase?: string;
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
}
