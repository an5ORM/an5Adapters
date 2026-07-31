import { generateUUID } from './base/uuid';

import {
  An5SheetsAdapter,
  An5SheetsAdapterConfig,
  SheetsTableClient,
} from './googlesheets';
import { parseSheetsConnectionString } from './googlesheets/parseConnectionString';
import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
import { buildOrderBy, parseWhere, quote } from './base/sql';
import { getFieldsForModel, getModelToTable, setAdapterMetadata, type AdapterMetadata } from './base/metadata';
export type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
export { setAdapterMetadata, type AdapterMetadata } from './base/metadata';

export type AnyAdapter = An5Adapter | An5SheetsAdapter;
export type AnyAdapterConfig = An5AdapterConfig | An5SheetsAdapterConfig | { connectionString: string };

function isSheetsConfig(config: AnyAdapterConfig): config is An5SheetsAdapterConfig {
  return (config as any).spreadsheetId !== undefined;
}

// ─── An5Adapter ────────────────────────────────────────────────────────────────────

export class An5Adapter {
  private _engine: QueryEngine | null = null;
  private _engineType: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | null = null;
  private _engineConfig: An5AdapterConfig | null = null;
  sheetsAdapter: An5SheetsAdapter | null = null;

  get dialect(): Dialect {
    if (this.sheetsAdapter) return 'googlesheets';
    if (this._engine) return this._engine.dialect;
    if (this._engineType === 'postgres') return 'postgres';
    if (this._engineType === 'mysql') return 'mysql';
    if (this._engineType === 'sqlite') return 'sqlite';
    return 'mssql';
  }

  constructor(adapterConfig: An5AdapterConfig | An5SheetsAdapterConfig) {
    if (isSheetsConfig(adapterConfig)) {
      this.sheetsAdapter = new An5SheetsAdapter(adapterConfig);
      return;
    }

    const cs = adapterConfig.connectionString.trim();
    if (cs.startsWith('googlesheets://')) {
      this.sheetsAdapter = new An5SheetsAdapter(parseSheetsConnectionString(cs));
      return;
    }

    this._engineConfig = adapterConfig;
    if (cs.startsWith('postgres://') || cs.startsWith('postgresql://')) {
      this._engineType = 'postgres';
    } else if (cs.startsWith('mysql://') || cs.startsWith('mariadb://')) {
      this._engineType = 'mysql';
    } else if (cs.startsWith('sqlite://') || cs.endsWith('.sqlite') || cs.endsWith('.db')) {
      this._engineType = 'sqlite';
    } else {
      this._engineType = 'mssql';
    }
  }

  private async requireEngine(): Promise<QueryEngine> {
    if (!this._engine && this._engineType) {
      switch (this._engineType) {
        case 'postgres': {
          const { PostgresEngine } = require('./postgres.js');
          this._engine = new PostgresEngine(this._engineConfig!);
          break;
        }
        case 'mysql': {
          const { MysqlEngine } = require('./mysql.js');
          this._engine = new MysqlEngine(this._engineConfig!);
          break;
        }
        case 'sqlite': {
          const { SqliteEngine } = require('./sqlite.js');
          this._engine = new SqliteEngine(this._engineConfig!);
          break;
        }
        case 'mssql': {
          const { MssqlEngine } = require('./mssql.js');
          this._engine = new MssqlEngine(this._engineConfig!);
          break;
        }
      }
    }
    if (!this._engine) throw new Error('SQL engine is not available for Google Sheets adapter');
    return this._engine;
  }

  private requireSheetsAdapter(): An5SheetsAdapter {
    if (!this.sheetsAdapter) throw new Error('Google Sheets methods require a googlesheets:// connection or Sheets config');
    return this.sheetsAdapter;
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    if (this.sheetsAdapter) return this.sheetsAdapter.exec<T>(query, params);
    return (await this.requireEngine()).exec<T>(query, params);
  }

