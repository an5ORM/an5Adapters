import { An5SheetsAdapterConfig, resolveConfig } from './config';
import { SheetsTableClient } from './tableClient';
import { SheetMeta } from './types';
export declare class An5SheetsAdapter {
    private sheets;
    private fetchApi;
    config: ReturnType<typeof resolveConfig>;
    private sheetsCache;
    constructor(config: An5SheetsAdapterConfig);
    private get isOAuth();
    getSheets(): Promise<any>;
    private getApi;
    invalidateCache(): void;
    listSheets(): Promise<string[]>;
    getSheetMeta(name: string): Promise<SheetMeta | null>;
    deleteSheet(name: string): Promise<void>;
    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
    exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]>;
    $queryRawUnsafe<T = any>(query: string, ...values: any[]): Promise<T[]>;
    $executeRaw(query: string, ...values: any[]): Promise<number>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
    $transaction<R>(fn: (tx: An5SheetsAdapter) => Promise<R>, _options?: {
        timeout?: number;
    }): Promise<R>;
    $transaction<R>(list: Promise<R>[]): Promise<R[]>;
    table<T = any>(modelName: string): SheetsTableClient<T>;
    readRange<T = any>(range: string): Promise<T[][]>;
    writeRange(range: string, values: any[][]): Promise<void>;
    appendRange(range: string, values: any[][]): Promise<void>;
}
export declare function createAn5SheetsAdapter(config: An5SheetsAdapterConfig): An5SheetsAdapter;
