import { An5SheetsAdapterConfig, resolveConfig } from './config';
import type { sheets_v4 } from 'googleapis';
import { execQuery } from './sqlExecutor';
import { SheetsTableClient } from './tableClient';
import { SheetMeta } from './types';
import { withRetry } from './retry';

// ─── Fetch-based API proxy for OAuth Access Token / API Key (browser-compatible) ──

function createFetchApi(spreadsheetId: string, accessToken?: string, apiKey?: string) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  async function request<T>(method: string, path: string, body?: any): Promise<T> {
    let url = path.startsWith('http') ? path : `${base}${path}`;
    if (apiKey) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}key=${encodeURIComponent(apiKey)}`;
    }
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Google Sheets API error (${res.status}): ${text}`);
      (err as any).status = res.status;
      (err as any).body = text;
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter) (err as any).retryAfter = parseInt(retryAfter, 10);
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as T);
  }

  function fmtRange(range: string): string {
    return `/${encodeURIComponent(range)}`;
  }

  return {
    spreadsheets: {
      get: async (params: any) => {
        const data = await request<any>('GET', `?fields=${params.fields || ''}`);
        return { data };
      },
      batchUpdate: async (params: any) => {
        const data = await request<any>('POST', ':batchUpdate', params.requestBody);
        return { data };
      },
      values: {
        get: async (params: any) => {
          const data = await request<any>('GET', fmtRange(params.range));
          return { data };
        },
        update: async (params: any) => {
          const qs = `?valueInputOption=${params.valueInputOption || 'RAW'}`;
          const data = await request<any>('PUT', `${fmtRange(params.range)}${qs}`, params.requestBody);
          return { data };
        },
        append: async (params: any) => {
          const qs = `?valueInputOption=${params.valueInputOption || 'RAW'}&insertDataOption=${params.insertDataOption || 'INSERT_ROWS'}`;
          await request<any>('POST', `${fmtRange(params.range)}:append${qs}`, params.requestBody);
          return { data: { updates: { updatedRows: (params.requestBody?.values || []).length } } };
        },
        clear: async (params: any) => {
          await request<any>('POST', `${fmtRange(params.range)}:clear`);
          return { data: {} };
        },
      },
    },
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class An5SheetsAdapter {
  private sheets: sheets_v4.Sheets | null = null;
  private fetchApi: ReturnType<typeof createFetchApi> | null = null;
  config: ReturnType<typeof resolveConfig>;
  private sheetsCache: Promise<SheetMeta[]> | null = null;

  constructor(config: An5SheetsAdapterConfig) {
    this.config = resolveConfig(config);
  }

  private get isFetchMode(): boolean {
    return !!(this.config as any).accessToken || !!(this.config as any).apiKey;
  }

  async getSheets(): Promise<any> {
    if (this.isFetchMode) {
      if (!this.fetchApi) {
        this.fetchApi = createFetchApi(
          this.config.spreadsheetId,
          (this.config as any).accessToken,
          (this.config as any).apiKey
        );
      }
      return this.fetchApi;
    }
    const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
    if (isBrowser) {
      throw new Error(
        'Google Sheets adapter in browser mode requires "accessToken" or "apiKey" configuration.'
      );
    }
    if (!this.sheets) {
      const { google } = await import('googleapis');
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
    const res: any = await withRetry(() =>
      api.spreadsheets.get({
        spreadsheetId: this.config.spreadsheetId,
        fields: 'sheets.properties.title',
      })
    );
    return (res.data.sheets || []).map((s: any) => s.properties?.title || '');
  }

  async getSheetMeta(name: string): Promise<SheetMeta | null> {
    const api = await this.getApi();
    if (this.sheetsCache == null) {
      this.sheetsCache = withRetry(async () => {
        const res: any = await api.spreadsheets.get({
          spreadsheetId: this.config.spreadsheetId,
          fields: 'sheets.properties',
        });
        return (res.data.sheets || []).map((s: any) => ({
          sheetId: s.properties?.sheetId ?? -1,
          title: s.properties?.title ?? '',
        })).filter((m: SheetMeta) => m.sheetId >= 0);
      });
    }
    const all = await this.sheetsCache;
    return all.find((m: SheetMeta) => m.title === name) || null;
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
    this.fetchApi = null;
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
    const res: any = await withRetry(() =>
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
