import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';
export declare class MysqlEngine implements QueryEngine {
    dialect: Dialect;
    private pool;
    constructor(adapterConfig: An5AdapterConfig);
    /** Convert @name → ? (positional); return ordered values */
    private transform;
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    executeRaw(query: string, params?: Record<string, any>): Promise<number>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    beginTransaction(): Promise<TransactionHandle>;
}
