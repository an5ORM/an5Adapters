import { randomUUID } from 'crypto';
import { getFieldsForModel } from '../base/metadata';
import type { An5SheetsAdapter } from './adapter';
import { buildOrderBy, coerceCell, esc, matchWhere, resolveSheetName, sortRows } from './helpers';
import { withRetry } from './retry';

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
    return getFieldsForModel(this.modelName);
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
        const nums = rows.map((r: any) => Number(r[f])).filter(n => !isNaN(n));
        result[`_sum_${f}`] = nums.length > 0 ? nums.reduce((s, n) => s + n, 0) : null;
      }
    }
    if (args._avg) {
      for (const f of Object.keys(args._avg)) {
        const nums = rows.map((r: any) => Number(r[f])).filter(n => !isNaN(n));
        result[`_avg_${f}`] = nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
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
