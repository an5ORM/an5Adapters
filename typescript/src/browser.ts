// Browser-safe entry — supports in-browser SQLite (sql.js / WASM / custom driver) and Google Sheets
export { An5SheetsAdapter, SheetsTableClient, createAn5SheetsAdapter, parseSheetsConnectionString } from './googlesheets';
export type { An5SheetsAdapterConfig } from './googlesheets';
export { SqliteBrowserEngine, createBrowserSqliteAdapter } from './sqlite/browserEngine';
export type { SqliteDriver, SqliteBrowserConfig } from './sqlite/browserEngine';
export { An5Adapter, createAn5Adapter, createAdapter } from './an5Adapter';
export type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
export { getFieldsForModel, getModelToTable, setAdapterMetadata } from './base/metadata';
export type { AdapterMetadata } from './base/metadata';

