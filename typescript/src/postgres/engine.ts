import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';

// ─── PostgreSQL Engine ─────────────────────────────────────────────────────────────

let PgPool: any = null;
try { PgPool = require('pg').Pool; } catch { }

export class PostgresEngine implements QueryEngine {
  dialect: Dialect = 'postgres';
  private pool: any = null;

  constructor(adapterConfig: An5AdapterConfig) {
    if (!PgPool) throw new Error('pg package is required for PostgreSQL support. Run: npm install pg');
    this.pool = new PgPool({
      connectionString: adapterConfig.connectionString,
      max: adapterConfig.poolMax ?? 10,
    });
  }

  /** Convert @name → $N; identical names reuse the same $N */
  private transform(query: string, params?: Record<string, any>): { text: string; values: any[] } {
    if (!params || Object.keys(params).length === 0) return { text: query, values: [] };
    const values: any[] = [];
    const seen: Record<string, number> = {};
    const text = query.replace(/@(\w+)/g, (_, name: string) => {
      if (seen[name] !== undefined) return `$${seen[name]}`;
      const idx = values.length + 1;
      seen[name] = idx;
      values.push(params[name] ?? null);
      return `$${idx}`;
    });
    return { text, values };
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    const { text, values } = this.transform(query, params);
    const result = await this.pool.query(text, values);
    return result.rows as T[];
  }

  async executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    const { text, values } = this.transform(query, params);
    const result = await this.pool.query(text, values);
    return result.rowCount ?? 0;
  }

  async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> { await this.pool.end(); }

  async beginTransaction(): Promise<TransactionHandle> {
    const client = await this.pool.connect();
    await client.query('BEGIN');

    const transform = (query: string, params?: Record<string, any>) => {
      if (!params || Object.keys(params).length === 0) return { text: query, values: [] };
      const values: any[] = [];
      const seen: Record<string, number> = {};
      const text = query.replace(/@(\w+)/g, (_, name: string) => {
        if (seen[name] !== undefined) return `$${seen[name]}`;
        const idx = values.length + 1;
        seen[name] = idx;
        values.push(params[name] ?? null);
        return `$${idx}`;
      });
      return { text, values };
    };

    return {
      exec: async <T>(q: string, p?: Record<string, any>) => {
        const { text, values } = transform(q, p);
        const r = await client.query(text, values);
        return (r.rows || []) as T[];
      },
      executeRaw: async (q: string, p?: Record<string, any>) => {
        const { text, values } = transform(q, p);
        const r = await client.query(text, values);
        return r.rowCount ?? 0;
      },
      commit: async () => { await client.query('COMMIT'); client.release(); },
      rollback: async () => { await client.query('ROLLBACK'); client.release(); },
    };
  }
}
