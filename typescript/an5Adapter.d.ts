import { An5SheetsAdapter, An5SheetsAdapterConfig, SheetsTableClient } from './googlesheets';
import type { An5AdapterConfig, Dialect, TransactionHandle } from './base/types';
export type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
export { setAdapterMetadata, type AdapterMetadata } from './base/metadata';
export type AnyAdapter = An5Adapter | An5SheetsAdapter;
export type AnyAdapterConfig = An5AdapterConfig | An5SheetsAdapterConfig | {
    connectionString: string;
};
export declare class An5Adapter {
    private engine;
    private sheetsAdapter;
    get dialect(): Dialect;
    constructor(adapterConfig: An5AdapterConfig | An5SheetsAdapterConfig);
    private requireEngine;
    private requireSheetsAdapter;
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    /** INTERNAL: used by AdapterTableClient for DML statements needing row count */
    _executeRaw(query: string, params?: Record<string, any>): Promise<number>;
    /** Execute a raw query with positional values → @p_0, @p_1, ... per dialect */
    $queryRawUnsafe<T = any>(query: string, ...values: any[]): Promise<T[]>;
    $executeRaw(query: string, ...values: any[]): Promise<number>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
    /** Real transaction with BEGIN / COMMIT / ROLLBACK */
    $transaction<R>(fn: (tx: An5AdapterTx) => Promise<R>, options?: {
        timeout?: number;
    }): Promise<R>;
    $transaction<R>(list: Promise<R>[]): Promise<R[]>;
    table<T = any>(modelName: string): AdapterTableClient<T> | SheetsTableClient<T>;
    readRange<T = any>(range: string): Promise<T[][]>;
    writeRange(range: string, values: any[][]): Promise<void>;
    appendRange(range: string, values: any[][]): Promise<void>;
    listSheets(): Promise<string[]>;
    deleteSheet(name: string): Promise<void>;
}
export declare class An5AdapterTx {
    private readonly handle;
    readonly dialect: Dialect;
    constructor(handle: TransactionHandle, dialect: Dialect);
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    _executeRaw(query: string, params?: Record<string, any>): Promise<number>;
    table<T = any>(modelName: string): AdapterTableClient<T>;
}
export declare class AdapterTableClient<T = any> {
    private readonly adapter;
    private readonly modelName;
    constructor(adapter: An5Adapter | An5AdapterTx, modelName: string);
    private get dialect();
    private get tableName();
    private get nolock();
    private doExec;
    private doExecuteRaw;
    findMany(args?: {
        where?: any;
        orderBy?: any;
        skip?: number;
        take?: number;
        select?: any;
    }): Promise<T[]>;
    findFirst(args?: {
        where?: any;
        orderBy?: any;
        select?: any;
    }): Promise<T | null>;
    findUnique(args: {
        where: any;
    }): Promise<T | null>;
    count(args?: {
        where?: any;
    }): Promise<number>;
    create(args: {
        data: Partial<T>;
    }): Promise<T>;
    createMany(args: {
        data: Partial<T>[];
        skipDuplicates?: boolean;
    }): Promise<{
        count: number;
    }>;
    update(args: {
        where: any;
        data: Partial<T>;
    }): Promise<T>;
    updateMany(args: {
        where?: any;
        data: Partial<T>;
    }): Promise<{
        count: number;
    }>;
    delete(args: {
        where: any;
    }): Promise<T>;
    deleteMany(args?: {
        where?: any;
    }): Promise<{
        count: number;
    }>;
    upsert(args: {
        where: any;
        create: Partial<T>;
        update: Partial<T>;
    }): Promise<T>;
    aggregate(args: any): Promise<any>;
    groupBy(args: any): Promise<any[]>;
    vectorSearch(args: {
        vector: number[];
        take?: number;
        where?: any;
        vectorField?: string;
        distanceMetric?: 'cosine' | 'euclidean' | 'dot';
    }): Promise<(T & {
        distance: number;
    })[]>;
}
export declare function createAn5Adapter(config: AnyAdapterConfig): AnyAdapter;
export declare const createAdapter: typeof createAn5Adapter;
