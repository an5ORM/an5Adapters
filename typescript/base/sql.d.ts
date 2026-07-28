import type { Dialect } from './types';
export declare function quote(name: string, dialect: Dialect): string;
export declare function parseWhere(modelName: string, where: any, params: Record<string, any>, dialect: Dialect, prefix?: string): string;
export declare function buildOrderBy(orderBy: any, dialect: Dialect): string;
