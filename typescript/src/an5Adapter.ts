import { generateUUID } from './base/uuid';

import {
  An5SheetsAdapter,
  An5SheetsAdapterConfig,
  SheetsTableClient,
} from './googlesheets';
import { parseSheetsConnectionString } from './googlesheets/parseConnectionString';
import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';

/**
 * File extensions that mean SQLite when a connection string has no scheme.
 *
 * `.sqlite3` is here as well as in `@an5/orm`'s `detectProvider`, because the ORM
 * validates field types and writes the DDL from the provider this file picks: if the
 * two lists differed, a `.sqlite3` file would be pushed as SQL Server DDL.
 */
const SQLITE_FILE_SUFFIXES = ['.sqlite', '.sqlite3', '.db'];
import {
  NBaseError,
  buildVectorId,
  parseVectorId,
  isNBaseConnectionString,
  parseNBaseConnectionString,
  createNBaseVectorClient,
  type NBaseAdapterConfig,
  type NBaseVectorClient,
} from './nbase';
import { bindParam, buildOrderBy, parseWhere, quote } from './base/sql';
import {
  createAdapterProxy,
  getFieldsForModel,
  resolveIdField,
  getModelToTable,
  getRelationMap,
  getRelationsForModel,
  type RelationDef,
} from './base/metadata';
export type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
export { setAdapterMetadata, createAdapterProxy, type AdapterMetadata } from './base/metadata';
export type { TypedAn5Adapter, AdapterAPI } from './typed';

export type AnyAdapter = An5Adapter | An5SheetsAdapter;
export type AnyAdapterConfig = An5AdapterConfig | An5SheetsAdapterConfig | { connectionString: string };

function isSheetsConfig(config: AnyAdapterConfig): config is An5SheetsAdapterConfig {
  return (config as any).spreadsheetId !== undefined;
}

function sanitizeParamName(name: string): string {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `p_${cleaned}`;
}

/** Match only unique/primary-key violations, never general constraint errors. */
function isDuplicateKeyError(error: unknown, dialect: Dialect): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as any;
  if (dialect === 'postgres') return e.code === '23505';
  if (dialect === 'mysql') return e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
  if (dialect === 'sqlite') {
    return e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      || e.errcode === 2067 || e.errcode === 1555;
  }
  if (dialect === 'mssql') {
    const number = e.number ?? e.originalError?.info?.number;
    return number === 2601 || number === 2627;
  }
  return false;
}

function appendUpdateSet(sets: string[], params: Record<string, any>, col: string, val: any, dialect: Dialect): void {
  const quoted = quote(col, dialect);
  const safeCol = sanitizeParamName(col);
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    if (val.increment !== undefined) {
      const p = bindParam(params, `s_${safeCol}_inc`, val.increment);
      sets.push(`${quoted} = ${quoted} + @${p}`);
      return;
    }
    if (val.decrement !== undefined) {
      const p = bindParam(params, `s_${safeCol}_dec`, val.decrement);
      sets.push(`${quoted} = ${quoted} - @${p}`);
      return;
    }
    if (val.multiply !== undefined) {
      const p = bindParam(params, `s_${safeCol}_mul`, val.multiply);
      sets.push(`${quoted} = ${quoted} * @${p}`);
      return;
    }
    if (val.divide !== undefined) {
      const p = bindParam(params, `s_${safeCol}_div`, val.divide);
      sets.push(`${quoted} = ${quoted} / @${p}`);
      return;
    }
    if (val.set !== undefined) {
      const p = bindParam(params, `s_${safeCol}_set`, val.set);
      sets.push(`${quoted} = @${p}`);
      return;
    }
  }

  const p = bindParam(params, `s_${safeCol}`, val);
  sets.push(`${quoted} = @${p}`);
}

function selectedAggregateFields(fields: any): string[] {
  if (!fields || typeof fields !== 'object') return [];
  return Object.keys(fields).filter(key => fields[key]);
}

