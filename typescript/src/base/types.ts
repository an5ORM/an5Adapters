export type Dialect = 'mssql' | 'postgres' | 'mysql' | 'sqlite' | 'googlesheets';

export interface An5AdapterConfig {
  connectionString?: string;
  /**
   * NBase (Neural Vector Database) instance used for vector search.
   * When present, similarity search runs in NBase and the matching rows are
   * read from the relational table.
   */
  nbase?: import('../nbase').NBaseAdapterConfig;
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
