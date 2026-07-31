import sql from 'mssql';
import type { An5AdapterConfig, Dialect, QueryEngine, TransactionHandle } from '../base/types';

// ─── MSSQL Connection Config ───────────────────────────────────────────────────────

export function parseMssqlConnectionString(url: string): sql.config {
  let cleanUrl = (url || '').trim();
  // Strip scheme prefix
  cleanUrl = cleanUrl.replace(/^(?:sqlserver|mssql):\/\//i, '');

  const parts = cleanUrl.split(';');
  const firstPart = parts[0].trim();

  // host:port or host,port (SQL Server native style)
  let server = firstPart;
  let port = 1433;
  const commaIdx = firstPart.lastIndexOf(',');
  const colonIdx = firstPart.lastIndexOf(':');
  if (commaIdx !== -1) {
    server = firstPart.slice(0, commaIdx).trim();
    port = parseInt(firstPart.slice(commaIdx + 1), 10) || 1433;
  } else if (colonIdx !== -1 && !firstPart.includes('=')) {
    server = firstPart.slice(0, colonIdx).trim();
    port = parseInt(firstPart.slice(colonIdx + 1), 10) || 1433;
  }

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
    if (key === 'database' || key === 'initial catalog') config.database = value;
    else if (key === 'user' || key === 'uid' || key === 'user id') config.user = value;
    else if (key === 'password' || key === 'pwd') config.password = value;
    else if (key === 'server' || key === 'data source') {
      // SERVER=host,port style (key-value form)
      const [s, p] = value.split(',');
      config.server = s.trim();
      if (p) config.port = parseInt(p.trim(), 10) || 1433;
    }
    else if (key === 'encrypt') config.options.encrypt = value.toLowerCase() === 'true';
    else if (key === 'trustservercertificate') config.options.trustServerCertificate = value.toLowerCase() === 'true';
    else if (key === 'connection timeout') config.connectionTimeout = parseInt(value, 10) * 1000;
  }
  return config;
}

// ─── MSSQL Engine ──────────────────────────────────────────────────────────────────

export class MssqlEngine implements QueryEngine {
  dialect: Dialect = 'mssql';
  private pool: Promise<sql.ConnectionPool> | null = null;
  private config: sql.config;

  constructor(adapterConfig: An5AdapterConfig) {
    this.config = parseMssqlConnectionString(adapterConfig.connectionString);
    if (adapterConfig.poolMax) this.config.pool = { ...this.config.pool, max: adapterConfig.poolMax };
    if (adapterConfig.requestTimeout) this.config.requestTimeout = adapterConfig.requestTimeout;
    if (adapterConfig.connectionTimeout) this.config.connectionTimeout = adapterConfig.connectionTimeout;
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    if (!this.pool) this.pool = new sql.ConnectionPool(this.config).connect();
    return this.pool;
  }

  private attachParams(req: sql.Request, params?: Record<string, any>): void {
    if (params) for (const [k, v] of Object.entries(params)) req.input(k, v ?? null);
  }

  async exec<T = any>(query: string, params?: Record<string, any>): Promise<T[]> {
    const pool = await this.getPool();
    const req = new sql.Request(pool);
    this.attachParams(req, params);
    const result = await req.query(query);
    return (result.recordset || []) as T[];
  }

  async executeRaw(query: string, params?: Record<string, any>): Promise<number> {
    const pool = await this.getPool();
    const req = new sql.Request(pool);
    this.attachParams(req, params);
    const result = await req.query(query);
    return result.rowsAffected[0] ?? 0;
  }

  async connect(): Promise<void> { await this.getPool(); }

  async disconnect(): Promise<void> {
    if (this.pool) {
      const p = await this.pool;
      await p.close();
      this.pool = null;
    }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    const pool = await this.getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const buildReq = (params?: Record<string, any>) => {
      const req = new sql.Request(tx);
      if (params) for (const [k, v] of Object.entries(params)) req.input(k, v ?? null);
      return req;
    };

    return {
      exec: async <T>(q: string, p?: Record<string, any>) => {
        const r = await buildReq(p).query(q);
        return (r.recordset || []) as T[];
      },
      executeRaw: async (q: string, p?: Record<string, any>) => {
        const r = await buildReq(p).query(q);
        return r.rowsAffected[0] ?? 0;
      },
      commit: () => tx.commit(),
      rollback: () => tx.rollback(),
    };
  }
}
