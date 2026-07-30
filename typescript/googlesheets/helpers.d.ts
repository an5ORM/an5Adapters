export declare function esc(name: string): string;
export declare function resolveSheetName(modelName: string, mapping?: Record<string, string>): string;
export declare function matchWhere(row: Record<string, any>, where: any): boolean;
export declare function buildOrderBy(orderBy: any): string;
export declare function sortRows(rows: Record<string, any>[], orderBy: string): Record<string, any>[];
export declare function coerceCell(raw: any, fieldMeta?: {
    ts?: string;
    sql?: string;
}): any;
