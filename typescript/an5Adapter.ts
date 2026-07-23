/**
 * an5Adapter.ts
 * Standalone TypeScript runtime adapter for AN5 ORM.
 * Provides query execution and table client factory - can be used independently
 * from the main project runtime (an5Orm.ts).
 *
 * Usage:
 *   import { createAn5Adapter } from './an5Client/typescript/an5Adapter';
 *   const db = createAn5Adapter({ connectionString: process.env.DATABASE_URL });
 */

import sql from 'mssql';
import { randomUUID } from 'crypto';
import { An5 } from 'an5-client/typescript';
import { modelToTable, relationMap, RelationDef, modelFields } from 'an5-client/typescript/an5Metadata';

// ─── Connection Config ────────────────────────────────────────────────────────

export interface An5AdapterConfig {
  connectionString: string;
  /** Max pool connections (default: 10) */
  poolMax?: number;
  /** Request timeout ms (default: 60000) */
  requestTimeout?: number;
  /** Connection timeout ms (default: 15000) */
  connectionTimeout?: number;
}

function parseConnectionString(url: string): sql.config {
  const cleanUrl = (url || '').replace('sqlserver://', '');
  const parts = cleanUrl.split(';');
  const [server, portStr] = parts[0].split(':');
  const port = portStr ? parseInt(portStr, 10) : 1433;

  const config: any = {
    server,
    port,
    options: { encrypt: true, trustServerCertificate: true },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 60000,
    connectionTimeout: 15000,
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    const value = decodeURIComponent(part.slice(eqIdx + 1).trim());
    if (key === 'database') config.database = value;
    else if (key === 'user' || key === 'uid') config.user = value;
    else if (key === 'password' || key === 'pwd') config.password = value;
    else if (key === 'encrypt') config.options.encrypt = value === 'true';
    else if (key === 'trustservercertificate') config.options.trustServerCertificate = value === 'true';
  }
  return config;
}

// ─── Query Engine ─────────────────────────────────────────────────────────────

export class An5Adapter {
  private pool: Promise<sql.ConnectionPool> | null = null;
  private config: sql.config;

  constructor(adapterConfig: An5AdapterConfig) {
    this.config = parseConnectionString(adapterConfig.connectionString);
    if (adapterConfig.poolMax) this.config.pool = { ...this.config.pool, max: adapterConfig.poolMax };
    if (adapterConfig.requestTimeout) this.config.requestTimeout = adapterConfig.requestTimeout;
    if (adapterConfig.connectionTimeout) this.config.connectionTimeout = adapterConfig.connectionTimeout;
  }

  async getPool(): Promise<sql.ConnectionPool> {
    if (!this.pool) {
      this.pool = new sql.ConnectionPool(this.config).connect();
    }
    return this.pool;
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    const pool = await this.getPool();
    const req = new sql.Request(pool);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        req.input(k, v ?? null);
      }
    }
    const result = await req.query(query);
    return (result.recordset || []) as T[];
  }

  async $queryRawUnsafe<T = any>(query: string, ...values: any[]): Promise<T[]> {
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    const paramQuery = query.replace(/@p_(\d+)/g, (_, i) => `@p_${i}`);
    return this.exec<T>(paramQuery, params);
  }

  async $executeRaw(query: string, ...values: any[]): Promise<number> {
    const params: Record<string, any> = {};
    values.forEach((v, i) => { params[`p_${i}`] = v; });
    const pool = await this.getPool();
    const req = new sql.Request(pool);
    for (const [k, v] of Object.entries(params)) req.input(k, v ?? null);
    const result = await req.query(query);
    return result.rowsAffected[0] ?? 0;
  }

  async $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
    return this.$executeRaw(query, ...values);
  }

  async $connect(): Promise<void> {
    await this.getPool();
  }

  async $disconnect(): Promise<void> {
    if (this.pool) {
      const p = await this.pool;
      await p.close();
      this.pool = null;
    }
  }

  async $transaction<R>(fn: (tx: An5Adapter) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  async $transaction<R>(list: Promise<R>[]): Promise<R[]>;
  async $transaction(fn: any, options?: any): Promise<any> {
    if (typeof fn === 'function') return fn(this);
    return Promise.all(fn);
  }

  // ── Table client factory ──────────────────────────────────────────────────

  table<T = any>(modelName: string): AdapterTableClient<T> {
    return new AdapterTableClient<T>(this, modelName);
  }
}

// ─── Table Client ─────────────────────────────────────────────────────────────

