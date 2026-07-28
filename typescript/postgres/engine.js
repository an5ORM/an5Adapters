"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresEngine = void 0;
// ─── PostgreSQL Engine ─────────────────────────────────────────────────────────────
let PgPool = null;
try {
    PgPool = require('pg').Pool;
}
catch { }
class PostgresEngine {
    constructor(adapterConfig) {
        this.dialect = 'postgres';
        this.pool = null;
        if (!PgPool)
            throw new Error('pg package is required for PostgreSQL support. Run: npm install pg');
        this.pool = new PgPool({
            connectionString: adapterConfig.connectionString,
            max: adapterConfig.poolMax ?? 10,
        });
    }
    /** Convert @name → $N; identical names reuse the same $N */
    transform(query, params) {
        if (!params || Object.keys(params).length === 0)
            return { text: query, values: [] };
        const values = [];
        const seen = {};
        const text = query.replace(/@(\w+)/g, (_, name) => {
            if (seen[name] !== undefined)
                return `$${seen[name]}`;
            const idx = values.length + 1;
            seen[name] = idx;
            values.push(params[name] ?? null);
            return `$${idx}`;
        });
        return { text, values };
    }
    async exec(query, params) {
        const { text, values } = this.transform(query, params);
        const result = await this.pool.query(text, values);
        return result.rows;
    }
    async executeRaw(query, params) {
        const { text, values } = this.transform(query, params);
        const result = await this.pool.query(text, values);
        return result.rowCount ?? 0;
    }
    async connect() {
        const client = await this.pool.connect();
        client.release();
    }
    async disconnect() { await this.pool.end(); }
    async beginTransaction() {
        const client = await this.pool.connect();
        await client.query('BEGIN');
        const transform = (query, params) => {
            if (!params || Object.keys(params).length === 0)
                return { text: query, values: [] };
            const values = [];
            const seen = {};
            const text = query.replace(/@(\w+)/g, (_, name) => {
                if (seen[name] !== undefined)
                    return `$${seen[name]}`;
                const idx = values.length + 1;
                seen[name] = idx;
                values.push(params[name] ?? null);
                return `$${idx}`;
            });
            return { text, values };
        };
        return {
            exec: async (q, p) => {
                const { text, values } = transform(q, p);
                const r = await client.query(text, values);
                return (r.rows || []);
            },
            executeRaw: async (q, p) => {
                const { text, values } = transform(q, p);
                const r = await client.query(text, values);
                return r.rowCount ?? 0;
            },
            commit: async () => { await client.query('COMMIT'); client.release(); },
            rollback: async () => { await client.query('ROLLBACK'); client.release(); },
        };
    }
}
exports.PostgresEngine = PostgresEngine;
