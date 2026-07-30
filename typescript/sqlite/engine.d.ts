import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';
export declare class SqliteEngine implements QueryEngine {
    dialect: Dialect;
    private db;
    private readonly filePath;
    constructor(adapterConfig: An5AdapterConfig);
    private getDb;
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    executeRaw(query: string, params?: Record<string, any>): Promise<number>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    beginTransaction(): Promise<TransactionHandle>;
}
