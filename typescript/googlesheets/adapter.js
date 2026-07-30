"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.An5SheetsAdapter = void 0;
exports.createAn5SheetsAdapter = createAn5SheetsAdapter;
const googleapis_1 = require("googleapis");
const config_1 = require("./config");
const sqlExecutor_1 = require("./sqlExecutor");
const tableClient_1 = require("./tableClient");
const retry_1 = require("./retry");
// ─── Adapter ──────────────────────────────────────────────────────────────────
class An5SheetsAdapter {
    constructor(config) {
        this.sheets = null;
        this.sheetsCache = null;
        this.config = (0, config_1.resolveConfig)(config);
    }
    async getSheets() {
        if (!this.sheets) {
            const auth = new googleapis_1.google.auth.JWT({
                email: this.config.clientEmail,
                key: this.config.privateKey,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            this.sheets = googleapis_1.google.sheets({ version: 'v4', auth });
        }
        return this.sheets;
    }
    async getApi() {
        return this.getSheets();
    }
    invalidateCache() {
        this.sheetsCache = null;
    }
    async listSheets() {
        const api = await this.getApi();
        const res = await (0, retry_1.withRetry)(() => api.spreadsheets.get({
            spreadsheetId: this.config.spreadsheetId,
            fields: 'sheets.properties.title',
        }));
        return (res.data.sheets || []).map(s => s.properties?.title || '');
    }
    async getSheetMeta(name) {
        const api = await this.getApi();
        if (this.sheetsCache == null) {
            this.sheetsCache = (0, retry_1.withRetry)(async () => {
                const res = await api.spreadsheets.get({
                    spreadsheetId: this.config.spreadsheetId,
                    fields: 'sheets.properties',
                });
                return (res.data.sheets || []).map(s => ({
                    sheetId: s.properties?.sheetId ?? -1,
                    title: s.properties?.title ?? '',
                })).filter(m => m.sheetId >= 0);
            });
        }
        const all = await this.sheetsCache;
        return all.find(m => m.title === name) || null;
    }
    async deleteSheet(name) {
        const meta = await this.getSheetMeta(name);
        if (!meta)
            throw new Error(`Sheet "${name}" not found`);
        const api = await this.getApi();
        await (0, retry_1.withRetry)(() => api.spreadsheets.batchUpdate({
            spreadsheetId: this.config.spreadsheetId,
            requestBody: {
                requests: [{ deleteSheet: { sheetId: meta.sheetId } }],
            },
        }));
        this.invalidateCache();
    }
    async $connect() {
        await this.getSheets();
    }
    async $disconnect() {
        this.sheets = null;
        this.sheetsCache = null;
    }
    async exec(query, params) {
        return (0, sqlExecutor_1.execQuery)(this, query, params, undefined, undefined);
    }
    async $queryRawUnsafe(query, ...values) {
        const params = {};
        values.forEach((v, i) => { params[`p_${i}`] = v; });
        const resolved = query.replace(/@p_(\d+)/g, (_, i) => `@p_${i}`);
        return (0, sqlExecutor_1.execQuery)(this, resolved, params, undefined, undefined);
    }
    async $executeRaw(query, ...values) {
        const params = {};
        values.forEach((v, i) => { params[`p_${i}`] = v; });
        const resolved = query.replace(/@p_(\d+)/g, (_, i) => `@p_${i}`);
        return (0, sqlExecutor_1.execQuery)(this, resolved, params, undefined, undefined);
    }
    async $executeRawUnsafe(query, ...values) {
        return this.$executeRaw(query, ...values);
    }
    async $transaction(fn, _options) {
        if (typeof fn === 'function')
            return fn(this);
        return Promise.all(fn);
    }
    table(modelName) {
        return new tableClient_1.SheetsTableClient(this, modelName, this.config.sheetMapping);
    }
    // ── Raw range access ──────────────────────────────────────────────────────
    async readRange(range) {
        const api = await this.getApi();
        const res = await (0, retry_1.withRetry)(() => api.spreadsheets.values.get({
            spreadsheetId: this.config.spreadsheetId,
            range,
        }));
        return (res.data.values || []);
    }
    async writeRange(range, values) {
        const api = await this.getApi();
        await (0, retry_1.withRetry)(() => api.spreadsheets.values.update({
            spreadsheetId: this.config.spreadsheetId,
            range,
            valueInputOption: 'RAW',
            requestBody: { values },
        }));
    }
    async appendRange(range, values) {
        const api = await this.getApi();
        await (0, retry_1.withRetry)(() => api.spreadsheets.values.append({
            spreadsheetId: this.config.spreadsheetId,
            range,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values },
        }));
    }
}
exports.An5SheetsAdapter = An5SheetsAdapter;
// ─── Factory ──────────────────────────────────────────────────────────────────
function createAn5SheetsAdapter(config) {
    return new An5SheetsAdapter(config);
}
