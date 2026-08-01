// Browser-safe entry — no SQL engine imports
export { An5SheetsAdapter, SheetsTableClient, createAn5SheetsAdapter, parseSheetsConnectionString } from './googlesheets';
export type { An5SheetsAdapterConfig } from './googlesheets';
export type { An5AdapterConfig, Dialect } from './base/types';
export { getFieldsForModel, getModelToTable, setAdapterMetadata } from './base/metadata';
export type { AdapterMetadata } from './base/metadata';