function normalizeByFields(by: any): string[] {
  if (typeof by === 'string') return [by];
  return Array.isArray(by) ? by.filter(field => typeof field === 'string' && field.length > 0) : [];
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function projectFields(row: any, select: any): any {
  if (!row || !select || typeof select !== 'object') return row;
  const projected: any = {};
  for (const [key, val] of Object.entries(select)) {
    if (val) {
      projected[key] = row[key];
    }
  }
  if (row._count) {
    projected._count = row._count;
  }
  return projected;
}

async function resolveIncludes(
  modelName: string,
  rows: any[],
  include: any,
  adapter: An5Adapter | An5AdapterTx
): Promise<void> {
  if (!rows || rows.length === 0 || !include || typeof include !== 'object') return;
  const modelRelations = getRelationsForModel(modelName);

  for (const [key, value] of Object.entries(include)) {
    if (!value) continue;

    if (key === '_count') {
      for (const row of rows) {
        if (!row._count) row._count = {};
      }
      for (const [relKey, relation] of Object.entries(modelRelations)) {
        if (relation.relationType === 'many') {
          const uniqueKeys = Array.from(new Set(rows.map(r => r[relation.localKey]).filter(k => k !== undefined && k !== null)));
          if (uniqueKeys.length > 0) {
            const relClient = adapter.table(relation.modelName);
            const relatedRows = await relClient.findMany({
              where: { [relation.foreignKey]: { in: uniqueKeys } },
            });
            const countMap = new Map<any, number>();
            relatedRows.forEach((r: any) => {
              const k = r[relation.foreignKey];
              countMap.set(k, (countMap.get(k) || 0) + 1);
            });
            rows.forEach(r => {
              const k = r[relation.localKey];
              r._count[relKey] = countMap.get(k) || 0;
            });
          } else {
            rows.forEach(r => { r._count[relKey] = 0; });
          }
        }
      }
      continue;
    }

    const relation = modelRelations[key];
    if (!relation) continue;

    const isMany = relation.relationType === 'many';
    const localKey = relation.localKey;
    const foreignKey = relation.foreignKey;
    const joinKey = isMany ? localKey : foreignKey;
    const matchKey = isMany ? foreignKey : localKey;
    const uniqueKeys = Array.from(new Set(rows.map(r => r[joinKey]).filter(k => k !== undefined && k !== null)));

    if (uniqueKeys.length === 0) {
      rows.forEach(r => { r[key] = isMany ? [] : null; });
      continue;
    }

    const subArgs: any = typeof value === 'object' ? { ...value } : {};
    const nestedInclude = subArgs.include;
    const nestedSelect = subArgs.select;

    const subWhere: any = {
      [matchKey]: { in: uniqueKeys },
      ...(subArgs.where || {}),
    };

    const relClient = adapter.table(relation.modelName);
    const relatedRows = await relClient.findMany({
      where: subWhere,
      orderBy: subArgs.orderBy,
      take: subArgs.take,
      skip: subArgs.skip,
    });

    if (nestedInclude) {
      await resolveIncludes(relation.modelName, relatedRows, nestedInclude, adapter);
    }

    const outputRows = nestedSelect && typeof nestedSelect === 'object'
      ? relatedRows.map((r: any) => projectFields(r, nestedSelect))
      : relatedRows;

    const groupMap = new Map<any, any[]>();
    relatedRows.forEach((r: any, idx: number) => {
      const k = r[isMany ? foreignKey : localKey];
      if (!groupMap.has(k)) groupMap.set(k, []);
      groupMap.get(k)!.push(outputRows[idx]);
    });

    rows.forEach(r => {
      const k = r[isMany ? localKey : foreignKey];
      const matches = groupMap.get(k) || [];
      if (isMany) {
        r[key] = matches;
      } else {
        r[key] = matches[0] || null;
      }
    });
  }
}

// ─── An5Adapter ────────────────────────────────────────────────────────────────────

export class An5Adapter {
  [key: string]: any;
  private _engine: QueryEngine | null = null;
  private _engineType: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | null = null;
  private _engineConfig: An5AdapterConfig | null = null;
  sheetsAdapter: An5SheetsAdapter | null = null;
  private _nbase: NBaseVectorClient | null = null;
  private _nbaseConfig: NBaseAdapterConfig | null = null;
  private _nbaseOnly = false;

  /**
   * Returns the NBase client for this adapter, if the project configured one.
   * The connection string may also point straight at NBase, which keeps
   * `DATABASE_URL=nbase://host:port` working on its own.
   */
  nbaseClient(): { client: NBaseVectorClient; config: NBaseAdapterConfig } | null {
    if (this._nbase && this._nbaseConfig) return { client: this._nbase, config: this._nbaseConfig };

    if (!this._nbaseConfig) return null;
    const config = this._nbaseConfig;

    const client: NBaseVectorClient = createNBaseVectorClient(config);
    this._nbase = client;
    this._nbaseConfig = config;
    return { client, config };
  }

  /**
   * True when the adapter only knows about NBase, so there is no relational
   * database to read rows from.
   */
  get nbaseOnly(): boolean {
    return this._nbaseOnly === true;
  }

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
      return createAdapterProxy(this, (name) => this.table(name));
    }

    // Keep the config even when the caller supplies its own engine: the NBase
    // settings and anything else on the config are read from it later.
    this._engineConfig = adapterConfig as An5AdapterConfig;

    // `nbase://host:port` as the connection string configures the vector store
    // on its own: there is no relational database, so the adapter is
    // vector-only. The same string passed as `nbase` keeps the database from
    // `connectionString` as the source of rows.
    const rawConnectionString = String(this._engineConfig.connectionString ?? '').trim();
    if (isNBaseConnectionString(rawConnectionString)) {
      this._nbaseConfig = parseNBaseConnectionString(rawConnectionString);
      this._nbaseOnly = true;
      return createAdapterProxy(this, (name) => this.table(name));
    }
    const attached = this._engineConfig.nbase;
    if (attached && isNBaseConnectionString(attached)) {
      this._nbaseConfig = parseNBaseConnectionString(attached);
    }

    if ((adapterConfig as any).engine) {
      this._engine = (adapterConfig as any).engine;
      this._engineType = (this._engine?.dialect as any) || 'sqlite';
      return createAdapterProxy(this, (name) => this.table(name));
    }

    if ((adapterConfig as any).db || (adapterConfig as any).driver) {
      const { SqliteBrowserEngine } = require('./sqlite/browserEngine.js');
      this._engine = new SqliteBrowserEngine(adapterConfig);
      this._engineType = 'sqlite';
      return createAdapterProxy(this, (name) => this.table(name));
    }

    // Lower-cased for the dialect test only; the connection string itself keeps its
    // case for the driver. A URI scheme is case-insensitive, and `@an5/orm` reads the
    // provider the same way to validate field types and write DDL — if the two
    // disagreed, a schema would be checked against one database and run on another.
    const cs = (adapterConfig.connectionString || '').trim();
    const forDialect = cs.toLowerCase();

    if (forDialect.startsWith('googlesheets://')) {
      this.sheetsAdapter = new An5SheetsAdapter(parseSheetsConnectionString(cs));
      return createAdapterProxy(this, (name) => this.table(name));
    }

    this._engineConfig = adapterConfig;
    if (forDialect.startsWith('postgres://') || forDialect.startsWith('postgresql://')) {
      this._engineType = 'postgres';
    } else if (forDialect.startsWith('mysql://') || forDialect.startsWith('mariadb://')) {
      this._engineType = 'mysql';
    } else if (
      forDialect === ':memory:'
      || forDialect.startsWith('sqlite:')
      || SQLITE_FILE_SUFFIXES.some((suffix) => forDialect.endsWith(suffix))
    ) {
      this._engineType = 'sqlite';
    } else {
      this._engineType = 'mssql';
    }

    return createAdapterProxy(this, (name) => this.table(name));
  }

  private async requireEngine(): Promise<QueryEngine> {
    if (!this._engine && this._engineType) {
      switch (this._engineType) {
        case 'postgres': {
          const { PostgresEngine } = require('./postgres/index.js');
          this._engine = new PostgresEngine(this._engineConfig!);
          break;
        }
        case 'mysql': {
          const { MysqlEngine } = require('./mysql/index.js');
          this._engine = new MysqlEngine(this._engineConfig!);
          break;
        }
        case 'sqlite': {
          const { SqliteEngine } = require('./sqlite/index.js');
          this._engine = new SqliteEngine(this._engineConfig!);
          break;
        }
        case 'mssql': {
          const { MssqlEngine } = require('./mssql/index.js');
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
    if (this._nbaseOnly) {
      // NBase is stateless over HTTP, so there is nothing to open. Report the
      // endpoint so a misconfiguration is obvious.
      const config = this.nbaseClient()?.config;
      if (config) await this.nbaseClient()!.client.health();
      return;
    }
    await (await this.requireEngine()).connect();
  }

  /**
   * Health check for the configured NBase instance, or the database when the
   * adapter has none.
   */
  async $nbaseHealth(): Promise<{ connected: boolean; endpoint?: string; error?: string }> {
    const nbase = this.nbaseClient();
    if (!nbase) return { connected: false, error: 'No NBase instance configured.' };
    try {
      const health = await nbase.client.health();
      return { connected: health.status === 'ok', endpoint: nbase.config.url };
    } catch (err) {
      return {
        connected: false,
        endpoint: nbase.config.url,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

  async $begin(): Promise<An5AdapterTx> {
    if (this.sheetsAdapter) {
      throw new Error('Interactive transactions are not supported by the Google Sheets adapter');
    }
    const engine = await this.requireEngine();
    return new An5AdapterTx(await engine.beginTransaction(), this.dialect);
  }

  table<T = any>(modelName: string): AdapterTableClient<T> | SheetsTableClient<T> {
    if (this.sheetsAdapter) return this.sheetsAdapter.table<T>(modelName);
    return new AdapterTableClient<T>(this, modelName);
  }

  private _listeners: Record<string, ((...args: any[]) => void)[]> = {};
  private _middlewares: ((params: any) => Promise<any>)[] = [];

  $on(event: 'query' | 'error' | 'warn' | 'info' | string, callback: (...args: any[]) => void): this {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return this;
  }

  $off(event: string, callback: (...args: any[]) => void): this {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    return this;
  }

  $emit(event: string, ...args: any[]): void {
    if (this._listeners[event]) {
      for (const cb of this._listeners[event]) {
        try { cb(...args); } catch {}
      }
    }
  }

  $use(middleware: (params: { model?: string; action: string; args: any; run: (args: any) => Promise<any> }) => Promise<any>): this {
    this._middlewares.push(middleware);
    return this;
  }

  view<T = any>(viewName: string): ViewClient<T> {
    return new ViewClient<T>(this, viewName);
  }

  async $queryProc<T = any>(procName: string, params?: Record<string, any> | any[]): Promise<T[]> {
    if (this.sheetsAdapter) throw new Error('Stored procedures are not supported by the Google Sheets adapter');
    const paramObj: Record<string, any> = {};
    let sql = '';
    if (Array.isArray(params)) {
      const placeholders = params.map((v, i) => {
        paramObj[`p_${i}`] = v;
        return `@p_${i}`;
      });
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}(${placeholders.join(', ')})`
        : `EXEC ${procName} ${placeholders.join(', ')}`;
    } else if (params && typeof params === 'object') {
      const pairs = Object.entries(params).map(([k, v]) => {
        paramObj[`p_${k}`] = v;
        return `@${k} = @p_${k}`;
      });
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}(${Object.keys(params).map(k => `@p_${k}`).join(', ')})`
        : `EXEC ${procName} ${pairs.join(', ')}`;
    } else {
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}()`
        : `EXEC ${procName}`;
    }
    return this.exec<T>(sql, paramObj);
  }

  async $executeProc(procName: string, params?: Record<string, any> | any[]): Promise<number> {
    if (this.sheetsAdapter) throw new Error('Stored procedures are not supported by the Google Sheets adapter');
    const paramObj: Record<string, any> = {};
    let sql = '';
    if (Array.isArray(params)) {
      const placeholders = params.map((v, i) => {
        paramObj[`p_${i}`] = v;
        return `@p_${i}`;
      });
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}(${placeholders.join(', ')})`
        : `EXEC ${procName} ${placeholders.join(', ')}`;
    } else if (params && typeof params === 'object') {
      const pairs = Object.entries(params).map(([k, v]) => {
        paramObj[`p_${k}`] = v;
        return `@${k} = @p_${k}`;
      });
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}(${Object.keys(params).map(k => `@p_${k}`).join(', ')})`
        : `EXEC ${procName} ${pairs.join(', ')}`;
    } else {
      sql = this.dialect === 'postgres' || this.dialect === 'mysql'
        ? `CALL ${procName}()`
        : `EXEC ${procName}`;
    }
    return this._executeRaw(sql, paramObj);
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

// ─── View Client (Read-Only) ────────────────────────────────────────────────────────

export class ViewClient<T = any> {
  private readonly tableClient: AdapterTableClient<T>;

  constructor(
    public readonly adapter: An5Adapter | An5AdapterTx,
    public readonly viewName: string,
  ) {
    this.tableClient = new AdapterTableClient<T>(adapter, viewName);
  }

  public get dialect(): Dialect { return this.tableClient.dialect; }
  public get tableName(): string { return this.tableClient.tableName; }

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any; include?: any }): Promise<T[]> {
    return this.tableClient.findMany(args);
  }

  async findFirst(args?: { where?: any; orderBy?: any; select?: any; include?: any }): Promise<T | null> {
    return this.tableClient.findFirst(args);
  }

  async findUnique(args: { where: any; select?: any; include?: any }): Promise<T | null> {
    return this.tableClient.findUnique(args);
  }

  async count(args?: { where?: any }): Promise<number> {
    return this.tableClient.count(args);
  }

  async aggregate(args: any): Promise<any> {
    return this.tableClient.aggregate(args);
  }

  async groupBy(args: any): Promise<any[]> {
    return this.tableClient.groupBy(args);
  }

  async vectorSearch(args: any): Promise<(T & { distance: number })[]> {
    return this.tableClient.vectorSearch(args);
  }

  async create(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (create) are not allowed.`);
  }

  async createMany(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (createMany) are not allowed.`);
  }

  async update(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (update) are not allowed.`);
  }

  async updateMany(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (updateMany) are not allowed.`);
  }

  async delete(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (delete) are not allowed.`);
  }

  async deleteMany(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (deleteMany) are not allowed.`);
  }

  async upsert(): Promise<never> {
    throw new Error(`View '${this.viewName}' is read-only. Mutation operations (upsert) are not allowed.`);
  }
}

// ─── Transaction-scoped adapter ────────────────────────────────────────────────────

export class An5AdapterTx {
  [key: string]: any;
  private closed = false;

  constructor(
    private readonly handle: TransactionHandle,
    public readonly dialect: Dialect,
  ) {
    return createAdapterProxy(this, (name) => this.table(name));
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    this.ensureOpen();
    return this.handle.exec<T>(query, params);
  }

  async _executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    this.ensureOpen();
    return this.handle.executeRaw(query, params);
  }

  async $commit(): Promise<void> {
    this.ensureOpen();
    this.closed = true;
    await this.handle.commit();
  }

  async $rollback(): Promise<void> {
    this.ensureOpen();
    this.closed = true;
    await this.handle.rollback();
  }

  table<T = any>(modelName: string): AdapterTableClient<T> {
    return new AdapterTableClient<T>(this, modelName);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Transaction is already closed');
  }
}

// ─── Table Client ──────────────────────────────────────────────────────────────────

export class AdapterTableClient<T = any> {
  constructor(
    public readonly adapter: An5Adapter | An5AdapterTx,
    public readonly modelName: string,
  ) { }

  public get dialect(): Dialect { return this.adapter.dialect; }

  public get tableName(): string {
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

  /** Build the shared context used by parseWhere to resolve relations and self references. */
  private whereContext(): { relationMap: Record<string, Record<string, RelationDef>>; modelToTable: Record<string, string>; selfRef: string } {
    return {
      relationMap: getRelationMap(),
      modelToTable: getModelToTable(),
      selfRef: this.tableName,
    };
  }

  private async doExec<U = any>(query: string, params?: Record<string, any>): Promise<U[]> {
    return this.adapter.exec<U>(query, params);
  }

  private async doExecuteRaw(query: string, params?: Record<string, any>): Promise<number> {
    return this.adapter._executeRaw(query, params);
  }

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any; include?: any }): Promise<T[]> {
    const params: Record<string, any> = {};
    const whereCtx = this.whereContext();
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect, '', whereCtx);
    const orderSql = buildOrderBy(args?.orderBy, this.dialect);
    const take = args?.take;
    const skip = args?.skip;
    const hasSkip = skip !== undefined && skip !== null;

    let cols = "*";
    if (args?.select && typeof args.select === "object") {
      const relationKeys = getRelationsForModel(this.modelName);
      const hasRelationSelect = Object.keys(args.select).some(k => k === '_count' || relationKeys[k]);
      const fields = getFieldsForModel(this.modelName);
      const selectedKeys = Object.keys(args.select).filter(k => args.select[k] === true && (Object.keys(fields).length === 0 || fields[k]));
      if (selectedKeys.length > 0 && !hasRelationSelect) {
        cols = selectedKeys.map(k => quote(k, this.dialect)).join(", ");
      }
    }

    let query: string;
    if (take !== undefined && !hasSkip) {
      if (this.dialect === 'postgres' || this.dialect === 'mysql' || this.dialect === 'sqlite') {
        query = `SELECT ${cols} FROM ${this.tableName}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        if (orderSql) query += ` ${orderSql}`;
        query += ` LIMIT ${take}`;
      } else {
        query = `SELECT TOP (${take}) ${cols} FROM ${this.tableName}${this.nolock}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        if (orderSql) query += ` ${orderSql}`;
      }
    } else if (hasSkip) {
      if (this.dialect === 'postgres' || this.dialect === 'mysql' || this.dialect === 'sqlite') {
        query = `SELECT ${cols} FROM ${this.tableName}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        if (orderSql) query += ` ${orderSql}`;
        const limit = take ?? (this.dialect === 'sqlite' ? '-1' : this.dialect === 'mysql' ? '18446744073709551615' : 'ALL');
        query += ` LIMIT ${limit} OFFSET ${skip}`;
      } else {
        // mssql requires ORDER BY before OFFSET/FETCH
        query = `SELECT ${cols} FROM ${this.tableName}${this.nolock}`;
        if (whereSql) query += ` WHERE ${whereSql}`;
        query += ` ${orderSql || 'ORDER BY (SELECT NULL)'}`;
        query += ` OFFSET ${skip} ROWS`;
        if (take !== undefined) {
          query += ` FETCH NEXT ${take} ROWS ONLY`;
        }
      }
    } else {
      query = `SELECT ${cols} FROM ${this.tableName}${this.nolock}`;
      if (whereSql) query += ` WHERE ${whereSql}`;
      if (orderSql) query += ` ${orderSql}`;
    }

    const rows = await this.doExec<T>(query, params);

    if (args?.include) {
      await resolveIncludes(this.modelName, rows, args.include, this.adapter);
    }
    if (args?.select && typeof args.select === 'object') {
      const relationKeys = getRelationsForModel(this.modelName);
      const hasRelationSelect = Object.keys(args.select).some(k => k === '_count' || relationKeys[k]);
      if (hasRelationSelect) {
        await resolveIncludes(this.modelName, rows, args.select, this.adapter);
      }
      return rows.map((r: any) => projectFields(r, args.select));
    }

    return rows;
  }

  async findFirst(args?: { where?: any; orderBy?: any; select?: any; include?: any }): Promise<T | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: { where: any; select?: any; include?: any }): Promise<T | null> {
    return this.findFirst({ where: args.where, select: args.select, include: args.include });
  }

  async count(args?: { where?: any }): Promise<number> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect, '', this.whereContext());
    let query = `SELECT COUNT(*) AS cnt FROM ${this.tableName}${this.nolock}`;
    if (whereSql) query += ` WHERE ${whereSql}`;
    const rows = await this.doExec<any>(query, params);
    return Number(rows[0]?.cnt ?? rows[0]?.CNT ?? 0);
  }

  async create(args: { data: Partial<T> | any; include?: any; select?: any }): Promise<T> {
    const modelRelations = getRelationsForModel(this.modelName);
    const rawData = { ...args.data };
    const relationWrites: Record<string, any> = {};

    for (const key of Object.keys(rawData)) {
      if (modelRelations[key] && typeof rawData[key] === 'object' && rawData[key] !== null && !(rawData[key] instanceof Date)) {
        relationWrites[key] = rawData[key];
        delete rawData[key];
      }
    }

    const fields = getFieldsForModel(this.modelName);
    const idFieldName = resolveIdField(fields);

    const data: any = { ...rawData };
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

    const createdRecord = (await this.findFirst({ where: idFieldName ? { [idFieldName]: data[idFieldName] } : data })) as any;

    // Handle nested relation writes
    for (const [relKey, relWrite] of Object.entries(relationWrites)) {
      const relation = modelRelations[relKey];
      if (!relation) continue;
      const childClient = this.adapter.table(relation.modelName);
      if (relWrite.create) {
        const createItems = Array.isArray(relWrite.create) ? relWrite.create : [relWrite.create];
        for (const item of createItems) {
          await childClient.create({
            data: {
              ...item,
              [relation.foreignKey]: createdRecord[relation.localKey],
            },
          });
        }
      }
    }

    if (args.include) {
      await resolveIncludes(this.modelName, [createdRecord], args.include, this.adapter);
    }
    if (args.select) {
      await resolveIncludes(this.modelName, [createdRecord], args.select, this.adapter);
      return projectFields(createdRecord, args.select);
    }

    return createdRecord as T;
  }

  async createMany(args: { data: Partial<T>[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
    if (args.data.length === 0) return { count: 0 };

    const firstRow = args.data[0];
    if (firstRow === undefined) return { count: 0 };
    const firstCols = Object.keys(firstRow).filter(k => (firstRow as any)[k] !== undefined);

    const sameColumns = args.data.every(row => {
      const cols = Object.keys(row).filter(k => (row as any)[k] !== undefined);
      return cols.length === firstCols.length && firstCols.every(col => cols.includes(col));
    });

    const fields = getFieldsForModel(this.modelName);
    const idFieldName = resolveIdField(fields);
    const idDef = idFieldName ? fields[idFieldName] : undefined;
    const idType = typeof idDef === 'string' ? idDef : (idDef?.ts || idDef?.sql || idDef?.type || '');
    const generatesId = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(String(idType).toLowerCase());
    const needsGeneratedId = idFieldName && generatesId && args.data.some(row => !(row as any)[idFieldName]);

    // Rows needing generated IDs follow create's default handling.
    if (firstCols.length > 0 && sameColumns && !needsGeneratedId && !args.skipDuplicates) {
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
      await this.doExecuteRaw(query, params);
      return { count: args.data.length };
    }

    // Row-by-row fallback
    let count = 0;
    for (const row of args.data) {
      try { await this.create({ data: row }); count++; }
      catch (e) { if (!args.skipDuplicates || !isDuplicateKeyError(e, this.dialect)) throw e; }
    }
    return { count };
  }

  async update(args: { where: any; data: Partial<T> | any; include?: any; select?: any }): Promise<T> {
    const modelRelations = getRelationsForModel(this.modelName);
    const rawData = { ...args.data };
    const relationWrites: Record<string, any> = {};

    for (const key of Object.keys(rawData)) {
      if (modelRelations[key] && typeof rawData[key] === 'object' && rawData[key] !== null && !(rawData[key] instanceof Date)) {
        relationWrites[key] = rawData[key];
        delete rawData[key];
      }
    }

    const setCols = Object.keys(rawData).filter(k => rawData[k] !== undefined);
    if (setCols.length > 0) {
      const params: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_', this.whereContext());
      const sets: string[] = [];
      for (const col of setCols) {
        appendUpdateSet(sets, params, col, rawData[col], this.dialect);
      }
      if (sets.length > 0) {
        const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
        await this.doExecuteRaw(query, params);
      }
    }

    const updatedRecord = (await this.findFirst({ where: args.where })) as any;

    // Handle nested writes
    for (const [relKey, relWrite] of Object.entries(relationWrites)) {
      const relation = modelRelations[relKey];
      if (!relation) continue;
      const childClient = this.adapter.table(relation.modelName);
      if (relWrite.create) {
        const createItems = Array.isArray(relWrite.create) ? relWrite.create : [relWrite.create];
        for (const item of createItems) {
          await childClient.create({
            data: {
              ...item,
              [relation.foreignKey]: updatedRecord[relation.localKey],
            },
          });
        }
      }
      if (relWrite.update) {
        const updateObj = relWrite.update;
        await childClient.update({
          where: updateObj.where,
          data: updateObj.data,
        });
      }
      if (relWrite.disconnect) {
        const disc = relWrite.disconnect;
        await childClient.updateMany({
          where: disc,
          data: { [relation.foreignKey]: null },
        });
      }
    }

    if (args.include) {
      await resolveIncludes(this.modelName, [updatedRecord], args.include, this.adapter);
    }
    if (args.select) {
      await resolveIncludes(this.modelName, [updatedRecord], args.select, this.adapter);
      return projectFields(updatedRecord, args.select);
    }

    return updatedRecord as T;
  }

  async updateMany(args: { where?: any; data: Partial<T> }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_', this.whereContext());
    const setCols = Object.keys(args.data).filter(k => (args.data as any)[k] !== undefined);
    const sets: string[] = [];

    for (const col of setCols) {
      appendUpdateSet(sets, params, col, (args.data as any)[col], this.dialect);
    }

    if (sets.length === 0) return { count: 0 };

    const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const count = await this.doExecuteRaw(query, params);
    return { count };
  }

  async delete(args: { where: any }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, '', this.whereContext());
    await this.doExecuteRaw(`DELETE FROM ${this.tableName} WHERE ${whereSql}`, params);
    return existing as T;
  }

  async deleteMany(args?: { where?: any }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect, '', this.whereContext());
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
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect, '', this.whereContext());
    const aggs: string[] = [];

    if (args._count) {
      aggs.push('COUNT(*) AS cnt_all');
      if (typeof args._count === 'object') {
        for (const f of selectedAggregateFields(args._count)) {
          if (f !== '_all') aggs.push(`COUNT(${quote(f, this.dialect)}) AS cnt_${sanitizeParamName(f)}`);
        }
      }
    }
    if (args._sum) for (const f of selectedAggregateFields(args._sum)) aggs.push(`SUM(${quote(f, this.dialect)}) AS sum_${sanitizeParamName(f)}`);
    if (args._avg) for (const f of selectedAggregateFields(args._avg)) aggs.push(`AVG(${quote(f, this.dialect)}) AS avg_${sanitizeParamName(f)}`);
    if (args._min) for (const f of selectedAggregateFields(args._min)) aggs.push(`MIN(${quote(f, this.dialect)}) AS min_${sanitizeParamName(f)}`);
    if (args._max) for (const f of selectedAggregateFields(args._max)) aggs.push(`MAX(${quote(f, this.dialect)}) AS max_${sanitizeParamName(f)}`);

    if (aggs.length === 0) throw new Error('Aggregate requires at least one aggregator field');

    const query = `SELECT ${aggs.join(', ')} FROM ${this.tableName}${this.nolock}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const rows = await this.doExec<any>(query, params);
    const row = rows[0] || {};

    const result: any = {};
    if (args._count) {
      const allCount = Number(row.cnt_all ?? row._count ?? 0);
      result._count = { _all: allCount };
      if (typeof args._count === 'object') {
        for (const f of selectedAggregateFields(args._count)) {
          if (f === '_all') continue;
          const k = `cnt_${sanitizeParamName(f)}`;
          result._count[f] = row[k] !== undefined ? Number(row[k]) : allCount;
        }
      }
    }
    if (args._sum) {
      result._sum = {};
      for (const f of selectedAggregateFields(args._sum)) {
        const k = `sum_${sanitizeParamName(f)}`;
        result._sum[f] = row[k] !== null && row[k] !== undefined ? Number(row[k]) : null;
      }
    }
    if (args._avg) {
      result._avg = {};
      for (const f of selectedAggregateFields(args._avg)) {
        const k = `avg_${sanitizeParamName(f)}`;
        result._avg[f] = row[k] !== null && row[k] !== undefined ? Number(row[k]) : null;
      }
    }
    if (args._min) {
      result._min = {};
      for (const f of selectedAggregateFields(args._min)) {
        const k = `min_${sanitizeParamName(f)}`;
        result._min[f] = row[k] ?? null;
      }
    }
    if (args._max) {
      result._max = {};
      for (const f of selectedAggregateFields(args._max)) {
        const k = `max_${sanitizeParamName(f)}`;
        result._max[f] = row[k] ?? null;
      }
    }

    return result;
  }

  async groupBy(args: any): Promise<any[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect, '', this.whereContext());
    const byFields = normalizeByFields(args?.by);
    if (byFields.length === 0) throw new Error("groupBy requires 'by' fields");
    const byCols = byFields.map((b: string) => quote(b, this.dialect)).join(', ');
    const aggs: string[] = ['COUNT(*) AS _count'];
    if (args?._sum) for (const f of selectedAggregateFields(args._sum)) aggs.push(`SUM(${quote(f, this.dialect)}) AS _sum_${f}`);
    if (args?._avg) for (const f of selectedAggregateFields(args._avg)) aggs.push(`AVG(${quote(f, this.dialect)}) AS _avg_${f}`);
    if (args?._min) for (const f of selectedAggregateFields(args._min)) aggs.push(`MIN(${quote(f, this.dialect)}) AS _min_${f}`);
    if (args?._max) for (const f of selectedAggregateFields(args._max)) aggs.push(`MAX(${quote(f, this.dialect)}) AS _max_${f}`);
    let query = `SELECT ${byCols}, ${aggs.join(', ')} FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} GROUP BY ${byCols}`;
    const orderSql = buildOrderBy(args?.orderBy, this.dialect);
    const hasSkip = args?.skip !== undefined && args?.skip !== null;
    const hasTake = args?.take !== undefined && args?.take !== null;
    if (orderSql) query += ` ${orderSql}`;
    else if (hasSkip || hasTake) query += ` ORDER BY ${byCols}`;
    if (hasSkip || hasTake) {
      const skip = toNonNegativeInt(args?.skip);
      const take = toNonNegativeInt(args?.take, 1);
      if (this.dialect === 'postgres' || this.dialect === 'mysql' || this.dialect === 'sqlite') {
        const limit = hasTake ? take : (this.dialect === 'sqlite' ? '-1' : this.dialect === 'mysql' ? '18446744073709551615' : 'ALL');
        query += ` LIMIT ${limit} OFFSET ${skip}`;
      } else {
        query += ` OFFSET ${skip} ROWS`;
        if (hasTake) query += ` FETCH NEXT ${take} ROWS ONLY`;
      }
    }
    return this.doExec(query, params);
  }

  /**
   * Runs similarity search in NBase and hydrates the matching rows from the
   * relational table, keeping the `{ ...row, distance }` shape the other
   * engines return.
   */
  private async searchViaNBase(
    nbase: { client: NBaseVectorClient; config: NBaseAdapterConfig },
    args: { vector: number[]; take?: number; where?: any },
    metric: 'cosine' | 'euclidean' | 'dot',
    take: number,
  ): Promise<(T & { distance: number })[]> {
    const { client, config } = nbase;
    const idField = config.idField ?? 'an5Id';
    const modelField = config.modelField ?? 'an5Model';

    const results = await client.search(args.vector, {
      k: take,
      // NBase implements cosine and euclidean; a dot-product request falls back
      // to cosine, which still orders the results sensibly.
      distanceMetric: metric === 'euclidean' ? 'euclidean' : 'cosine',
      includeMetadata: true,
      ...(config.method ? { method: config.method } : {}),
    });

    // Map each hit back to its row id. Ids are written as `Model:id`, and the
    // metadata key is honoured for projects that index vectors themselves.
    const ids: string[] = [];
    const distances = new Map<string, number>();
    for (const hit of results) {
      const fromMetadata = hit.metadata?.[idField];
      const rawId = fromMetadata !== undefined && fromMetadata !== null
        ? String(fromMetadata)
        : parseVectorId(hit.id).id;
      if (!rawId) continue;
      const model = hit.metadata?.[modelField] ?? parseVectorId(hit.id).model;
      ids.push(model === this.modelName ? rawId : `${model}:${rawId}`);
      distances.set(ids[ids.length - 1] as string, hit.dist);
    }
    if (ids.length === 0) return [];

    const pk = this.primaryKeyColumn();
    const inList = ids.map((_, i) => `@nbase_id_${i}`).join(', ');
    const idParams: Record<string, any> = {};
    ids.forEach((id, i) => { idParams[`nbase_id_${i}`] = id; });
    idParams.take = take;

    const selectColumns = this.modelFields().map((f) => quote(f, this.dialect)).join(', ');
    const columns = selectColumns ? `${selectColumns}, ${quote(pk, this.dialect)} AS __an5_nbase_key` : `${quote(pk, this.dialect)} AS __an5_nbase_key`;
    const query = `SELECT ${columns} FROM ${this.tableName} WHERE ${quote(pk, this.dialect)} IN (${inList})`;

    const rows = await this.adapter.exec<Record<string, any>>(query, idParams);
    const byKey = new Map<string, Record<string, any>>();
    for (const row of rows ?? []) {
      byKey.set(String(row.__an5_nbase_key), row);
    }

    const hydrated: (T & { distance: number })[] = [];
    for (const id of ids) {
      const row = byKey.get(id);
      if (!row) continue;
      const { __an5_nbase_key, ...rest } = row;
      hydrated.push({ ...(rest as T), distance: distances.get(id) ?? 0 } as T & { distance: number });
      if (hydrated.length >= take) break;
    }
    return hydrated;
  }

  /**
   * Vector search for an adapter configured with only an NBase connection
   * string. The hit id and metadata are the result, since there is no
   * relational row to hydrate.
   */
  private async searchViaNBaseOnly(
    nbase: { client: NBaseVectorClient; config: NBaseAdapterConfig },
    args: { vector: number[]; take?: number },
    metric: 'cosine' | 'euclidean' | 'dot',
    take: number,
  ): Promise<Array<Record<string, unknown> & { distance: number }>> {
    const { client, config } = nbase;
    const idField = config.idField ?? 'an5Id';
    const results = await client.search(args.vector, {
      k: take,
      distanceMetric: metric === 'euclidean' ? 'euclidean' : 'cosine',
      includeMetadata: true,
      ...(config.method ? { method: config.method } : {}),
    });

    return results.map((hit) => {
      const metadata = { ...(hit.metadata ?? {}) };
      if (metadata[idField] === undefined) {
        const parsed = parseVectorId(hit.id);
        if (parsed.id) metadata[idField] = parsed.id;
        if (parsed.model) metadata[config.modelField ?? 'an5Model'] = parsed.model;
      }
      return { id: hit.id, ...metadata, distance: hit.dist };
    });
  }

  /** The primary key column registered for this model, falling back to `id`. */
  private primaryKeyColumn(): string {
    const fields = this.modelFields();
    const marked = fields.find((f) => f === 'id');
    return marked ?? fields[0] ?? 'id';
  }

  /** Scalar column names known for this model from the generated metadata. */
  private modelFields(): string[] {
    const fields = getFieldsForModel(this.modelName);
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      return Object.keys(fields as Record<string, unknown>);
    }
    return [];
  }

  /**
   * Pushes a table's embedding column into NBase so it can be searched there.
   *
   * Each vector keeps the row id in its metadata, which is what lets
   * `vectorSearch` return real rows instead of bare vector ids.
   */
  async indexVectorsInNBase(args: {
    vectorField?: string;
    where?: any;
    take?: number;
    batchSize?: number;
  } = {}): Promise<{ indexed: number }> {
    const nbase = this.adapter.nbaseClient?.() ?? null;
    if (!nbase) {
      throw new Error(
        'No NBase instance configured. Use a nbase:// connection string, e.g. createAn5Adapter({ connectionString: "nbase://localhost:1307" }).',
      );
    }
    if (this.adapter.nbaseOnly) {
      throw new Error(
        'indexVectorsInNBase reads the vectors from a table, but this adapter was created with an nbase:// connection string and has no database. ' +
          'Create the adapter with your database connection string to index, or add the vectors with the NBase client directly.',
      );
    }
    const vectorField = args.vectorField || 'embedding';
    const batchSize = args.batchSize ?? 200;
    const pk = this.primaryKeyColumn();
    const rows = await this.findMany({ ...(args.where ? { where: args.where } : {}), ...(args.take ? { take: args.take } : {}) });

    let indexed = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const vectors = batch
        .map((row) => {
          const raw = (row as Record<string, unknown>)[vectorField];
          if (raw === undefined || raw === null) return null;
          let vector: number[];
          try {
            vector = typeof raw === 'string' ? JSON.parse(raw) : (raw as number[]);
          } catch {
            return null;
          }
          if (!Array.isArray(vector) || vector.length === 0) return null;
          return {
            id: buildVectorId(this.modelName, String((row as Record<string, unknown>)[pk])),
            vector,
            metadata: {
              [nbase.config.idField ?? 'an5Id']: String((row as Record<string, unknown>)[pk]),
              [nbase.config.modelField ?? 'an5Model']: this.modelName,
            },
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      if (vectors.length === 0) continue;
      const result = await nbase.client.addVectors(vectors);
      indexed += result.count;
    }
    return { indexed };
  }

  async vectorSearch(args: {
    vector: number[];
    take?: number;
    where?: any;
    vectorField?: string;
    distanceMetric?: 'cosine' | 'euclidean' | 'dot';
    vectorElementType?: 'float32' | 'float16' | 'uint8';
  }): Promise<(T & { distance: number })[]> {
    const vectorField = args.vectorField || 'embedding';
    const METRICS = ['cosine', 'euclidean', 'dot'];
    const ELEMENT_TYPES = ['float32', 'float16', 'uint8'];
    const metric = METRICS.includes(args.distanceMetric as string) ? args.distanceMetric! : 'cosine';
    const elementType = ELEMENT_TYPES.includes(args.vectorElementType as string) ? args.vectorElementType! : 'float32';
    const take = args.take ?? 10;
    const dim = Array.isArray(args.vector) ? args.vector.length : 0;
    const vectorJson = JSON.stringify(args.vector);
    const col = quote(vectorField, this.dialect);
    const params: Record<string, any> = { query_vector: vectorJson };

    // 0. NBase, when the project configured one: the vectors live in the vector
    //    database, so the search never loads the table into memory.
    const nbase = this.adapter.nbaseClient?.() ?? null;
    if (nbase) {
      try {
        // With an NBase-only connection string there is no table to read rows
        // from, so the hits are returned as the vector metadata itself.
        if (this.adapter.nbaseOnly) {
          return (await this.searchViaNBaseOnly(nbase, args, metric, take)) as (T & { distance: number })[];
        }
        return await this.searchViaNBase(nbase, args, metric, take);
      } catch (err) {
        if (!(err instanceof NBaseError)) throw err;
        // A NBase outage must not take vector search down with it; fall through
        // to the database instead of failing the query.
        console.warn(`[an5] NBase vector search unavailable (${err.message}); falling back to ${this.dialect}.`);
      }
    }

    // 1. Try native dialect execution
    if (this.dialect === 'postgres') {
      const op = metric === 'cosine' ? '<=>' : metric === 'dot' ? '<#>' : '<->';
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, '', this.whereContext());
      const query = `SELECT *, (${col} ${op} @query_vector::vector) AS distance FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY distance ASC LIMIT ${take}`;
      try {
        return await this.doExec<(T & { distance: number })>(query, params);
      } catch (err: any) {
        const msg = String(err?.message || '').toLowerCase();
        if (!msg.includes('vector') && !msg.includes('operator does not exist')) throw err;
      }
    } else if (this.dialect === 'mssql') {
      const distFn = metric === 'cosine' ? 'cosine' : metric === 'euclidean' ? 'euclidean' : 'dot';
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, '', this.whereContext());
      const query = `SELECT TOP (${take}) *, VECTOR_DISTANCE('${distFn}', ${col}, CAST(@query_vector AS VECTOR(${dim}, ${elementType}))) AS distance FROM ${this.tableName}${this.nolock}${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY distance ASC`;
      try {
        return await this.doExec<(T & { distance: number })>(query, params);
      } catch (err: any) {
        const msg = String(err?.message || '').toLowerCase();
        const isUnsupported =
          msg.includes('vector_distance') ||
          msg.includes('syntax near') ||
          msg.includes('not a recognized built-in function') ||
          msg.includes('not a defined system type') ||
          msg.includes('type "vector"') ||
          msg.includes('pgvector') ||
          msg.includes('operator does not exist') ||
          msg.includes('limit of 1998') ||
          err?.number === 195 ||
          err?.number === 102 ||
          err?.number === 319 ||
          err?.originalError?.number === 319;
        if (!isUnsupported) throw err;
      }
    }

    // 2. Fallback: in-memory similarity computation when native vector support is unavailable
    const rows = await this.findMany({ where: args.where });

    const scored: { row: T; dist: number }[] = [];
    for (const row of rows) {
      const raw = (row as any)[vectorField];
      if (!raw) continue;
      let vec: number[] = [];
      try { vec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      if (!Array.isArray(vec) || vec.length !== args.vector.length) continue;

      let dot = 0, m1 = 0, m2 = 0;
      for (let i = 0; i < args.vector.length; i++) {
        const av = args.vector[i] ?? 0;
        const bv = vec[i] ?? 0;
        dot += av * bv;
        m1 += av ** 2;
        m2 += bv ** 2;
      }
      const cosine = m1 && m2 ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
      const dist = metric === 'cosine'
        ? 1 - cosine
        : metric === 'dot'
          ? -dot
          : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - (vec[i] ?? 0)) ** 2, 0));
      scored.push({ row, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, take).map(s => ({ ...s.row as any, distance: s.dist }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────────

export function createAn5Adapter(config: AnyAdapterConfig): AnyAdapter;
export function createAn5Adapter<TModels extends object>(
  config: AnyAdapterConfig
): import('./typed').TypedAn5Adapter<TModels>;
export function createAn5Adapter(config: AnyAdapterConfig): AnyAdapter {
  if (isSheetsConfig(config)) return new An5SheetsAdapter(config);
  if (config.connectionString && config.connectionString.trim().startsWith('googlesheets://')) {
    return new An5SheetsAdapter(parseSheetsConnectionString(config.connectionString));
  }
  return new An5Adapter(config);
}

export const createAdapter = createAn5Adapter;

export function createBrowserSqliteAdapter(config: any): An5Adapter {
  const { SqliteBrowserEngine } = require('./sqlite/browserEngine.js');
  return new An5Adapter({ engine: new SqliteBrowserEngine(config) });
}

function normalizeAffectedCount(result: any): number {
  if (typeof result === 'number') return result;
  if (!result) return 0;
  if (Array.isArray(result.rowsAffected)) return Number(result.rowsAffected[0] ?? 0);
  if (typeof result.rowsAffected === 'number') return result.rowsAffected;
  if (typeof result.count === 'number') return result.count;
  return 0;
}

export function executorFromAdapter(adapterLike: any): any {
  if (!adapterLike) return adapterLike;
  if (typeof adapterLike === 'function' && adapterLike.executeRaw) {
    return adapterLike;
  }
  return Object.assign(
    async (queryText: string, params?: Record<string, any>) => {
      return typeof adapterLike === 'function'
        ? adapterLike(queryText, params)
        : adapterLike.exec(queryText, params);
    },
    {
      executeRaw: async (queryText: string, params?: Record<string, any>) => {
        if (typeof adapterLike._executeRaw === 'function') {
          return adapterLike._executeRaw(queryText, params);
        }
        if (typeof adapterLike.executeRaw === 'function') {
          return adapterLike.executeRaw(queryText, params);
        }
        const res = typeof adapterLike === 'function'
          ? await adapterLike(queryText, params)
          : await adapterLike.exec(queryText, params);
        return normalizeAffectedCount(res);
      },
      transaction: adapterLike.$transaction
        ? async (fn: (txExecutor: any) => Promise<any>, options?: { timeout?: number }) => {
            return adapterLike.$transaction(async (tx: any) => fn(executorFromAdapter(tx)), options);
          }
        : undefined,
      beginTransaction: adapterLike.$begin
        ? async () => {
            const tx = await adapterLike.$begin();
            return {
              executor: executorFromAdapter(tx),
              commit: () => tx.$commit(),
              rollback: () => tx.$rollback(),
            };
          }
        : undefined,
    }
  );
}
