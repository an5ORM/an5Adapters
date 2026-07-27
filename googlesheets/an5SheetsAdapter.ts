import { google, sheets_v4 } from 'googleapis';
import { randomUUID } from 'crypto';
import { modelToTable, modelFields } from 'an5-client/typescript/an5Metadata';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface An5SheetsAdapterConfig {
  spreadsheetId: string;
  clientEmail?: string;
  privateKey?: string;
  credentials?: { client_email: string; private_key: string };
  sheetMapping?: Record<string, string>;
}

function normalizeKey(key: string): string {
  if (key.includes('PRIVATE KEY')) return key;
  const lines = key.split('\\n').join('\n');
  if (lines.includes('PRIVATE KEY')) return lines;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function resolveConfig(config: An5SheetsAdapterConfig) {
  if (config.credentials) {
    return {
      spreadsheetId: config.spreadsheetId,
      clientEmail: config.credentials.client_email,
      privateKey: normalizeKey(config.credentials.private_key),
      sheetMapping: config.sheetMapping,
    };
  }
  return {
    spreadsheetId: config.spreadsheetId,
    clientEmail: config.clientEmail!,
    privateKey: normalizeKey(config.privateKey!),
    sheetMapping: config.sheetMapping,
  };
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;

async function withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const code = err?.code || err?.status || err?.response?.status;
    if ((code === 429 || code === 500 || code === 503) && attempt <= MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, attempt + 1);
    }
    if (code === 403 && err?.errors?.[0]?.reason === 'rateLimitExceeded' && attempt <= MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface SheetMeta {
  sheetId: number;
  title: string;
}

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

// ─── SQL query executor ───────────────────────────────────────────────────────

type ExecResult = any[] | number;

async function execQuery(adapter: An5SheetsAdapter, query: string, params: Record<string, any> | undefined, _modelMap?: Record<string, string>, _sheetId?: string): Promise<ExecResult> {
  const q = query.trim();
  const upper = q.toUpperCase();

  if (upper.startsWith('SELECT')) return execSelect(adapter, q, params);
  if (upper.startsWith('INSERT')) return execInsert(adapter, q, params);
  if (upper.startsWith('UPDATE')) return execUpdate(adapter, q, params);
  if (upper.startsWith('DELETE')) return execDelete(adapter, q, params);

  // Fallback: treat as raw range or sheet name
  const range = q.includes('!') ? q : esc(q) + '!A:ZZ';
  const raw = await adapter.readRange(range);
  return raw;
}

function substParams(sql: string, params?: Record<string, any>): { text: string; values: any[] } {
  if (!params) return { text: sql, values: [] };
  const values: any[] = [];
  const text = sql.replace(/@(\w+)/g, (_, name) => {
    if (params[name] !== undefined) {
      const idx = values.length;
      values.push(params[name]);
      return `?${idx}`;
    }
    return `@${name}`;
  });
  return { text, values };
}

function matchRowSQL(row: Record<string, any>, whereText: string, values: any[]): boolean {
  if (!whereText) return true;
  const trimmed = whereText.trim();

  // Handle simple AND conditions: field = ?0 AND field2 = ?1
  const parts = trimmed.split(/\s+AND\s+/i);
  for (const part of parts) {
    const m = part.match(/^(.+?)\s*(=|!=|<>|>|<|>=|<=|LIKE|CONTAINS)\s*(.+)$/i);
    if (!m) continue;
    const field = m[1].trim().replace(/[[\]]/g, '');
    const op = m[2].toUpperCase();
    const valRef = m[3].trim();

    const val = valRef.startsWith('?') ? values[parseInt(valRef.slice(1))] : valRef.replace(/^['"]|['"]$/g, '');
    const cell = row[field];

    switch (op) {
      case '=': if (cell != val) return false; break;
      case '!=': case '<>': if (cell == val) return false; break;
      case '>': if (!(Number(cell) > Number(val))) return false; break;
      case '<': if (!(Number(cell) < Number(val))) return false; break;
      case '>=': if (!(Number(cell) >= Number(val))) return false; break;
      case '<=': if (!(Number(cell) <= Number(val))) return false; break;
      case 'LIKE': if (!cell || !String(cell).toLowerCase().includes(String(val).toLowerCase().replace(/%/g, ''))) return false; break;
      case 'CONTAINS': if (!cell || !String(cell).includes(String(val))) return false; break;
    }
  }
  return true;
}

function extractColsAndVals(sql: string, params?: Record<string, any>): { cols: string[]; vals: any[] } {
  const cols: string[] = [];
  const vals: any[] = [];

  const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (colMatch) {
    const rawCols = colMatch[1].split(',').map(c => c.trim().replace(/[[\]]/g, ''));
    // Find actual values
    const valMatch = sql.substring(colMatch.index! + colMatch[0].length).match(/\(([^)]+)\)/);
    if (valMatch) {
      const rawVals = valMatch[1].split(',').map(v => v.trim());
      for (let i = 0; i < rawCols.length; i++) {
        cols.push(rawCols[i]);
        const rv = rawVals[i];
        if (rv.startsWith('@') && params && params[rv.slice(1)] !== undefined) {
          vals.push(params[rv.slice(1)]);
        } else {
          vals.push(rv.replace(/^['"]|['"]$/g, ''));
        }
      }
    }
  }
  return { cols, vals };
}

async function execSelect(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<any[]> {
  const m = query.match(/SELECT\s+(.+?)\s+FROM\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:WHERE\s+(.+))?$/i);
  if (!m) {
    // Try reading as raw range
    const raw = await adapter.readRange(esc(query.replace(/^SELECT\s+\*\s+FROM\s+/i, '').trim()) + '!A:ZZ');
    const headers = raw[0] || [];
    return raw.slice(1).map(r => {
      const obj: any = {};
      headers.forEach((h: any, i: number) => { obj[h] = r[i] ?? null; });
      return obj;
    });
  }

  const sheetName = m[2] || m[3] || m[4];
  const whereClause = m[5];

  const raw = await adapter.readRange(esc(sheetName) + '!A:ZZ');
  if (raw.length < 1) return [];

  const headers = raw[0] as string[];
  const fieldList = m[1].trim();
  const selectAll = fieldList === '*';

  const rows = raw.slice(1).map(row => {
    const obj: any = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
    return obj;
  });

  if (!whereClause) return selectAll ? rows : rows.map(r => pickFields(r, fieldList, headers));
  const { text, values } = substParams(query, params);
  // Extract just the WHERE part
  const whereParts = query.match(/WHERE\s+(.+)$/i);
  const whereText = whereParts ? whereParts[1] : '';
  const { text: whereSubst, values: whereVals } = substParams(whereText, params);

  const result = rows.filter(r => matchRowSQL(r, whereSubst, whereVals));
  return selectAll ? result : result.map(r => pickFields(r, fieldList, headers));
}

function pickFields(row: any, fieldList: string, headers: string[]): any {
  const fields = fieldList.split(',').map(f => f.trim().replace(/[[\]]/g, ''));
  const obj: any = {};
  fields.forEach(f => { obj[f] = row[f]; });
  return obj;
}

async function execInsert(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/INSERT\s+INTO\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(.*)/i);
  if (!m) throw new Error('Invalid INSERT syntax');

  const sheetName = m[1] || m[2] || m[3];
  const { cols, vals } = extractColsAndVals(query, params);
  if (cols.length === 0) throw new Error('Cannot extract columns from INSERT');

  // Ensure headers exist
  const raw = await adapter.readRange(esc(sheetName) + '!A1:ZZ1');
  const existingHeaders = (raw[0] || []) as string[];
  let headers = existingHeaders.length > 0 ? existingHeaders : cols;

  if (existingHeaders.length === 0) {
    // Write headers first
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.values.update({
        spreadsheetId: adapter.config.spreadsheetId,
        range: esc(sheetName) + '!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [cols] },
      })
    );
    headers = cols;
  }

  const rowData: any = {};
  cols.forEach((c, i) => { rowData[c] = vals[i]; });
  for (const h of headers) { if (rowData[h] === undefined) rowData[h] = null; }

  const rowVals = headers.map(h => {
    const v = rowData[h];
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  });

  await adapter.appendRange(esc(sheetName) + '!A:A', [rowVals]);
  return 1;
}

async function execUpdate(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/UPDATE\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
  if (!m) throw new Error('Invalid UPDATE syntax');

  const sheetName = m[1] || m[2] || m[3];
  const setClause = m[4];
  const whereClause = m[5];

  // Parse SET clause
  const setPairs = setClause.split(',').map(p => p.trim());
  const setFields: string[] = [];
  const setVals: any[] = [];
  for (const pair of setPairs) {
    const sm = pair.match(/^(\w+)\s*=\s*(.+)$/i);
    if (!sm) continue;
    setFields.push(sm[1].replace(/[[\]]/g, ''));
    const rv = sm[2].trim();
    if (rv.startsWith('@') && params && params[rv.slice(1)] !== undefined) {
      setVals.push(params[rv.slice(1)]);
    } else {
      setVals.push(rv.replace(/^['"]|['"]$/g, ''));
    }
  }

  // Read data
  const range = esc(sheetName) + '!A:ZZ';
  const raw = await adapter.readRange(range);
  if (raw.length < 1) return 0;

  const headers = raw[0] as string[];
  const rows = raw.slice(1);

  // Determine which rows to update
  const { text: whereSubst, values: whereVals } = substParams(whereClause || '', params);
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = {};
    headers.forEach((h, j) => { row[h] = rows[i][j] ?? null; });
    row.__row = i + 2;

    if (whereClause && !matchRowSQL(row, whereSubst, whereVals)) continue;

    // Apply SET values
    setFields.forEach((f, idx) => { row[f] = setVals[idx]; });
    const updated = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString();
      return String(v);
    });

    await adapter.writeRange(esc(sheetName) + `!A${row.__row}`, [updated]);
    count++;
  }
  return count;
}

async function execDelete(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/DELETE\s+FROM\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:WHERE\s+(.+))?$/i);
  if (!m) throw new Error('Invalid DELETE syntax');

  const sheetName = m[1] || m[2] || m[3];
  const whereClause = m[4];

  const meta = await adapter.getSheetMeta(sheetName);
  if (!meta) return 0;

  if (!whereClause) {
    // Delete all rows (keep headers)
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 999999 },
            },
          }],
        },
      })
    );
    return -1; // unknown count
  }

  // Read and find matching rows
  const raw = await adapter.readRange(esc(sheetName) + '!A:ZZ');
  if (raw.length < 1) return 0;

  const headers = raw[0] as string[];
  const { text: whereSubst, values: whereVals } = substParams(whereClause, params);

  const toDelete: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const row: any = {};
    headers.forEach((h, j) => { row[h] = raw[i][j] ?? null; });
    if (matchRowSQL(row, whereSubst, whereVals)) {
      toDelete.push(i + 1);
    }
  }

  // Delete from bottom to top
  toDelete.sort((a, b) => b - a);
  for (const rowIdx of toDelete) {
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: rowIdx - 1, endIndex: rowIdx },
            },
          }],
        },
      })
    );
  }
  return toDelete.length;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(name: string): string {
  return name.includes(' ') || /[^\w]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

function resolveSheetName(modelName: string, mapping?: Record<string, string>): string {
  if (mapping?.[modelName]) return mapping[modelName];
  return modelToTable[modelName] || modelName;
}

function matchWhere(row: Record<string, any>, where: any): boolean {
  if (!where) return true;

  const cleanWhere: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key.includes('_') &&
      value && typeof value === 'object' &&
      !(value instanceof Date) &&
      !(value as any).in && !(value as any).contains &&
      !(value as any).not && !(value as any).gte &&
      !(value as any).lte && !(value as any).gt && !(value as any).lt
    ) {
      Object.assign(cleanWhere, value);
    } else {
      cleanWhere[key] = value;
    }
  }

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (key === 'OR' && Array.isArray(value)) {
      if (!value.some((v: any) => matchWhere(row, v))) return false;
      continue;
    }
    if (key === 'AND' && Array.isArray(value)) {
      if (!value.every((v: any) => matchWhere(row, v))) return false;
      continue;
    }

    const cellVal = row[key];

    if (value === null) {
      if (cellVal !== null && cellVal !== undefined) return false;
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      const v = value as any;
      if (v.not !== undefined) {
        if (v.not === null) { if (cellVal === null || cellVal === undefined) return false; }
        else if (cellVal == v.not) return false;
      }
      if (v.equals !== undefined && cellVal != v.equals) return false;
      if (v.contains !== undefined && (!cellVal || !String(cellVal).includes(v.contains))) return false;
      if (v.startsWith !== undefined && (!cellVal || !String(cellVal).startsWith(v.startsWith))) return false;
      if (v.endsWith !== undefined && (!cellVal || !String(cellVal).endsWith(v.endsWith))) return false;
      if (v.gte !== undefined && !(Number(cellVal) >= Number(v.gte))) return false;
      if (v.lte !== undefined && !(Number(cellVal) <= Number(v.lte))) return false;
      if (v.gt !== undefined && !(Number(cellVal) > Number(v.gt))) return false;
      if (v.lt !== undefined && !(Number(cellVal) < Number(v.lt))) return false;
      if (v.in !== undefined) {
        if (!Array.isArray(v.in) || !v.in.includes(cellVal)) return false;
      }
    } else {
      if (cellVal != value) return false;
    }
  }
  return true;
}

