"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SheetsTableClient = void 0;
const uuid_1 = require("../base/uuid");
const metadata_1 = require("../base/metadata");
const helpers_1 = require("./helpers");
const retry_1 = require("./retry");
// ─── Utility ──────────────────────────────────────────────────────────────────
function resolveIdField(fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'id'))
        return 'id';
    return Object.keys(fields).find(name => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');
}
// ─── Table Client ─────────────────────────────────────────────────────────────
class SheetsTableClient {
    constructor(adapter, modelName, sheetMapping) {
        this.adapter = adapter;
        this.modelName = modelName;
        this.sheetMapping = sheetMapping;
    }
    get sheetName() {
        return (0, helpers_1.resolveSheetName)(this.modelName, this.sheetMapping);
    }
    get escSheetName() {
        return (0, helpers_1.esc)(this.sheetName);
    }
    get fields() {
        return (0, metadata_1.getFieldsForModel)(this.modelName);
    }
    async ensureSheetExists() {
        const existing = await this.adapter.getSheetMeta(this.sheetName);
        if (existing)
            return;
        const api = await this.adapter.getSheets();
        await (0, retry_1.withRetry)(() => api.spreadsheets.batchUpdate({
            spreadsheetId: this.adapter.config.spreadsheetId,
            requestBody: {
                requests: [{ addSheet: { properties: { title: this.sheetName } } }],
            },
        }));
        this.adapter.invalidateCache();
    }
    async readAllRows() {
        const api = await this.adapter.getSheets();
        const res = await (0, retry_1.withRetry)(() => api.spreadsheets.values.get({
            spreadsheetId: this.adapter.config.spreadsheetId,
            range: `${this.escSheetName}!A:ZZ`,
        }));
        const values = res.data.values || [];
        if (values.length < 1)
            return { headers: [], rows: [] };
        const headers = values[0];
        const rows = [];
        for (let i = 1; i < values.length; i++) {
            const row = { __row: i + 1 };
            for (let j = 0; j < headers.length; j++) {
                row[headers[j]] = (0, helpers_1.coerceCell)(values[i][j], this.fields[headers[j]]);
            }
            rows.push(row);
        }
        return { headers, rows };
    }
    async getOrCreateHeaders(cols) {
        const api = await this.adapter.getSheets();
        await this.ensureSheetExists();
        const res = await (0, retry_1.withRetry)(() => api.spreadsheets.values.get({
            spreadsheetId: this.adapter.config.spreadsheetId,
            range: `${this.escSheetName}!A1:ZZ1`,
        }));
        const existing = (res.data.values || [])[0] || [];
        if (existing.length > 0)
            return existing;
        await (0, retry_1.withRetry)(() => api.spreadsheets.values.update({
            spreadsheetId: this.adapter.config.spreadsheetId,
            range: `${this.escSheetName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [cols] },
        }));
        return cols;
    }
    rowToValues(data, headers) {
        return headers.map(h => {
            const v = data[h];
            if (v instanceof Date)
                return v.toISOString();
            if (v === null || v === undefined)
                return '';
            if (typeof v === 'boolean')
                return v ? 'TRUE' : 'FALSE';
            if (typeof v === 'object')
                return JSON.stringify(v);
            return String(v);
        });
    }
    async deleteRowByIndex(rowIdx, sheetIdVal) {
        const api = await this.adapter.getSheets();
        await (0, retry_1.withRetry)(() => api.spreadsheets.batchUpdate({
            spreadsheetId: this.adapter.config.spreadsheetId,
            requestBody: {
                requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: sheetIdVal,
                                dimension: 'ROWS',
                                startIndex: rowIdx - 1,
                                endIndex: rowIdx,
                            },
                        },
                    }],
            },
        }));
    }
    // ── CRUD ────────────────────────────────────────────────────────────────────
    async findMany(args) {
        const { headers, rows } = await this.readAllRows();
        if (headers.length === 0)
            return [];
        let filtered = rows.filter(r => (0, helpers_1.matchWhere)(r, args?.where));
        const orderSql = (0, helpers_1.buildOrderBy)(args?.orderBy);
        if (orderSql)
            filtered = (0, helpers_1.sortRows)(filtered, orderSql);
        const skip = args?.skip ?? 0;
        if (args?.take !== undefined) {
            filtered = filtered.slice(skip, skip + args.take);
        }
        else if (skip > 0) {
            filtered = filtered.slice(skip);
        }
        const select = args?.select;
        if (select) {
            const selectedKeys = Object.keys(select).filter(k => select[k] === true);
            return filtered.map(r => {
                const obj = {};
                for (const k of selectedKeys)
                    obj[k] = r[k];
                return obj;
            });
        }
        return filtered.map(r => {
            const { __row, ...rest } = r;
            return rest;
        });
    }
    async findFirst(args) {
        const rows = await this.findMany({ ...args, take: 1 });
        return rows[0] ?? null;
    }
    async findUnique(args) {
        return this.findFirst({ where: args.where });
    }
    async count(args) {
        const rows = await this.findMany({ where: args?.where });
        return rows.length;
    }
    assignId(data, fields) {
        const idFieldName = resolveIdField(fields);
        if (!idFieldName)
            return;
        const fieldDef = fields[idFieldName];
        const rawType = typeof fieldDef === 'string' ? fieldDef : (fieldDef?.ts || fieldDef?.sql || '');
        const isStringType = ['string', 'uuid', 'uniqueidentifier', 'nvarchar', 'varchar', 'text'].includes(rawType.toLowerCase());
        if (isStringType && !data[idFieldName]) {
            data[idFieldName] = (0, uuid_1.generateUUID)();
        }
    }
    async create(args) {
        const data = { ...args.data };
        this.assignId(data, this.fields);
        const cols = Object.keys(data).filter(k => data[k] !== undefined);
        const headers = await this.getOrCreateHeaders(cols);
        for (const h of headers) {
            if (data[h] === undefined)
                data[h] = null;
        }
        await this.adapter.appendRange(`${this.escSheetName}!A:A`, [
            this.rowToValues(data, headers),
        ]);
        return data;
    }
    async createMany(args) {
        if (args.data.length === 0)
            return { count: 0 };
        const fields = this.fields;
        const allKeys = new Set();
        for (const row of args.data)
            Object.keys(row).forEach(k => allKeys.add(k));
        const cols = [...allKeys];
        const prepared = args.data.map(item => {
            const data = { ...item };
            this.assignId(data, fields);
            return data;
        });
        const headers = await this.getOrCreateHeaders(cols);
        const batchValues = prepared.map(data => {
            for (const h of headers) {
                if (data[h] === undefined)
                    data[h] = null;
            }
            return this.rowToValues(data, headers);
        });
        try {
            await this.adapter.appendRange(`${this.escSheetName}!A:A`, batchValues);
            return { count: batchValues.length };
        }
        catch (e) {
            if (!args.skipDuplicates)
                throw e;
            let count = 0;
            for (const row of args.data) {
                try {
                    await this.create({ data: row });
                    count++;
                }
                catch { /* skip */ }
            }
            return { count };
        }
    }
    async update(args) {
        const { headers, rows } = await this.readAllRows();
        const matching = rows.filter(r => (0, helpers_1.matchWhere)(r, args.where));
        if (matching.length === 0)
            throw new Error('No record found matching where clause');
        const target = matching[0];
        const updated = { ...target, ...args.data, __row: target.__row };
        await this.adapter.writeRange(`${this.escSheetName}!A${target.__row}`, [
            this.rowToValues(updated, headers),
        ]);
        const { __row, ...rest } = updated;
        return rest;
    }
    async updateMany(args) {
        const { headers, rows } = await this.readAllRows();
        const matching = rows.filter(r => (0, helpers_1.matchWhere)(r, args.where));
        if (matching.length === 0)
            return { count: 0 };
        // Batch all writes into a single batchUpdate call
        const api = await this.adapter.getSheets();
        const spreadsheetId = this.adapter.config.spreadsheetId;
        const valueRanges = matching.map(target => {
            const updated = { ...target, ...args.data };
            return {
                range: `${this.escSheetName}!A${target.__row}`,
                values: [this.rowToValues(updated, headers)],
            };
        });
        await (0, retry_1.withRetry)(() => api.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'RAW', data: valueRanges },
        }));
        return { count: matching.length };
    }
    async delete(args) {
        const { rows } = await this.readAllRows();
        const matching = rows.filter(r => (0, helpers_1.matchWhere)(r, args.where));
        if (matching.length === 0)
            throw new Error('No record found matching where clause');
        const target = matching[0];
        const meta = await this.adapter.getSheetMeta(this.sheetName);
        if (!meta)
            throw new Error(`Sheet "${this.sheetName}" not found`);
        await this.deleteRowByIndex(target.__row, meta.sheetId);
        const { __row, ...rest } = target;
        return rest;
    }
    async deleteMany(args) {
        const { rows } = await this.readAllRows();
        const matching = rows.filter(r => (0, helpers_1.matchWhere)(r, args?.where));
        if (matching.length === 0)
            return { count: 0 };
        const meta = await this.adapter.getSheetMeta(this.sheetName);
        if (!meta)
            throw new Error(`Sheet "${this.sheetName}" not found`);
        // Batch all deletes into a single batchUpdate (sorted DESC to keep row indices stable)
        const api = await this.adapter.getSheets();
        const sorted = [...matching].sort((a, b) => b.__row - a.__row);
        const requests = sorted.map(target => ({
            deleteDimension: {
                range: {
                    sheetId: meta.sheetId,
                    dimension: 'ROWS',
                    startIndex: target.__row - 1,
                    endIndex: target.__row,
                },
            },
        }));
        await (0, retry_1.withRetry)(() => api.spreadsheets.batchUpdate({
            spreadsheetId: this.adapter.config.spreadsheetId,
            requestBody: { requests },
        }));
        return { count: matching.length };
    }
    async deleteAll() {
        const meta = await this.adapter.getSheetMeta(this.sheetName);
        if (!meta)
            return;
        const api = await this.adapter.getSheets();
        await (0, retry_1.withRetry)(() => api.spreadsheets.batchUpdate({
            spreadsheetId: this.adapter.config.spreadsheetId,
            requestBody: {
                requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: meta.sheetId,
                                dimension: 'ROWS',
                                startIndex: 1,
                                endIndex: 999999,
                            },
                        },
                    }],
            },
        }));
    }
    async clear() {
        const api = await this.adapter.getSheets();
        await (0, retry_1.withRetry)(() => api.spreadsheets.values.clear({
            spreadsheetId: this.adapter.config.spreadsheetId,
            range: `${this.escSheetName}!A2:ZZ`,
        }));
    }
    async upsert(args) {
        const existing = await this.findFirst({ where: args.where });
        if (existing) {
            return this.update({ where: args.where, data: args.update });
        }
        return this.create({ data: args.create });
    }
    async aggregate(args) {
        const rows = await this.findMany({ where: args?.where });
        const result = {};
        if (args._count !== undefined)
            result._count = rows.length;
        if (args._sum) {
            for (const f of Object.keys(args._sum)) {
                const nums = rows.map((r) => Number(r[f])).filter(n => !isNaN(n));
                result[`_sum_${f}`] = nums.length > 0 ? nums.reduce((s, n) => s + n, 0) : null;
            }
        }
        if (args._avg) {
            for (const f of Object.keys(args._avg)) {
                const nums = rows.map((r) => Number(r[f])).filter(n => !isNaN(n));
                result[`_avg_${f}`] = nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
            }
        }
        if (args._min) {
            for (const f of Object.keys(args._min)) {
                const nums = rows.map((r) => Number(r[f])).filter(n => !isNaN(n));
                result[`_min_${f}`] = nums.length > 0 ? Math.min(...nums) : null;
            }
        }
        if (args._max) {
            for (const f of Object.keys(args._max)) {
                const nums = rows.map((r) => Number(r[f])).filter(n => !isNaN(n));
                result[`_max_${f}`] = nums.length > 0 ? Math.max(...nums) : null;
            }
        }
        return result;
    }
    async groupBy(args) {
        const rows = await this.findMany({ where: args?.where });
        const byCols = args.by || [];
        const groups = {};
        for (const row of rows) {
            const key = byCols.map(c => row[c]).join('|');
            if (!groups[key])
                groups[key] = [];
            groups[key].push(row);
        }
        return Object.entries(groups).map(([key, group]) => {
            const entry = {};
            const parts = key.split('|');
            byCols.forEach((c, i) => { entry[c] = parts[i]; });
            entry._count = group.length;
            return entry;
        });
    }
    async vectorSearch(args) {
        const rows = await this.findMany({ where: args.where });
        const vectorField = args.vectorField || 'embedding';
        const metric = args.distanceMetric || 'cosine';
        const scored = [];
        for (const raw of rows) {
            const row = raw;
            const rawVec = row[vectorField];
            if (!rawVec)
                continue;
            let vec = [];
            try {
                vec = typeof rawVec === 'string' ? JSON.parse(rawVec) : rawVec;
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
            const dist = metric === 'cosine' ? 1 - cosine
                : metric === 'dot' ? -dot
                    : Math.sqrt(args.vector.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0));
            scored.push({ row, dist });
        }
        scored.sort((a, b) => a.dist - b.dist);
        return scored.slice(0, args.take ?? 10).map(s => ({ ...s.row, distance: s.dist }));
    }
}
exports.SheetsTableClient = SheetsTableClient;
