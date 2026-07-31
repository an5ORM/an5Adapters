import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';

// ─── SQLite Engine ─────────────────────────────────────────────────────────────────

let BetterSqlite3: any = null;
try { BetterSqlite3 = require('better-sqlite3'); } catch { }

export class SqliteEngine implements QueryEngine {
  dialect: Dialect = 'sqlite';
  private db: any = null;
  private readonly filePath: string;

  constructor(adapterConfig: An5AdapterConfig) {
    if (!BetterSqlite3) throw new Error('better-sqlite3 package is required for SQLite support. Run: npm install better-sqlite3');
    this.filePath = adapterConfig.connectionString
      .replace(/^sqlite:\/\/\//i, '/')
      .replace(/^sqlite:\/\//i, '');
  }

  private getDb(): any {
    if (!this.db) this.db = new BetterSqlite3(this.filePath);
    return this.db;
  }

  // better-sqlite3 natively supports @name parameters
  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    return this.getDb().prepare(query).all(params ?? {}) as T[];
  }

  async executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    const info = this.getDb().prepare(query).run(params ?? {});
    return info.changes ?? 0;
  }

  async connect(): Promise<void> { this.getDb(); }

  async disconnect(): Promise<void> {
    if (this.db) { this.db.close(); this.db = null; }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    const db = this.getDb();
    db.prepare('BEGIN').run();
    let done = false;

    return {
      exec: async <T>(q: string, p?: Record<string, any>) =>
        db.prepare(q).all(p ?? {}) as T[],
      executeRaw: async (q: string, p?: Record<string, any>) =>
        (db.prepare(q).run(p ?? {}).changes ?? 0),
      commit: async () => { if (!done) { db.prepare('COMMIT').run(); done = true; } },
      rollback: async () => { if (!done) { db.prepare('ROLLBACK').run(); done = true; } },
    };
  }
}
