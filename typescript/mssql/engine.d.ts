import sql from 'mssql';
import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';
export declare function parseMssqlConnectionString(url: string): sql.config;
export declare class MssqlEngine implements QueryEngine {
    dialect: Dialect;
    private pool;
    private config;
    constructor(adapterConfig: An5AdapterConfig);
    private getPool;
    private attachParams;
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    executeRaw(query: string, params?: Record<string, any>): Promise<number>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    beginTransaction(): Promise<TransactionHandle>;
}
