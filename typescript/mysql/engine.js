"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MysqlEngine = void 0;
// ─── MySQL Engine ──────────────────────────────────────────────────────────────────
let Mysql2 = null;
try {
    Mysql2 = require('mysql2/promise');
}
catch { }
class MysqlEngine {
    constructor(adapterConfig) {
        this.dialect = 'mysql';
        this.pool = null;
        if (!Mysql2)
            throw new Error('mysql2 package is required for MySQL support. Run: npm install mysql2');
        this.pool = Mysql2.createPool({
            uri: adapterConfig.connectionString,
            connectionLimit: adapterConfig.poolMax ?? 10,
            connectTimeout: adapterConfig.connectionTimeout ?? 15000,
        });
    }
    /** Convert @name → ? (positional); return ordered values */
    transform(query, params) {
        if (!params || Object.keys(params).length === 0)
            return { text: query, values: [] };
        const values = [];
        const text = query.replace(/@(\w+)/g, (_, name) => {
            values.push(params[name] ?? null);
            return '?';
        });
        return { text, values };
    }
    async exec(query, params) {
        const { text, values } = this.transform(query, params);
        const [rows] = await this.pool.query(text, values);
        return rows;
    }
    async executeRaw(query, params) {
        const { text, values } = this.transform(query, params);
        const [result] = await this.pool.query(text, values);
        return result.affectedRows ?? 0;
    }
    async connect() {
        const conn = await this.pool.getConnection();
        conn.release();
    }
    async disconnect() { await this.pool.end(); }
    async beginTransaction() {
        const conn = await this.pool.getConnection();
        await conn.beginTransaction();
        const transform = (query, params) => {
            if (!params || Object.keys(params).length === 0)
                return { text: query, values: [] };
            const values = [];
            const text = query.replace(/@(\w+)/g, (_, name) => {
                values.push(params[name] ?? null);
                return '?';
            });
            return { text, values };
        };
        return {
            exec: async (q, p) => {
                const { text, values } = transform(q, p);
                const [rows] = await conn.query(text, values);
                return rows;
            },
            executeRaw: async (q, p) => {
                const { text, values } = transform(q, p);
                const [result] = await conn.query(text, values);
                return result.affectedRows ?? 0;
            },
            commit: async () => { await conn.commit(); conn.release(); },
            rollback: async () => { await conn.rollback(); conn.release(); },
        };
    }
}
exports.MysqlEngine = MysqlEngine;
