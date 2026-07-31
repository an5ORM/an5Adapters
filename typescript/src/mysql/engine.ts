import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';

// ─── MySQL Engine ──────────────────────────────────────────────────────────────────

let Mysql2: any = null;
try { Mysql2 = require('mysql2/promise'); } catch { }

export class MysqlEngine implements QueryEngine {
  dialect: Dialect = 'mysql';
  private pool: any = null;

  constructor(adapterConfig: An5AdapterConfig) {
    if (!Mysql2) throw new Error('mysql2 package is required for MySQL support. Run: npm install mysql2');
    this.pool = Mysql2.createPool({
      uri: adapterConfig.connectionString,
      connectionLimit: adapterConfig.poolMax ?? 10,
      connectTimeout: adapterConfig.connectionTimeout ?? 15000,
    });
  }

  /** Convert @name → ? (positional); return ordered values */
  private transform(query: string, params?: Record<string, any>): { text: string; values: any[] } {
    if (!params || Object.keys(params).length === 0) return { text: query, values: [] };
    const values: any[] = [];
    const text = query.replace(/@(\w+)/g, (_, name: string) => {
      values.push(params[name] ?? null);
      return '?';
    });
    return { text, values };
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    const { text, values } = this.transform(query, params);
    const [rows] = await this.pool.query(text, values);
    return rows as T[];
  }

  async executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    const { text, values } = this.transform(query, params);
    const [result] = await this.pool.query(text, values);
    return (result as any).affectedRows ?? 0;
  }

  async connect(): Promise<void> {
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async disconnect(): Promise<void> { await this.pool.end(); }

  async beginTransaction(): Promise<TransactionHandle> {
    const conn = await this.pool.getConnection();
    await conn.beginTransaction();

    const transform = (query: string, params?: Record<string, any>) => {
      if (!params || Object.keys(params).length === 0) return { text: query, values: [] };
      const values: any[] = [];
      const text = query.replace(/@(\w+)/g, (_, name: string) => {
        values.push(params[name] ?? null);
        return '?';
      });
      return { text, values };
    };

    return {
      exec: async <T>(q: string, p?: Record<string, any>) => {
        const { text, values } = transform(q, p);
        const [rows] = await conn.query(text, values);
        return rows as T[];
      },
      executeRaw: async (q: string, p?: Record<string, any>) => {
        const { text, values } = transform(q, p);
        const [result] = await conn.query(text, values);
        return (result as any).affectedRows ?? 0;
      },
      commit: async () => { await conn.commit(); conn.release(); },
      rollback: async () => { await conn.rollback(); conn.release(); },
    };
  }
}