function parseWhere(modelName: string, where: any, params: Record<string, any>, prefix = ''): string {
  if (!where) return '';
  const conditions: string[] = [];
  const tableName = modelToTable[modelName] || modelName;

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
      const sub = value.map((v, i) => parseWhere(modelName, v, params, `${prefix}or_${i}_`)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' OR ')})`);
    } else if (key === 'AND' && Array.isArray(value)) {
      const sub = value.map((v, i) => parseWhere(modelName, v, params, `${prefix}and_${i}_`)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' AND ')})`);
    } else {
      const pname = `${prefix}${key}`;
      const col = `[${key}]`;

      if (value === null) {
        conditions.push(`${col} IS NULL`);
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        const v = value as any;
        if (v.not !== undefined) {
          if (v.not === null) { conditions.push(`${col} IS NOT NULL`); }
          else { const p = `${pname}_not`; params[p] = v.not; conditions.push(`${col} <> @${p}`); }
        }
        if (v.equals !== undefined) { const p = `${pname}_eq`; params[p] = v.equals; conditions.push(`${col} = @${p}`); }
        if (v.contains !== undefined) { const p = `${pname}_co`; params[p] = `%${v.contains}%`; conditions.push(`${col} LIKE @${p}`); }
        if (v.startsWith !== undefined) { const p = `${pname}_sw`; params[p] = `${v.startsWith}%`; conditions.push(`${col} LIKE @${p}`); }
        if (v.endsWith !== undefined) { const p = `${pname}_ew`; params[p] = `%${v.endsWith}`; conditions.push(`${col} LIKE @${p}`); }
        if (v.gte !== undefined) { const p = `${pname}_gte`; params[p] = v.gte; conditions.push(`${col} >= @${p}`); }
        if (v.lte !== undefined) { const p = `${pname}_lte`; params[p] = v.lte; conditions.push(`${col} <= @${p}`); }
        if (v.gt !== undefined) { const p = `${pname}_gt`; params[p] = v.gt; conditions.push(`${col} > @${p}`); }
        if (v.lt !== undefined) { const p = `${pname}_lt`; params[p] = v.lt; conditions.push(`${col} < @${p}`); }
        if (v.in !== undefined) {
          if (Array.isArray(v.in) && v.in.length > 0) {
            const ps = v.in.map((x: any, i: number) => { const p = `${pname}_in${i}`; params[p] = x; return `@${p}`; });
            conditions.push(`${col} IN (${ps.join(', ')})`);
          } else {
            conditions.push('1=0');
          }
        }
      } else {
        params[pname] = value;
        conditions.push(`${col} = @${pname}`);
      }
    }
  }
  return conditions.join(' AND ');
}

