import type { Dialect, QueryEngine, TransactionHandle } from '../base/types';

// ─── Browser SQLite Driver & Config ──────────────────────────────────────────────────

export interface SqliteDriver {
  exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> | T[];
  executeRaw?(query: string, params?: Record<string, any>): Promise<number> | number;
  close?(): Promise<void> | void;
}

export interface SqliteBrowserConfig {
  db?: any; // sql.js Database instance or SQLite WASM DB
  driver?: SqliteDriver;
  exec?: <T = any>(query: string, params?: Record<string, any>) => Promise<T[]> | T[];
  executeRaw?: (query: string, params?: Record<string, any>) => Promise<number> | number;
}

// ─── Browser SQLite Engine ──────────────────────────────────────────────────────────

export class SqliteBrowserEngine implements QueryEngine {
  dialect: Dialect = 'sqlite';
  private db: any = null;
  private driver: SqliteDriver | null = null;
  private customExec: ((query: string, params?: Record<string, any>) => Promise<any[]> | any[]) | null = null;
  private customExecuteRaw: ((query: string, params?: Record<string, any>) => Promise<number> | number) | null = null;

  constructor(config?: SqliteBrowserConfig | any) {
    if (!config) return;

    if (config.exec && typeof config.exec === 'function') {
      this.customExec = config.exec;
      this.customExecuteRaw = config.executeRaw ?? null;
      return;
    }

    if (config.driver) {
      this.driver = config.driver;
      return;
    }

    // Direct DB instance (e.g. sql.js Database or sqlite-wasm)
    if (config.db) {
      this.db = config.db;
      return;
    }

    // If config itself looks like a driver with exec()
    if (typeof config.exec === 'function' && typeof config.run !== 'function' && typeof config.prepare !== 'function') {
      this.driver = config as SqliteDriver;
      return;
    }

    // If config itself is a Database instance (has prepare, exec, run)
    if (typeof config.prepare === 'function' || typeof config.run === 'function' || typeof config.exec === 'function') {
      this.db = config;
    }
  }

  private normalizeSqlJsParams(params?: Record<string, any>): Record<string, any> {
    if (!params || typeof params !== 'object') return {};
    const normalized: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      const key = k.startsWith('@') || k.startsWith(':') || k.startsWith('$') ? k : `@${k}`;
      normalized[key] = v;
    }
    return normalized;
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    if (this.customExec) {
      return await this.customExec(query, params);
    }

    if (this.driver) {
      return await this.driver.exec<T>(query, params);
    }

    if (this.db) {
      // sql.js Database with prepare()
      if (typeof this.db.prepare === 'function') {
        const stmt = this.db.prepare(query);
        try {
          if (params && Object.keys(params).length > 0) {
            stmt.bind(this.normalizeSqlJsParams(params));
          }
          const results: T[] = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject() as T);
          }
          return results;
        } finally {
          stmt.free();
        }
      }

      // Fallback sql.js db.exec()
      if (typeof this.db.exec === 'function') {
        const res = this.db.exec(query);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any[]) => {
          const obj: any = {};
          columns.forEach((col: string, i: number) => {
            obj[col] = row[i];
          });
          return obj as T;
        });
      }
    }

    throw new Error('SqliteBrowserEngine: No SQLite database or driver provided. Pass a sql.js db instance or custom driver.');
  }

  async executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    if (this.customExecuteRaw) {
      return await this.customExecuteRaw(query, params);
    }

    if (this.driver && typeof this.driver.executeRaw === 'function') {
      return await this.driver.executeRaw(query, params);
    }

    if (this.db) {
      if (typeof this.db.prepare === 'function') {
        const stmt = this.db.prepare(query);
        try {
          if (params && Object.keys(params).length > 0) {
            stmt.bind(this.normalizeSqlJsParams(params));
          }
          stmt.step();
          if (typeof this.db.getRowsModified === 'function') {
            return this.db.getRowsModified();
          }
          return 1;
        } finally {
          stmt.free();
        }
      }

      if (typeof this.db.run === 'function') {
        this.db.run(query, this.normalizeSqlJsParams(params));
        if (typeof this.db.getRowsModified === 'function') {
          return this.db.getRowsModified();
        }
        return 1;
      }
    }

    const rows = await this.exec(query, params);
    return rows.length;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    if (this.driver && typeof this.driver.close === 'function') {
      await this.driver.close();
    } else if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    await this.executeRaw('BEGIN');
    let done = false;

    return {
      exec: async <T>(q: string, p?: Record<string, any>) => this.exec<T>(q, p),
      executeRaw: async (q: string, p?: Record<string, any>) => this.executeRaw(q, p),
      commit: async () => {
        if (!done) {
          await this.executeRaw('COMMIT');
          done = true;
        }
      },
      rollback: async () => {
        if (!done) {
          await this.executeRaw('ROLLBACK');
          done = true;
        }
      },
    };
  }
}

// ─── Browser SQLite Adapter Factory ──────────────────────────────────────────────────

export function createBrowserSqliteAdapter(config: SqliteBrowserConfig | any): any {
  const { An5Adapter } = require('../an5Adapter');
  return new An5Adapter({ engine: new SqliteBrowserEngine(config) });
}

