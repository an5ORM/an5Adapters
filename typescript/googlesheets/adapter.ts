import { google, sheets_v4 } from 'googleapis';
import { An5SheetsAdapterConfig, resolveConfig } from './config';
import { execQuery } from './sqlExecutor';
import { SheetsTableClient } from './tableClient';
import { SheetMeta } from './types';
import { withRetry } from './retry';

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class An5SheetsAdapter {
  private sheets: sheets_v4.Sheets | null = null;
  config: ReturnType<typeof resolveConfig>;
  private sheetsCache: Promise<SheetMeta[]> | null = null;

  constructor(config: An5SheetsAdapterConfig) {
    this.config = resolveConfig(config);
  }

  async getSheets(): Promise<sheets_v4.Sheets> {
    if (!this.sheets) {
      const auth = new google.auth.JWT({
        email: this.config.clientEmail,
        key: this.config.privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
    }
    return this.sheets;
  }

  private async getApi() {
    return this.getSheets();
  }

  invalidateCache(): void {
    this.sheetsCache = null;
  }

  async listSheets(): Promise<string[]> {
    const api = await this.getApi();
    const res = await withRetry(() =>
      api.spreadsheets.get({
        spreadsheetId: this.config.spreadsheetId,
        fields: 'sheets.properties.title',
      })
    );
    return (res.data.sheets || []).map(s => s.properties?.title || '');
  }

  async getSheetMeta(name: string): Promise<SheetMeta | null> {
    const api = await this.getApi();
    if (this.sheetsCache == null) {
      this.sheetsCache = withRetry(async () => {
        const res = await api.spreadsheets.get({
          spreadsheetId: this.config.spreadsheetId,
          fields: 'sheets.properties',
        });
        return (res.data.sheets || []).map(s => ({
          sheetId: s.properties?.sheetId ?? -1,
          title: s.properties?.title ?? '',
        })).filter(m => m.sheetId >= 0);
      });
    }
    const all = await this.sheetsCache;
    return all.find(m => m.title === name) || null;
  }

  async deleteSheet(name: string): Promise<void> {
    const meta = await this.getSheetMeta(name);
    if (!meta) throw new Error(`Sheet "${name}" not found`);
    const api = await this.getApi();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: meta.sheetId } }],
        },
      })
    );
    this.invalidateCache();
  }

  async $connect(): Promise<void> {
    await this.getSheets();
  }

  async $disconnect(): Promise<void> {
    this.sheets = null;
    this.sheetsCache = null;
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    return execQuery(this, query, params, undefined, undefined) as Promise<T[]>;
  }

  async $queryRawUnsafe<T = any>(query: string, ...values: any[]): Promise<T[]> {
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    const resolved = query.replace(/@p_(\d+)/g, (_, i) => `@p_${i}`);
    return execQuery(this, resolved, params, undefined, undefined) as Promise<T[]>;
  }

  async $executeRaw(query: string, ...values: any[]): Promise<number> {
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    const resolved = query.replace(/@p_(\d+)/g, (_, i) => `@p_${i}`);
    return execQuery(this, resolved, params, undefined, undefined) as Promise<number>;
  }

  async $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
    return this.$executeRaw(query, ...values);
  }

  async $transaction<R>(fn: (tx: An5SheetsAdapter) => Promise<R>, _options?: { timeout?: number }): Promise<R>;
  async $transaction<R>(list: Promise<R>[]): Promise<R[]>;
  async $transaction(fn: any, _options?: any): Promise<any> {
    if (typeof fn === 'function') return fn(this);
    return Promise.all(fn);
  }

  table<T = any>(modelName: string): SheetsTableClient<T> {
    return new SheetsTableClient<T>(this, modelName, this.config.sheetMapping);
  }

  // ── Raw range access ──────────────────────────────────────────────────────

  async readRange<T = any>(range: string): Promise<T[][]> {
    const api = await this.getApi();
    const res = await withRetry(() =>
      api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range,
      })
    );
    return (res.data.values || []) as T[][];
  }

  async writeRange(range: string, values: any[][]): Promise<void> {
    const api = await this.getApi();
    await withRetry(() =>
      api.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      })
    );
  }

  async appendRange(range: string, values: any[][]): Promise<void> {
    const api = await this.getApi();
    await withRetry(() =>
      api.spreadsheets.values.append({
        spreadsheetId: this.config.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      })
    );
  }
}
// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAn5SheetsAdapter(config: An5SheetsAdapterConfig): An5SheetsAdapter {
  return new An5SheetsAdapter(config);
}
