"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdapter = exports.AdapterTableClient = exports.An5AdapterTx = exports.An5Adapter = exports.setAdapterMetadata = void 0;
exports.createAn5Adapter = createAn5Adapter;
const crypto_1 = require("crypto");
const googlesheets_1 = require("./googlesheets");
const parseConnectionString_1 = require("./googlesheets/parseConnectionString");
const sql_1 = require("./base/sql");
const metadata_1 = require("./base/metadata");
var metadata_2 = require("./base/metadata");
Object.defineProperty(exports, "setAdapterMetadata", { enumerable: true, get: function () { return metadata_2.setAdapterMetadata; } });
function isSheetsConfig(config) {
    return config.spreadsheetId !== undefined;
}
// ─── An5Adapter ────────────────────────────────────────────────────────────────────
class An5Adapter {
    get dialect() {
        if (this.sheetsAdapter)
            return 'googlesheets';
        if (this._engine)
            return this._engine.dialect;
        if (this._engineType === 'postgres')
            return 'postgres';
        if (this._engineType === 'mysql')
            return 'mysql';
        if (this._engineType === 'sqlite')
            return 'sqlite';
        return 'mssql';
    }
    constructor(adapterConfig) {
        this._engine = null;
        this._engineType = null;
        this._engineConfig = null;
        this.sheetsAdapter = null;
        if (isSheetsConfig(adapterConfig)) {
            this.sheetsAdapter = new googlesheets_1.An5SheetsAdapter(adapterConfig);
            return;
        }
        const cs = adapterConfig.connectionString.trim();
        if (cs.startsWith('googlesheets://')) {
            this.sheetsAdapter = new googlesheets_1.An5SheetsAdapter((0, parseConnectionString_1.parseSheetsConnectionString)(cs));
            return;
        }
        this._engineConfig = adapterConfig;
        if (cs.startsWith('postgres://') || cs.startsWith('postgresql://')) {
            this._engineType = 'postgres';
        }
        else if (cs.startsWith('mysql://') || cs.startsWith('mariadb://')) {
            this._engineType = 'mysql';
        }
        else if (cs.startsWith('sqlite://') || cs.endsWith('.sqlite') || cs.endsWith('.db')) {
            this._engineType = 'sqlite';
        }
        else {
            this._engineType = 'mssql';
        }
    }
    async requireEngine() {
        if (!this._engine && this._engineType) {
            switch (this._engineType) {
                case 'postgres': {
                    const { PostgresEngine } = require('./postgres.js');
                    this._engine = new PostgresEngine(this._engineConfig);
                    break;
                }
                case 'mysql': {
                    const { MysqlEngine } = require('./mysql.js');
                    this._engine = new MysqlEngine(this._engineConfig);
                    break;
                }
                case 'sqlite': {
                    const { SqliteEngine } = require('./sqlite.js');
                    this._engine = new SqliteEngine(this._engineConfig);
                    break;
                }
                case 'mssql': {
                    const { MssqlEngine } = require('./mssql.js');
                    this._engine = new MssqlEngine(this._engineConfig);
                    break;
                }
            }
        }
        if (!this._engine)
            throw new Error('SQL engine is not available for Google Sheets adapter');
        return this._engine;
    }
    requireSheetsAdapter() {
        if (!this.sheetsAdapter)
            throw new Error('Google Sheets methods require a googlesheets:// connection or Sheets config');
        return this.sheetsAdapter;
    }
    async exec(query, params) {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.exec(query, params);
        return (await this.requireEngine()).exec(query, params);
    }
    /** INTERNAL: used by AdapterTableClient for DML statements needing row count */
    async _executeRaw(query, params) {
        return (await this.requireEngine()).executeRaw(query, params);
    }
    /** Execute a raw query with positional values → @p_0, @p_1, ... per dialect */
    async $queryRawUnsafe(query, ...values) {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.$queryRawUnsafe(query, ...values);
        const engine = await this.requireEngine();
        const params = {};
        values.forEach((v, i) => { params[`p_${i}`] = v; });
        let q = query;
        if (this.dialect === 'postgres') {
            let idx = 0;
            q = q.replace(/\$\d+/g, () => `@p_${idx++}`);
        }
        else if (this.dialect === 'mysql') {
            let idx = 0;
            q = q.replace(/\?/g, () => `@p_${idx++}`);
        }
        return engine.exec(q, params);
    }
    async $executeRaw(query, ...values) {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.$executeRaw(query, ...values);
        const engine = await this.requireEngine();
        const params = {};
        values.forEach((v, i) => { params[`p_${i}`] = v; });
        let q = query;
        if (this.dialect === 'postgres') {
            let idx = 0;
            q = q.replace(/\$\d+/g, () => `@p_${idx++}`);
        }
        else if (this.dialect === 'mysql') {
            let idx = 0;
            q = q.replace(/\?/g, () => `@p_${idx++}`);
        }
        return engine.executeRaw(q, params);
    }
    async $executeRawUnsafe(query, ...values) {
        return this.$executeRaw(query, ...values);
    }
    async $connect() {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.$connect();
        await (await this.requireEngine()).connect();
    }
    async $disconnect() {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.$disconnect();
        await (await this.requireEngine()).disconnect();
    }
    async $transaction(fn, _options) {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.$transaction(fn, _options);
        if (Array.isArray(fn))
            return Promise.all(fn);
        const engine = await this.requireEngine();
        const handle = await engine.beginTransaction();
        const txAdapter = new An5AdapterTx(handle, this.dialect);
        try {
            const result = await fn(txAdapter);
            await handle.commit();
            return result;
        }
        catch (err) {
            await handle.rollback();
            throw err;
        }
    }
    table(modelName) {
        if (this.sheetsAdapter)
            return this.sheetsAdapter.table(modelName);
        return new AdapterTableClient(this, modelName);
    }
    async readRange(range) {
        return this.requireSheetsAdapter().readRange(range);
    }
    async writeRange(range, values) {
        await this.requireSheetsAdapter().writeRange(range, values);
    }
    async appendRange(range, values) {
        await this.requireSheetsAdapter().appendRange(range, values);
    }
    async listSheets() {
        return this.requireSheetsAdapter().listSheets();
    }
    async deleteSheet(name) {
        await this.requireSheetsAdapter().deleteSheet(name);
    }
}
exports.An5Adapter = An5Adapter;
// ─── Transaction-scoped adapter ────────────────────────────────────────────────────
class An5AdapterTx {
    constructor(handle, dialect) {
        this.handle = handle;
        this.dialect = dialect;
    }
    async exec(query, params) {
        return this.handle.exec(query, params);
    }
    async _executeRaw(query, params) {
        return this.handle.executeRaw(query, params);
    }
    table(modelName) {
        return new AdapterTableClient(this, modelName);
    }
}
exports.An5AdapterTx = An5AdapterTx;
// ─── Table Client ──────────────────────────────────────────────────────────────────
class AdapterTableClient {
    constructor(adapter, modelName) {
        this.adapter = adapter;
        this.modelName = modelName;
    }
    get dialect() { return this.adapter.dialect; }
    get tableName() {
        const name = this.modelName;
        let t = name;
        const modelToTable = (0, metadata_1.getModelToTable)();
        if (modelToTable[name])
            t = modelToTable[name];
        else {
            const camel = name.charAt(0).toLowerCase() + name.slice(1);
            if (modelToTable[camel])
                t = modelToTable[camel];
            else {
                const lower = name.toLowerCase();
                if (modelToTable[lower])
                    t = modelToTable[lower];
            }
        }
        if (t.startsWith('[') || t.startsWith('"') || t.startsWith('`'))
            return t;
        if (t.includes('.'))
            return t.split('.').map(p => (0, sql_1.quote)(p, this.dialect)).join('.');
        return (0, sql_1.quote)(t, this.dialect);
    }
    get nolock() {
        return this.dialect === 'mssql' ? ' WITH (NOLOCK)' : '';
    }
    async doExec(query, params) {
        return this.adapter.exec(query, params);
    }
    async doExecuteRaw(query, params) {
        return this.adapter._executeRaw(query, params);
    }
    async findMany(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args?.where, params, this.dialect);
        const orderSql = (0, sql_1.buildOrderBy)(args?.orderBy, this.dialect);
        const take = args?.take;
        const skip = args?.skip ?? 0;
        let query;
        if (take !== undefined) {
            if (this.dialect === 'postgres' || this.dialect === 'mysql' || this.dialect === 'sqlite') {
                query = `SELECT * FROM ${this.tableName}`;
                if (whereSql)
                    query += ` WHERE ${whereSql}`;
                if (orderSql)
                    query += ` ${orderSql}`;
                query += ` LIMIT ${take} OFFSET ${skip}`;
            }
            else {
                // mssql requires ORDER BY before OFFSET/FETCH
                query = `SELECT * FROM ${this.tableName}${this.nolock}`;
                if (whereSql)
                    query += ` WHERE ${whereSql}`;
                query += ` ${orderSql || 'ORDER BY (SELECT NULL)'}`;
                query += ` OFFSET ${skip} ROWS FETCH NEXT ${take} ROWS ONLY`;
            }
        }
        else {
            query = `SELECT * FROM ${this.tableName}${this.nolock}`;
            if (whereSql)
                query += ` WHERE ${whereSql}`;
            if (orderSql)
                query += ` ${orderSql}`;
        }
        return this.doExec(query, params);
    }
    async findFirst(args) {
        const rows = await this.findMany({ ...args, take: 1 });
        return rows[0] ?? null;
    }
    async findUnique(args) {
        return this.findFirst({ where: args.where });
    }
    async count(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args?.where, params, this.dialect);
        // Add NOLOCK for mssql count too
        let query = `SELECT COUNT(*) AS cnt FROM ${this.tableName}${this.nolock}`;
        if (whereSql)
            query += ` WHERE ${whereSql}`;
        const rows = await this.doExec(query, params);
        return Number(rows[0]?.cnt ?? rows[0]?.CNT ?? 0);
    }
    async create(args) {
        const fields = (0, metadata_1.getFieldsForModel)(this.modelName);
        const idFieldName = Object.prototype.hasOwnProperty.call(fields, 'id')
            ? 'id'
            : Object.keys(fields).find((name) => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');
        const data = { ...args.data };
        if (idFieldName) {
            const fieldDef = fields[idFieldName];
            const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || fieldDef?.type || '');
            const normalizedType = String(rawType).toLowerCase();
            const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(normalizedType);
            if (isStringType && !data[idFieldName])
                data[idFieldName] = (0, crypto_1.randomUUID)();
        }
        const cols = Object.keys(data).filter(k => data[k] !== undefined);
        const params = {};
        const vals = [];
        for (const col of cols) {
            const p = `c_${col}`;
            params[p] = data[col];
            vals.push(`@${p}`);
        }
        const query = `INSERT INTO ${this.tableName} (${cols.map(c => (0, sql_1.quote)(c, this.dialect)).join(', ')}) VALUES (${vals.join(', ')})`;
        await this.doExec(query, params);
        return (await this.findFirst({ where: idFieldName ? { [idFieldName]: data[idFieldName] } : data }));
    }
    async createMany(args) {
        if (args.data.length === 0)
            return { count: 0 };
        const firstCols = Object.keys(args.data[0]).filter(k => args.data[0][k] !== undefined);
        // Bulk INSERT for the common case (same columns, no skipDuplicates)
        if (firstCols.length > 0 && !args.skipDuplicates) {
            const params = {};
            const rowPlaceholders = [];
            for (let r = 0; r < args.data.length; r++) {
                const row = args.data[r];
                const vals = firstCols.map(col => {
                    const p = `r${r}_${col}`;
                    params[p] = row[col] ?? null;
                    return `@${p}`;
                });
                rowPlaceholders.push(`(${vals.join(', ')})`);
            }
            const query = `INSERT INTO ${this.tableName} (${firstCols.map(c => (0, sql_1.quote)(c, this.dialect)).join(', ')}) VALUES ${rowPlaceholders.join(', ')}`;
            try {
                await this.doExecuteRaw(query, params);
                return { count: args.data.length };
            }
            catch {
                // fallback below if bulk fails (e.g. mixed column sets)
            }
        }
        // Row-by-row fallback
        let count = 0;
        for (const row of args.data) {
            try {
                await this.create({ data: row });
                count++;
            }
            catch (e) {
                if (!args.skipDuplicates)
                    throw e;
            }
        }
        return { count };
    }
    async update(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args.where, params, this.dialect, 'w_');
        const setCols = Object.keys(args.data).filter(k => args.data[k] !== undefined);
        const sets = [];
        for (const col of setCols) {
            const p = `s_${col}`;
            params[p] = args.data[col];
            sets.push(`${(0, sql_1.quote)(col, this.dialect)} = @${p}`);
        }
        const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
        await this.doExecuteRaw(query, params);
        return (await this.findFirst({ where: args.where }));
    }
    async updateMany(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args.where, params, this.dialect, 'w_');
        const setCols = Object.keys(args.data).filter(k => args.data[k] !== undefined);
        const sets = [];
        for (const col of setCols) {
            const p = `s_${col}`;
            params[p] = args.data[col];
            sets.push(`${(0, sql_1.quote)(col, this.dialect)} = @${p}`);
        }
        const query = `UPDATE ${this.tableName} SET ${sets.join(', ')}${whereSql ? ` WHERE ${whereSql}` : ''}`;
        const count = await this.doExecuteRaw(query, params);
        return { count };
    }
    async delete(args) {
        const existing = await this.findFirst({ where: args.where });
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args.where, params, this.dialect);
        await this.doExecuteRaw(`DELETE FROM ${this.tableName} WHERE ${whereSql}`, params);
        return existing;
    }
    async deleteMany(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args?.where, params, this.dialect);
        const query = `DELETE FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
        const count = await this.doExecuteRaw(query, params);
        return { count };
    }
    async upsert(args) {
        const existing = await this.findFirst({ where: args.where });
        return existing
            ? this.update({ where: args.where, data: args.update })
            : this.create({ data: args.create });
    }
    async aggregate(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args?.where, params, this.dialect);
        const aggs = [];
        if (args._count)
            aggs.push('COUNT(*) AS _count');
        if (args._sum)
            for (const f of Object.keys(args._sum))
                aggs.push(`SUM(${(0, sql_1.quote)(f, this.dialect)}) AS _sum_${f}`);
        if (args._avg)
            for (const f of Object.keys(args._avg))
                aggs.push(`AVG(${(0, sql_1.quote)(f, this.dialect)}) AS _avg_${f}`);
        if (args._min)
            for (const f of Object.keys(args._min))
                aggs.push(`MIN(${(0, sql_1.quote)(f, this.dialect)}) AS _min_${f}`);
        if (args._max)
            for (const f of Object.keys(args._max))
                aggs.push(`MAX(${(0, sql_1.quote)(f, this.dialect)}) AS _max_${f}`);
        const query = `SELECT ${aggs.join(', ')} FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''}`;
        const rows = await this.doExec(query, params);
        return rows[0] ?? {};
    }
    async groupBy(args) {
        const params = {};
        const whereSql = (0, sql_1.parseWhere)(this.modelName, args?.where, params, this.dialect);
        const byCols = (args.by || []).map((b) => (0, sql_1.quote)(b, this.dialect)).join(', ');
        const query = `SELECT ${byCols}, COUNT(*) AS _count FROM ${this.tableName}${whereSql ? ` WHERE ${whereSql}` : ''} GROUP BY ${byCols}`;
        return this.doExec(query, params);
    }
    async vectorSearch(args) {
        const rows = await this.findMany({ where: args.where });
        const vectorField = args.vectorField || 'embedding';
        const metric = args.distanceMetric || 'cosine';
        const scored = [];
        for (const row of rows) {
            const raw = row[vectorField];
            if (!raw)
                continue;
            let vec = [];
            try {
                vec = typeof raw === 'string' ? JSON.parse(raw) : raw;
            }
            catch {
                continue;
            }
            if (!Array.isArray(vec) || vec.length !== args.vector.length)
                continue;
            let dot = 0, m1 = 0, m2 = 0;
            for (let i = 0; i < args.vector.length; i++) {
                dot += args.vector[i] * vec[i];
                m1 += args.vector[i] ** 2;
                m2 += vec[i] ** 2;
            }
            const cosine = m1 && m2 ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
            const dist = metric === 'cosine'
                ? 1 - cosine
                : metric === 'dot'
                    ? -dot
                    : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0));
            scored.push({ row, dist });
        }
        scored.sort((a, b) => a.dist - b.dist);
        return scored.slice(0, args.take ?? 10).map(s => ({ ...s.row, distance: s.dist }));
    }
}
exports.AdapterTableClient = AdapterTableClient;
// ─── Factory ──────────────────────────────────────────────────────────────────────
function createAn5Adapter(config) {
    if (isSheetsConfig(config))
        return new googlesheets_1.An5SheetsAdapter(config);
    if (config.connectionString.trim().startsWith('googlesheets://')) {
        return new googlesheets_1.An5SheetsAdapter((0, parseConnectionString_1.parseSheetsConnectionString)(config.connectionString));
    }
    return new An5Adapter(config);
}
exports.createAdapter = createAn5Adapter;
