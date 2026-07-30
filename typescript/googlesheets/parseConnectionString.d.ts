import type { An5SheetsAdapterConfig } from './config';
/**
 * Parse a `googlesheets://` connection string into An5SheetsAdapterConfig.
 *
 * Format:
 *   googlesheets://spreadsheetId;clientEmail=xxx;privateKey=xxx
 *   googlesheets://spreadsheetId;clientEmail=xxx;privateKey=xxx;sheetMapping=users:Users,orders:Orders
 *
 * The privateKey must be URL-encoded (use encodeURIComponent on the raw key).
 */
export declare function parseSheetsConnectionString(url: string): An5SheetsAdapterConfig;