  /** INTERNAL: used by AdapterTableClient for DML statements needing row count */
  async _executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    return (await this.requireEngine()).executeRaw(query, params);
  }

  /** Execute a raw query with positional values → @p_0, @p_1, ... per dialect */
  async $queryRawUnsafe<T = any>(query: string, ...values: any[]): Promise<T[]> {
    if (this.sheetsAdapter) return this.sheetsAdapter.$queryRawUnsafe<T>(query, ...values);
    const engine = await this.requireEngine();
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    let q = query;
    if (this.dialect === 'postgres') {
      let idx = 0;
      q = q.replace(/\$\d+/g, () => `@p_${idx++}`);
    } else if (this.dialect === 'mysql') {
      let idx = 0;
      q = q.replace(/\?/g, () => `@p_${idx++}`);
    }
    return engine.exec<T>(q, params);
  }

  async $executeRaw(query: string, ...values: any[]): Promise<number> {
    if (this.sheetsAdapter) return this.sheetsAdapter.$executeRaw(query, ...values);
    const engine = await this.requireEngine();
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    let q = query;
    if (this.dialect === 'postgres') {
      let idx = 0;
      q = q.replace(/\$\d+/g, () => `@p_${idx++}`);
    } else if (this.dialect === 'mysql') {
      let idx = 0;
      q = q.replace(/\?/g, () => `@p_${idx++}`);
    }
    return engine.executeRaw(q, params);
  }

  async $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
    return this.$executeRaw(query, ...values);
  }

  async $connect(): Promise<void> {
    if (this.sheetsAdapter) return this.sheetsAdapter.$connect();
    await (await this.requireEngine()).connect();
  }

  async $disconnect(): Promise<void> {
    if (this.sheetsAdapter) return this.sheetsAdapter.$disconnect();
    await (await this.requireEngine()).disconnect();
  }

  /** Real transaction with BEGIN / COMMIT / ROLLBACK */
  async $transaction<R>(fn: (tx: An5AdapterTx) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  async $transaction<R>(list: Promise<R>[]): Promise<R[]>;
  async $transaction(fn: any, _options?: any): Promise<any> {
    if (this.sheetsAdapter) return this.sheetsAdapter.$transaction(fn, _options);
    if (Array.isArray(fn)) return Promise.all(fn);
    const engine = await this.requireEngine();
    const handle = await engine.beginTransaction();
    const txAdapter = new An5AdapterTx(handle, this.dialect);
    try {
      const result = await fn(txAdapter);
      await handle.commit();
      return result;
    } catch (err) {
      await handle.rollback();
      throw err;
    }
  }

  table<T = any>(modelName: string): AdapterTableClient<T> | SheetsTableClient<T> {
    if (this.sheetsAdapter) return this.sheetsAdapter.table<T>(modelName);
    return new AdapterTableClient<T>(this, modelName);
  }

  async readRange<T = any>(range: string): Promise<T[][]> {
    return this.requireSheetsAdapter().readRange<T>(range);
  }

  async writeRange(range: string, values: any[][]): Promise<void> {
    await this.requireSheetsAdapter().writeRange(range, values);
  }

  async appendRange(range: string, values: any[][]): Promise<void> {
    await this.requireSheetsAdapter().appendRange(range, values);
  }

  async listSheets(): Promise<string[]> {
    return this.requireSheetsAdapter().listSheets();
  }

  async deleteSheet(name: string): Promise<void> {
    await this.requireSheetsAdapter().deleteSheet(name);
  }
}

// ─── Transaction-scoped adapter ────────────────────────────────────────────────────

export class An5AdapterTx {
  constructor(
    private readonly handle: TransactionHandle,
    public readonly dialect: Dialect,
  ) { }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    return this.handle.exec<T>(query, params);
  }

  async _executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    return this.handle.executeRaw(query, params);
  }

  table<T = any>(modelName: string): AdapterTableClient<T> {
    return new AdapterTableClient<T>(this, modelName);
  }
}

// ─── Table Client ──────────────────────────────────────────────────────────────────

export class AdapterTableClient<T = any> {
  constructor(
    private readonly adapter: An5Adapter | An5AdapterTx,
    private readonly modelName: string,
  ) { }

  private get dialect(): Dialect { return this.adapter.dialect; }

  private get tableName(): string {
    const name = this.modelName;
    let t = name;
    const modelToTable = getModelToTable();
    if (modelToTable[name]) t = modelToTable[name];
    else {
      const camel = name.charAt(0).toLowerCase() + name.slice(1);
      if (modelToTable[camel]) t = modelToTable[camel];
      else {
        const lower = name.toLowerCase();
        if (modelToTable[lower]) t = modelToTable[lower];
      }
    }
    if (t.startsWith('[') || t.startsWith('"') || t.startsWith('`')) return t;
    if (t.includes('.')) return t.split('.').map(p => quote(p, this.dialect)).join('.');
    return quote(t, this.dialect);
  }

