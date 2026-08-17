import { generateUUID } from './base/uuid';

import {
  An5SheetsAdapter,
  An5SheetsAdapterConfig,
  SheetsTableClient,
} from './googlesheets';
import { parseSheetsConnectionString } from './googlesheets/parseConnectionString';
import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
import { buildOrderBy, parseWhere, quote } from './base/sql';
import {
  getFieldsForModel,
  getModelToTable,
  getRelationMap,
  getRelationsForModel,
  setAdapterMetadata,
  type AdapterMetadata,
  type RelationDef,
} from './base/metadata';
export type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from './base/types';
export { setAdapterMetadata, type AdapterMetadata } from './base/metadata';

export type AnyAdapter = An5Adapter | An5SheetsAdapter;
export type AnyAdapterConfig = An5AdapterConfig | An5SheetsAdapterConfig | { connectionString: string };

function isSheetsConfig(config: AnyAdapterConfig): config is An5SheetsAdapterConfig {
  return (config as any).spreadsheetId !== undefined;
}

function sanitizeParamName(name: string): string {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `p_${cleaned}`;
}

function appendUpdateSet(sets: string[], params: Record<string, any>, col: string, val: any, dialect: Dialect): void {
  const quoted = quote(col, dialect);
  const safeCol = sanitizeParamName(col);
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    if (val.increment !== undefined) {
      sets.push(`${quoted} = ${quoted} + @s_${safeCol}_inc`);
      params[`s_${safeCol}_inc`] = val.increment;
      return;
    }
    if (val.decrement !== undefined) {
      sets.push(`${quoted} = ${quoted} - @s_${safeCol}_dec`);
      params[`s_${safeCol}_dec`] = val.decrement;
      return;
    }
    if (val.multiply !== undefined) {
      sets.push(`${quoted} = ${quoted} * @s_${safeCol}_mul`);
      params[`s_${safeCol}_mul`] = val.multiply;
      return;
    }
    if (val.divide !== undefined) {
      sets.push(`${quoted} = ${quoted} / @s_${safeCol}_div`);
      params[`s_${safeCol}_div`] = val.divide;
      return;
    }
    if (val.set !== undefined) {
      sets.push(`${quoted} = @s_${safeCol}_set`);
      params[`s_${safeCol}_set`] = val.set;
      return;
    }
  }

  sets.push(`${quoted} = @s_${safeCol}`);
  params[`s_${safeCol}`] = val;
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
    const uniqueKeys = Array.from(new Set(rows.map(r => r[localKey]).filter(k => k !== undefined && k !== null)));

    if (uniqueKeys.length === 0) {
      rows.forEach(r => { r[key] = isMany ? [] : null; });
      continue;
    }

    const subArgs: any = typeof value === 'object' ? { ...value } : {};
    const nestedInclude = subArgs.include;
    const nestedSelect = subArgs.select;

    const subWhere: any = {
      [foreignKey]: { in: uniqueKeys },
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
      const k = r[foreignKey];
      if (!groupMap.has(k)) groupMap.set(k, []);
      groupMap.get(k)!.push(outputRows[idx]);
    });

    rows.forEach(r => {
      const k = r[localKey];
      const matches = groupMap.get(k) || [];
      if (isMany) {
        r[key] = matches;
      } else {
        r[key] = matches[0] || null;
      }
    });
  }
}

function createAdapterProxy<T extends object>(
  targetObj: T,
  tableGetter: (modelName: string) => any
): T {
  return new Proxy(targetObj, {
    get(target: any, prop: string | symbol, receiver) {
      if (typeof prop === 'string') {
        if (prop in target || prop.startsWith('_') || prop.startsWith('$') || typeof target[prop] === 'function') {
          const val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
        let modelName = prop;
        const modelToTable = getModelToTable();
        if (!modelToTable[prop]) {
          const lowerProp = prop.toLowerCase();
          for (const [mName, tName] of Object.entries(modelToTable)) {
            const lowerM = mName.toLowerCase();
            const lowerT = (tName as string).toLowerCase();
            if (
              lowerM === lowerProp ||
              lowerT === lowerProp ||
              lowerM + 's' === lowerProp ||
              lowerM + 'es' === lowerProp ||
              lowerT + 's' === lowerProp ||
              lowerT + 'es' === lowerProp
            ) {
              modelName = mName;
              break;
            }
          }
        }
        return tableGetter(modelName);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ─── An5Adapter ────────────────────────────────────────────────────────────────────

export class An5Adapter {
  [key: string]: any;
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
      return createAdapterProxy(this, (name) => this.table(name));
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

    const cs = (adapterConfig.connectionString || '').trim();
    if (cs.startsWith('googlesheets://')) {
      this.sheetsAdapter = new An5SheetsAdapter(parseSheetsConnectionString(cs));
      return createAdapterProxy(this, (name) => this.table(name));
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

  private async doExec<U = any>(query: string, params?: Record<string, any>): Promise<U[]> {
    return this.adapter.exec<U>(query, params);
  }

  private async doExecuteRaw(query: string, params?: Record<string, any>): Promise<number> {
    return this.adapter._executeRaw(query, params);
  }

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any; include?: any }): Promise<T[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
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
        query += ` LIMIT ${take ?? 'ALL'} OFFSET ${skip}`;
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
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
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
    const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
      ? 'id'
      : Object.keys(fields).find((name) => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');

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
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_');
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
    const whereSql = parseWhere(this.modelName, args.where, params, this.dialect, 'w_');
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
    const whereSql = parseWhere(this.modelName, args?.where, params, this.dialect);
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
        if (hasTake) query += ` LIMIT ${take}`;
        query += ` OFFSET ${skip}`;
      } else {
        query += ` OFFSET ${skip} ROWS`;
        if (hasTake) query += ` FETCH NEXT ${take} ROWS ONLY`;
      }
    }
    return this.doExec(query, params);
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

    // 1. Try native dialect execution
    if (this.dialect === 'postgres') {
      const op = metric === 'cosine' ? '<=>' : metric === 'dot' ? '<#>' : '<->';
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect);
      const query = `SELECT *, (${col} ${op} @query_vector::vector) AS distance FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY distance ASC LIMIT ${take}`;
      try {
        return await this.doExec<(T & { distance: number })>(query, params);
      } catch (err: any) {
        const msg = String(err?.message || '').toLowerCase();
        if (!msg.includes('vector') && !msg.includes('operator does not exist')) throw err;
      }
    } else if (this.dialect === 'mssql') {
      const distFn = metric === 'cosine' ? 'cosine' : metric === 'euclidean' ? 'euclidean' : 'dot';
      const whereSql = parseWhere(this.modelName, args.where, params, this.dialect);
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
    return scored.slice(0, take).map(s => ({ ...s.row as any, distance: s.dist }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────────

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