function buildOrderBy(orderBy: any): string {
  if (!orderBy) return '';
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const entry of entries) {
    for (const [key, dir] of Object.entries(entry)) {
      parts.push(`${key} ${(dir as string).toUpperCase()}`);
    }
  }
  return parts.join(', ');
}

function sortRows(rows: Record<string, any>[], orderBy: string): Record<string, any>[] {
  if (!orderBy) return rows;
  const clauses = orderBy.split(',').map(c => c.trim());
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, dir] = clause.split(/\s+/);
      const direction = dir?.toUpperCase() === 'DESC' ? -1 : 1;
      const aVal = a[field];
      const bVal = b[field];
      if (aVal == null && bVal == null) continue;
      if (aVal == null) return 1 * direction;
      if (bVal == null) return -1 * direction;
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
    }
    return 0;
  });
}

function coerceCell(raw: any, fieldMeta?: { ts?: string; sql?: string }): any {
  if (raw === undefined || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString();
  if (fieldMeta) {
    const tsType = (fieldMeta.ts || '').toLowerCase().replace('?', '');
    if (['number', 'int', 'float', 'double', 'decimal'].includes(tsType)) {
      const n = Number(raw);
      return isNaN(n) ? raw : n;
    }
    if (tsType === 'boolean' || tsType === 'bool') {
      if (raw === 'true' || raw === true) return true;
      if (raw === 'false' || raw === false) return false;
    }
  }
  if (typeof raw === 'string' && /^-?\d+\.?\d*$/.test(raw.trim()) && !/^0\d/.test(raw.trim())) {
    const n = Number(raw);
    if (!isNaN(n) && String(n) === raw.trim()) return n;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

// ─── Table Client ─────────────────────────────────────────────────────────────

export class SheetsTableClient<T = any> {
  constructor(
    private adapter: An5SheetsAdapter,
    private modelName: string,
    private sheetMapping?: Record<string, string>,
  ) {}

  private get sheetName(): string {
    return resolveSheetName(this.modelName, this.sheetMapping);
  }

  private get escSheetName(): string {
    return esc(this.sheetName);
  }

  private get fields(): Record<string, { ts: string; sql: string }> {
    return (modelFields as any)[this.modelName] || {};
  }

  private async ensureSheetExists(): Promise<void> {
    const existing = await this.adapter.getSheetMeta(this.sheetName);
    if (existing) return;

    const api = await this.adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: this.adapter.config.spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: this.sheetName } } }],
        },
      })
    );
    this.adapter.invalidateCache();
  }

  private async readAllRows(): Promise<{ headers: string[]; rows: Record<string, any>[] }> {
    const api = await this.adapter.getSheets();
    const res = await withRetry(() =>
      api.spreadsheets.values.get({
        spreadsheetId: this.adapter.config.spreadsheetId,
        range: `${this.escSheetName}!A:ZZ`,
      })
    );
    const values = res.data.values || [];
    if (values.length < 1) return { headers: [], rows: [] };

    const headers = values[0] as string[];
    const rows: Record<string, any>[] = [];
    for (let i = 1; i < values.length; i++) {
      const row: Record<string, any> = { __row: i + 1 };
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = coerceCell(values[i][j], this.fields[headers[j]]);
      }
      rows.push(row);
    }
    return { headers, rows };
  }

  private async getOrCreateHeaders(cols: string[]): Promise<string[]> {
    const api = await this.adapter.getSheets();
    await this.ensureSheetExists();

    const res = await withRetry(() =>
      api.spreadsheets.values.get({
        spreadsheetId: this.adapter.config.spreadsheetId,
        range: `${this.escSheetName}!A1:ZZ1`,
      })
    );
    const existing = (res.data.values || [])[0] || [];
    if (existing.length > 0) return existing as string[];

    await withRetry(() =>
      api.spreadsheets.values.update({
        spreadsheetId: this.adapter.config.spreadsheetId,
        range: `${this.escSheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [cols] },
      })
    );
    return cols;
  }

  private rowToValues(data: Record<string, any>, headers: string[]): any[] {
    return headers.map(h => {
      const v = data[h];
      if (v instanceof Date) return v.toISOString();
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    });
  }

  private async deleteRowByIndex(rowIdx: number, sheetIdVal: number): Promise<void> {
    const api = await this.adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: this.adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheetIdVal,
                dimension: 'ROWS',
                startIndex: rowIdx - 1,
                endIndex: rowIdx,
              },
            },
          }],
        },
      })
    );
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any }): Promise<T[]> {
    const { headers, rows } = await this.readAllRows();
    if (headers.length === 0) return [];

    let filtered = rows.filter(r => matchWhere(r, args?.where));
    const orderSql = buildOrderBy(args?.orderBy);
    if (orderSql) filtered = sortRows(filtered, orderSql);

    const skip = args?.skip ?? 0;
    if (args?.take !== undefined) {
      filtered = filtered.slice(skip, skip + args.take);
    } else if (skip > 0) {
      filtered = filtered.slice(skip);
    }

    const select = args?.select;
    if (select) {
      const selectedKeys = Object.keys(select).filter(k => select[k] === true);
      return filtered.map(r => {
        const obj: any = {};
        for (const k of selectedKeys) obj[k] = r[k];
        return obj as T;
      });
    }

    return filtered.map(r => {
      const { __row, ...rest } = r;
      return rest as T;
    });
  }

  async findFirst(args?: { where?: any; orderBy?: any; select?: any }): Promise<T | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: { where: any }): Promise<T | null> {
    return this.findFirst({ where: args.where });
  }

  async count(args?: { where?: any }): Promise<number> {
    const rows = await this.findMany({ where: args?.where });
    return rows.length;
  }

  async create(args: { data: Partial<T> }): Promise<T> {
    const fields = this.fields;
    const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
      ? 'id'
      : Object.keys(fields).find(name => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');

    const data: any = { ...args.data } as any;
    if (idFieldName) {
      const fieldDef = fields[idFieldName];
      const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || '');
      const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(rawType.toLowerCase());
      if (isStringType && !data[idFieldName]) {
        data[idFieldName] = randomUUID();
      }
    }

    const cols = Object.keys(data).filter(k => data[k] !== undefined);
    const headers = await this.getOrCreateHeaders(cols);

    for (const h of headers) {
      if (data[h] === undefined) data[h] = null;
    }

    await this.adapter.appendRange(`${this.escSheetName}!A:A`, [
      this.rowToValues(data, headers),
    ]);

    return data as T;
  }

  async createMany(args: { data: Partial<T>[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
    if (args.data.length === 0) return { count: 0 };

    const allKeys = new Set<string>();
    for (const row of args.data) {
      Object.keys(row as any).forEach(k => allKeys.add(k));
    }
    const cols = [...allKeys];
    const fields = this.fields;
    const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
      ? 'id'
      : Object.keys(fields).find(name => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');

    const prepared: Record<string, any>[] = [];
    for (const item of args.data) {
      const data: any = { ...item } as any;
      if (idFieldName) {
        const fieldDef = fields[idFieldName];
        const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || '');
        const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(rawType.toLowerCase());
        if (isStringType && !data[idFieldName]) {
          data[idFieldName] = randomUUID();
        }
      }
      prepared.push(data);
    }

    const headers = await this.getOrCreateHeaders(cols);

    const batchValues = prepared.map(data => {
      for (const h of headers) {
        if (data[h] === undefined) data[h] = null;
      }
      return this.rowToValues(data, headers);
    });

    try {
      await this.adapter.appendRange(`${this.escSheetName}!A:A`, batchValues);
      return { count: batchValues.length };
    } catch (e) {
      if (!args.skipDuplicates) throw e;
      let count = 0;
      for (const row of args.data) {
        try { await this.create({ data: row }); count++; } catch { /* skip */ }
      }
      return { count };
    }
  }

  async update(args: { where: any; data: Partial<T> }): Promise<T> {
    const { headers, rows } = await this.readAllRows();
    const matching = rows.filter(r => matchWhere(r, args.where));
    if (matching.length === 0) throw new Error('No record found matching where clause');

    const target = matching[0];
    const updated = { ...target, ...args.data as any, __row: target.__row };
    await this.adapter.writeRange(`${this.escSheetName}!A${target.__row}`, [
      this.rowToValues(updated, headers),
    ]);

    const { __row, ...rest } = updated;
    return rest as T;
  }

  async updateMany(args: { where?: any; data: Partial<T> }): Promise<{ count: number }> {
    const { headers, rows } = await this.readAllRows();
    const matching = rows.filter(r => matchWhere(r, args.where));

    for (const target of matching) {
      const updated = { ...target, ...args.data as any, __row: target.__row };
      await this.adapter.writeRange(`${this.escSheetName}!A${target.__row}`, [
        this.rowToValues(updated, headers),
      ]);
    }
    return { count: matching.length };
  }

  async delete(args: { where: any }): Promise<T> {
    const { headers, rows } = await this.readAllRows();
    const matching = rows.filter(r => matchWhere(r, args.where));
    if (matching.length === 0) throw new Error('No record found matching where clause');

    const target = matching[0];
    const meta = await this.adapter.getSheetMeta(this.sheetName);
    if (!meta) throw new Error(`Sheet "${this.sheetName}" not found`);
    await this.deleteRowByIndex(target.__row, meta.sheetId);

    const { __row, ...rest } = target;
    return rest as T;
  }

  async deleteMany(args?: { where?: any }): Promise<{ count: number }> {
    const { headers, rows } = await this.readAllRows();
    const matching = rows.filter(r => matchWhere(r, args?.where));
    if (matching.length === 0) return { count: 0 };

    const meta = await this.adapter.getSheetMeta(this.sheetName);
    if (!meta) throw new Error(`Sheet "${this.sheetName}" not found`);

    const sorted = [...matching].sort((a, b) => b.__row - a.__row);
    for (const target of sorted) {
      await this.deleteRowByIndex(target.__row, meta.sheetId);
    }
    return { count: matching.length };
  }

  async deleteAll(): Promise<void> {
    const meta = await this.adapter.getSheetMeta(this.sheetName);
    if (!meta) return;
    const api = await this.adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: this.adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: meta.sheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 999999,
              },
            },
          }],
        },
      })
    );
  }

  async clear(): Promise<void> {
    const api = await this.adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.values.clear({
        spreadsheetId: this.adapter.config.spreadsheetId,
        range: `${this.escSheetName}!A2:ZZ`,
      })
    );
  }

  async upsert(args: { where: any; create: Partial<T>; update: Partial<T> }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    if (existing) {
      return this.update({ where: args.where, data: args.update });
    }
    return this.create({ data: args.create });
  }

  async aggregate(args: any): Promise<any> {
    const rows = await this.findMany({ where: args?.where });

    const result: any = {};
    if (args._count !== undefined) result._count = rows.length;
    if (args._sum) {
      for (const f of Object.keys(args._sum)) {
        result[`_sum_${f}`] = rows.reduce((s, r: any) => s + (Number(r[f]) || 0), 0);
      }
    }
    if (args._avg) {
      for (const f of Object.keys(args._avg)) {
        const sum = rows.reduce((s, r: any) => s + (Number(r[f]) || 0), 0);
        result[`_avg_${f}`] = rows.length > 0 ? sum / rows.length : 0;
      }
    }
    if (args._min) {
      for (const f of Object.keys(args._min)) {
        const nums = rows.map((r: any) => Number(r[f])).filter(n => !isNaN(n));
        result[`_min_${f}`] = nums.length > 0 ? Math.min(...nums) : null;
      }
    }
    if (args._max) {
      for (const f of Object.keys(args._max)) {
        const nums = rows.map((r: any) => Number(r[f])).filter(n => !isNaN(n));
        result[`_max_${f}`] = nums.length > 0 ? Math.max(...nums) : null;
      }
    }
    return result;
  }

  async groupBy(args: any): Promise<any[]> {
    const rows = await this.findMany({ where: args?.where });
    const byCols: string[] = args.by || [];

    const groups: Record<string, any[]> = {};
    for (const row of rows) {
      const key = byCols.map(c => (row as any)[c]).join('|');
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    }

    return Object.entries(groups).map(([key, group]) => {
      const entry: any = {};
      const parts = key.split('|');
      byCols.forEach((c, i) => { entry[c] = parts[i]; });
      entry._count = group.length;
      return entry;
    });
  }

  async vectorSearch(args: {
    vector: number[];
    take?: number;
    where?: any;
    vectorField?: string;
    distanceMetric?: 'cosine' | 'euclidean' | 'dot';
  }): Promise<(T & { distance: number })[]> {
    const rows = await this.findMany({ where: args.where });
    const vectorField = args.vectorField || 'embedding';
    const metric = args.distanceMetric || 'cosine';

    const scored: { row: any; dist: number }[] = [];
    for (const raw of rows) {
      const row = raw as any;
      const rawVec = row[vectorField];
      if (!rawVec) continue;
      let vec: number[] = [];
      try { vec = typeof rawVec === 'string' ? JSON.parse(rawVec) : rawVec; } catch { continue; }
      if (!Array.isArray(vec) || vec.length !== args.vector.length) continue;

      let dot = 0, m1 = 0, m2 = 0;
      for (let i = 0; i < args.vector.length; i++) {
        dot += args.vector[i] * vec[i];
        m1 += args.vector[i] ** 2;
        m2 += vec[i] ** 2;
      }
      const cosine = m1 && m2 ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
      const dist = metric === 'cosine' ? 1 - cosine
        : metric === 'dot' ? -dot
        : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0));
      scored.push({ row, dist });
    }

    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, args.take ?? 10).map(s => ({ ...s.row, distance: s.dist }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAn5SheetsAdapter(config: An5SheetsAdapterConfig): An5SheetsAdapter {
  return new An5SheetsAdapter(config);
}