  private get nolock(): string {
    return this.dialect === 'mssql' ? ' WITH (NOLOCK)' : '';
  }

  private async doExec<U = any>(query: string, params?: Record<string, any>): Promise<U[]> {
    return this.adapter.exec<U>(query, params);
  }

  private async doExecuteRaw(query: string, params?: Record<string, any>): Promise<number> {
    return this.adapter._executeRaw(query, params);
  }

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any }): Promise<T[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
    const orderSql = buildOrderBy(args?.orderBy, this.dialect);
    const take = args?.take;
    const skip = args?.skip ?? 0;

    let query: string;
    if (take !== undefined) {
      if (this.dialect === 'postgres' || this.dialect === 'mysql' || this.dialect === 'sqlite') {
        query = `SELECT * FROM ${this.tableName}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        if (orderSql) query += ` ${orderSql}`;
        query += ` LIMIT ${take} OFFSET ${skip}`;
      } else {
        // mssql requires ORDER BY before OFFSET/FETCH
        query = `SELECT * FROM ${this.tableName}${this.nolock}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        query += ` ${orderSql || 'ORDER BY (SELECT NULL)'}`;
        query += ` OFFSET ${skip} ROWS FETCH NEXT ${take} ROWS ONLY`;
      }
    } else {
      query = `SELECT * FROM ${this.tableName}${this.nolock}`;
      if (whereSql) query += ` WHERE ${whereSql}`;
      if (orderSql) query += ` ${orderSql}`;
    }
    return this.doExec<T>(query, params);
  }

  async findFirst(args?: { where?: any; orderBy?: any; select?: any }): Promise<T | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: { where: any }): Promise<T | null> {
    return this.findFirst({ where: args.where });
  }

  async count(args?: { where?: any }): Promise<number> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
    // Add NOLOCK for mssql count too
    let query = `SELECT COUNT(*) AS cnt FROM ${this.tableName}${this.nolock}`;
    if (whereSql) query += ` WHERE ${whereSql}`;
    const rows = await this.doExec<any>(query, params);
    return Number(rows[0]?.cnt ?? rows[0]?.CNT ?? 0);
  }

  async create(args: { data: Partial<T> }): Promise<T> {
    const fields = getFieldsForModel(this.modelName);
    const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
      ? 'id'
      : Object.keys(fields).find((name) => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');

    const data: any = { ...args.data };
    if (idFieldName) {
      const fieldDef: any = fields[idFieldName];
      const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || fieldDef?.type || '');
      const normalizedType = String(rawType).toLowerCase();
      const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(normalizedType);
      if (isStringType && !data[idFieldName]) data[idFieldName] = generateUUID();
    }

    const cols = Object.keys(data).filter(k => data[k] !== undefined);
    const params: Record<string, any> = {};
    const vals: string[] = [];

    for (const col of cols) {
      const p = `c_${col}`;
      params[p] = data[col];
      vals.push(`@${p}`);
    }

    const query = `INSERT INTO ${this.tableName} (${cols.map(c => quote(c, this.dialect)).join(', ')}) VALUES (${vals.join(', ')})`;
    await this.doExec(query, params);
    return (await this.findFirst({ where: idFieldName ? { [idFieldName]: data[idFieldName] } : data })) as T;
  }

  async createMany(args: { data: Partial<T>[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
    if (args.data.length === 0) return { count: 0 };

    const firstCols = Object.keys(args.data[0]).filter(k => (args.data[0] as any)[k] !== undefined);

    // Bulk INSERT for the common case (same columns, no skipDuplicates)
    if (firstCols.length > 0 && !args.skipDuplicates) {
      const params: Record<string, any> = {};
      const rowPlaceholders: string[] = [];

      for (let r = 0; r < args.data.length; r++) {
        const row = args.data[r] as any;
        const vals = firstCols.map(col => {
          const p = `r${r}_${col}`;
          params[p] = row[col] ?? null;
          return `@${p}`;
        });
        rowPlaceholders.push(`(${vals.join(', ')})`);
      }

      const query = `INSERT INTO ${this.tableName} (${firstCols.map(c => quote(c, this.dialect)).join(', ')}) VALUES ${rowPlaceholders.join(', ')}`;
      try {
        await this.doExecuteRaw(query, params);
        return { count: args.data.length };
      } catch {
        // fallback below if bulk fails (e.g. mixed column sets)
      }
    }

    // Row-by-row fallback
    let count = 0;
    for (const row of args.data) {
      try { await this.create({ data: row }); count++; }
      catch (e) { if (!args.skipDuplicates) throw e; }
    }
    return { count };
  }

  async update(args: { where: any; data: Partial<T> }): Promise<T> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_');
    const setCols = Object.keys(args.data).filter(k => (args.data as any)[k] !== undefined);
    const sets: string[] = [];

    for (const col of setCols) {
      const p = `s_${col}`;
      params[p] = (args.data as any)[col];
      sets.push(`${quote(col, this.dialect)} = @${p}`);
    }

    const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    await this.doExecuteRaw(query, params);
    return (await this.findFirst({ where: args.where })) as T;
  }

  async updateMany(args: { where?: any; data: Partial<T> }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_');
    const setCols = Object.keys(args.data).filter(k => (args.data as any)[k] !== undefined);
    const sets: string[] = [];

    for (const col of setCols) {
      const p = `s_${col}`;
      params[p] = (args.data as any)[col];
      sets.push(`${quote(col, this.dialect)} = @${p}`);
    }

    const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const count = await this.doExecuteRaw(query, params);
    return { count };
  }

  async delete(args: { where: any }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect);
    await this.doExecuteRaw(`DELETE FROM ${this.tableName} WHERE ${whereSql}`, params);
    return existing as T;
  }

  async deleteMany(args?: { where?: any }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
    const query = `DELETE FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const count = await this.doExecuteRaw(query, params);
    return { count };
  }

  async upsert(args: { where: any; create: Partial<T>; update: Partial<T> }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    return existing
      ? this.update({ where: args.where, data: args.update })
      : this.create({ data: args.create });
  }

  async aggregate(args: any): Promise<any> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
    const aggs: string[] = [];

    if (args._count) aggs.push('COUNT(*) AS _count');
    if (args._sum) for (const f of Object.keys(args._sum)) aggs.push(`SUM(${quote(f, this.dialect)}) AS _sum_${f}`);
    if (args._avg) for (const f of Object.keys(args._avg)) aggs.push(`AVG(${quote(f, this.dialect)}) AS _avg_${f}`);
    if (args._min) for (const f of Object.keys(args._min)) aggs.push(`MIN(${quote(f, this.dialect)}) AS _min_${f}`);
    if (args._max) for (const f of Object.keys(args._max)) aggs.push(`MAX(${quote(f, this.dialect)}) AS _max_${f}`);

    const query = `SELECT ${aggs.join(', ')} FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const rows = await this.doExec(query, params);
    return rows[0] ?? {};
  }

  async groupBy(args: any): Promise<any[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
    const byCols = (args.by || []).map((b: string) => quote(b, this.dialect)).join(', ');
    const query = `SELECT ${byCols}, COUNT(*) AS _count FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} GROUP BY ${byCols}`;
    return this.doExec(query, params);
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

    const scored: { row: T; dist: number }[] = [];
    for (const row of rows) {
      const raw = (row as any)[vectorField];
      if (!raw) continue;
      let vec: number[] = [];
      try { vec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      if (!Array.isArray(vec) || vec.length !== args.vector.length) continue;

      let dot = 0, m1 = 0, m2 = 0;
      for (let i = 0; i < args.vector.length; i++) {
        dot += args.vector[i] * vec[i];
        m1 += args.vector[i] ** 2;
        m2 += vec[i] ** 2;
      }
      const cosine = m1 && m2 ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
      const dist = metric === 'cosine'
        ? 1 - cosine
        : metric === 'dot'
          ? -dot
          : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0));
      scored.push({ row, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, args.take ?? 10).map(s => ({ ...s.row as any, distance: s.dist }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────────

export function createAn5Adapter(config: AnyAdapterConfig): AnyAdapter {
  if (isSheetsConfig(config)) return new An5SheetsAdapter(config);
  if (config.connectionString.trim().startsWith('googlesheets://')) {
    return new An5SheetsAdapter(parseSheetsConnectionString(config.connectionString));
  }
  return new An5Adapter(config);
}

export const createAdapter = createAn5Adapter;