function buildOrderBy(orderBy: any): string {
  if (!orderBy) return '';
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const entry of entries) {
    for (const [key, dir] of Object.entries(entry)) {
      parts.push(`[${key}] ${(dir as string).toUpperCase()}`);
    }
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

export class AdapterTableClient<T = any> {
  constructor(private adapter: An5Adapter, private modelName: string) {}

  private get tableName(): string {
    const name = this.modelName;
    let t = name;
    if (modelToTable[name]) t = modelToTable[name];
    else {
      const camel = name.charAt(0).toLowerCase() + name.slice(1);
      if (modelToTable[camel]) t = modelToTable[camel];
      else {
        const lower = name.toLowerCase();
        if (modelToTable[lower]) t = modelToTable[lower];
      }
    }

    if (t.startsWith('[')) return t;
    if (t.includes('.')) {
      return t.split('.').map(p => `[${p}]`).join('.');
    }
    return `[${t}]`;
  }

  async findMany(args?: { where?: any; orderBy?: any; skip?: number; take?: number; select?: any }): Promise<T[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params);
    const orderSql = buildOrderBy(args?.orderBy);
    const take = args?.take;
    const skip = args?.skip ?? 0;

    let query: string;
    if (take !== undefined) {
      query = `SELECT * FROM ${this.tableName} WITH (NOLOCK)`;
      if (whereSql) query += ` WHERE ${whereSql}`;
      if (orderSql) {
        query += ` ${orderSql}`;
      } else {
        query += ` ORDER BY (SELECT NULL)`;
      }
      query += ` OFFSET ${skip} ROWS FETCH NEXT ${take} ROWS ONLY`;
    } else {
      query = `SELECT * FROM ${this.tableName} WITH (NOLOCK)`;
      if (whereSql) query += ` WHERE ${whereSql}`;
      if (orderSql) query += ` ${orderSql}`;
    }
    return this.adapter.exec<T>(query, params);
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
    const whereSql = parseWhere(this.modelName, args?.where, params);
    let query = `SELECT COUNT(*) AS cnt FROM ${this.tableName} WITH (NOLOCK)`;
    if (whereSql) query += ` WHERE ${whereSql}`;
    const rows = await this.adapter.exec<any>(query, params);
    return Number(rows[0]?.cnt ?? 0);
  }

  async create(args: { data: Partial<T> }): Promise<T> {
    const fields = modelFields[this.modelName] || {};
    const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
      ? 'id'
      : Object.keys(fields).find((name) => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');

    const data: any = { ...args.data };
    if (idFieldName) {
      const fieldDef: any = fields[idFieldName];
      const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || fieldDef?.type || '');
      const normalizedType = String(rawType).toLowerCase();
      const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(normalizedType);
      if (isStringType && !data[idFieldName]) {
        data[idFieldName] = randomUUID();
      }
    }

    const cols = Object.keys(data).filter(k => data[k] !== undefined);
    const params: Record<string, any> = {};
    const vals: string[] = [];

    for (const col of cols) {
      const p = `c_${col}`;
      params[p] = data[col] instanceof Date ? data[col] : data[col];
      vals.push(`@${p}`);
    }

    const query = `INSERT INTO ${this.tableName} (${cols.map(c => `[${c}]`).join(', ')}) VALUES (${vals.join(', ')})`;
    await this.adapter.exec(query, params);
    return (await this.findFirst({ where: idFieldName ? { [idFieldName]: data[idFieldName] } : data })) as T;
  }

  async createMany(args: { data: Partial<T>[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
    let count = 0;
    for (const row of args.data) {
      try {
        await this.create({ data: row });
        count++;
      } catch (e) {
        if (!args.skipDuplicates) throw e;
      }
    }
    return { count };
  }

  async update(args: { where: any; data: Partial<T> }): Promise<T> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, 'w_');
    const setCols = Object.keys(args.data).filter(k => (args.data as any)[k] !== undefined);
    const sets: string[] = [];

    for (const col of setCols) {
      const p = `s_${col}`;
      params[p] = (args.data as any)[col];
      sets.push(`[${col}] = @${p}`);
    }

    const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    await this.adapter.exec(query, params);
    return (await this.findFirst({ where: args.where })) as T;
  }

  async updateMany(args: { where?: any; data: Partial<T> }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params, 'w_');
    const setCols = Object.keys(args.data).filter(k => (args.data as any)[k] !== undefined);
    const sets: string[] = [];

    for (const col of setCols) {
      const p = `s_${col}`;
      params[p] = (args.data as any)[col];
      sets.push(`[${col}] = @${p}`);
    }

    const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const rows = await this.adapter.exec(query, params);
    return { count: (rows as any).rowsAffected ?? 0 };
  }

  async delete(args: { where: any }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args.where, params);
    const query = `DELETE FROM ${this.tableName} WHERE ${whereSql}`;
    await this.adapter.exec(query, params);
    return existing as T;
  }

  async deleteMany(args?: { where?: any }): Promise<{ count: number }> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params);
    const query = `DELETE FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    await this.adapter.exec(query, params);
    return { count: 0 };
  }

  async upsert(args: { where: any; create: Partial<T>; update: Partial<T> }): Promise<T> {
    const existing = await this.findFirst({ where: args.where });
    if (existing) {
      return this.update({ where: args.where, data: args.update });
    } else {
      return this.create({ data: args.create });
    }
  }

  async aggregate(args: any): Promise<any> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params);
    const aggs: string[] = [];
    if (args._count) aggs.push('COUNT(*) AS _count');
    if (args._sum) for (const f of Object.keys(args._sum)) aggs.push(`SUM([${f}]) AS _sum_${f}`);
    if (args._avg) for (const f of Object.keys(args._avg)) aggs.push(`AVG([${f}]) AS _avg_${f}`);
    if (args._min) for (const f of Object.keys(args._min)) aggs.push(`MIN([${f}]) AS _min_${f}`);
    if (args._max) for (const f of Object.keys(args._max)) aggs.push(`MAX([${f}]) AS _max_${f}`);

    const query = `SELECT ${aggs.join(', ')} FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
    const rows = await this.adapter.exec(query, params);
    return rows[0] ?? {};
  }

  async groupBy(args: any): Promise<any[]> {
    const params: Record<string, any> = {};
    const whereSql = parseWhere(this.modelName, args?.where, params);
    const byCols = (args.by || []).map((b: string) => `[${b}]`).join(', ');
    const query = `SELECT ${byCols}, COUNT(*) AS _count FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} GROUP BY ${byCols}`;
    return this.adapter.exec(query, params);
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
      const dist = metric === 'cosine' ? 1 - cosine : metric === 'dot' ? -dot : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0));
      scored.push({ row, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, args.take ?? 10).map(s => ({ ...s.row as any, distance: s.dist }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a typed an5Adapter instance from a connection string.
 * Returns the adapter with dynamic table access via .table(modelName).
 */
export function createAn5Adapter(config: An5AdapterConfig): An5Adapter {
  return new An5Adapter(config);
}
