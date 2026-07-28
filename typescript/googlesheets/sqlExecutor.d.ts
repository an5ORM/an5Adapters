import type { An5SheetsAdapter } from './adapter';
export type ExecResult = any[] | number;
export declare function execQuery(adapter: An5SheetsAdapter, query: string, params: Record<string, any> | undefined, _modelMap?: Record<string, string>, _sheetId?: string): Promise<ExecResult>;
export declare function substParams(sql: string, params?: Record<string, any>): {
    text: string;
    values: any[];
};
export declare function matchRowSQL(row: Record<string, any>, whereText: string, values: any[]): boolean;
export declare function extractColsAndVals(sql: string, params?: Record<string, any>): {
    cols: string[];
    vals: any[];
};
