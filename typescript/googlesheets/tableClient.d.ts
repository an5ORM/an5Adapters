import type { An5SheetsAdapter } from './adapter';
export declare class SheetsTableClient<T = any> {
    private adapter;
    private modelName;
    private sheetMapping?;
    constructor(adapter: An5SheetsAdapter, modelName: string, sheetMapping?: Record<string, string> | undefined);
    private get sheetName();
    private get escSheetName();
    private get fields();
    private ensureSheetExists;
    private readAllRows;
    private getOrCreateHeaders;
    private rowToValues;
    private deleteRowByIndex;
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
    private assignId;
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
    deleteAll(): Promise<void>;
    clear(): Promise<void>;
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
