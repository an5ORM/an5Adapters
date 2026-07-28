"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteEngine = void 0;
// ─── SQLite Engine ─────────────────────────────────────────────────────────────────
let BetterSqlite3 = null;
try {
    BetterSqlite3 = require('better-sqlite3');
}
catch { }
class SqliteEngine {
    constructor(adapterConfig) {
        this.dialect = 'sqlite';
        this.db = null;
        if (!BetterSqlite3)
            throw new Error('better-sqlite3 package is required for SQLite support. Run: npm install better-sqlite3');
        this.filePath = adapterConfig.connectionString
            .replace(/^sqlite:\/\/\//i, '/')
            .replace(/^sqlite:\/\//i, '');
    }
    getDb() {
        if (!this.db)
            this.db = new BetterSqlite3(this.filePath);
        return this.db;
    }
    // better-sqlite3 natively supports @name parameters
    async exec(query, params) {
        return this.getDb().prepare(query).all(params ?? {});
    }
    async executeRaw(query, params) {
        const info = this.getDb().prepare(query).run(params ?? {});
        return info.changes ?? 0;
    }
    async connect() { this.getDb(); }
    async disconnect() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    async beginTransaction() {
        const db = this.getDb();
        db.prepare('BEGIN').run();
        let done = false;
        return {
            exec: async (q, p) => db.prepare(q).all(p ?? {}),
            executeRaw: async (q, p) => (db.prepare(q).run(p ?? {}).changes ?? 0),
            commit: async () => { if (!done) {
                db.prepare('COMMIT').run();
                done = true;
            } },
            rollback: async () => { if (!done) {
                db.prepare('ROLLBACK').run();
                done = true;
            } },
        };
    }
}
exports.SqliteEngine = SqliteEngine;
