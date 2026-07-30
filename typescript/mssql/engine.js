"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MssqlEngine = void 0;
exports.parseMssqlConnectionString = parseMssqlConnectionString;
const mssql_1 = __importDefault(require("mssql"));
// ─── MSSQL Connection Config ───────────────────────────────────────────────────────
function parseMssqlConnectionString(url) {
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
    }
    else if (colonIdx !== -1 && !firstPart.includes('=')) {
        server = firstPart.slice(0, colonIdx).trim();
        port = parseInt(firstPart.slice(colonIdx + 1), 10) || 1433;
    }
    const config = {
        server,
        port,
        options: { encrypt: true, trustServerCertificate: true },
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        requestTimeout: 60000,
        connectionTimeout: 15000,
    };
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part)
            continue;
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1)
            continue;
        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const value = decodeURIComponent(part.slice(eqIdx + 1).trim());
        if (key === 'database' || key === 'initial catalog')
            config.database = value;
        else if (key === 'user' || key === 'uid' || key === 'user id')
            config.user = value;
        else if (key === 'password' || key === 'pwd')
            config.password = value;
        else if (key === 'server' || key === 'data source') {
            // SERVER=host,port style (key-value form)
            const [s, p] = value.split(',');
            config.server = s.trim();
            if (p)
                config.port = parseInt(p.trim(), 10) || 1433;
        }
        else if (key === 'encrypt')
            config.options.encrypt = value.toLowerCase() === 'true';
        else if (key === 'trustservercertificate')
            config.options.trustServerCertificate = value.toLowerCase() === 'true';
        else if (key === 'connection timeout')
            config.connectionTimeout = parseInt(value, 10) * 1000;
    }
    return config;
}
// ─── MSSQL Engine ──────────────────────────────────────────────────────────────────
class MssqlEngine {
    constructor(adapterConfig) {
        this.dialect = 'mssql';
        this.pool = null;
        this.config = parseMssqlConnectionString(adapterConfig.connectionString);
        if (adapterConfig.poolMax)
            this.config.pool = { ...this.config.pool, max: adapterConfig.poolMax };
        if (adapterConfig.requestTimeout)
            this.config.requestTimeout = adapterConfig.requestTimeout;
        if (adapterConfig.connectionTimeout)
            this.config.connectionTimeout = adapterConfig.connectionTimeout;
    }
    async getPool() {
        if (!this.pool)
            this.pool = new mssql_1.default.ConnectionPool(this.config).connect();
        return this.pool;
    }
    attachParams(req, params) {
        if (params)
            for (const [k, v] of Object.entries(params))
                req.input(k, v ?? null);
    }
    async exec(query, params) {
        const pool = await this.getPool();
        const req = new mssql_1.default.Request(pool);
        this.attachParams(req, params);
        const result = await req.query(query);
        return (result.recordset || []);
    }
    async executeRaw(query, params) {
        const pool = await this.getPool();
        const req = new mssql_1.default.Request(pool);
        this.attachParams(req, params);
        const result = await req.query(query);
        return result.rowsAffected[0] ?? 0;
    }
    async connect() { await this.getPool(); }
    async disconnect() {
        if (this.pool) {
            const p = await this.pool;
            await p.close();
            this.pool = null;
        }
    }
    async beginTransaction() {
        const pool = await this.getPool();
        const tx = new mssql_1.default.Transaction(pool);
        await tx.begin();
        const buildReq = (params) => {
            const req = new mssql_1.default.Request(tx);
            if (params)
                for (const [k, v] of Object.entries(params))
                    req.input(k, v ?? null);
            return req;
        };
        return {
            exec: async (q, p) => {
                const r = await buildReq(p).query(q);
                return (r.recordset || []);
            },
            executeRaw: async (q, p) => {
                const r = await buildReq(p).query(q);
                return r.rowsAffected[0] ?? 0;
            },
            commit: () => tx.commit(),
            rollback: () => tx.rollback(),
        };
    }
}
exports.MssqlEngine = MssqlEngine;
