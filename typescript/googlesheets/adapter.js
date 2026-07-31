"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.An5SheetsAdapter = void 0;
exports.createAn5SheetsAdapter = createAn5SheetsAdapter;
const config_1 = require("./config");
const sqlExecutor_1 = require("./sqlExecutor");
const tableClient_1 = require("./tableClient");
const retry_1 = require("./retry");
// ─── Fetch-based API proxy for OAuth Access Token (browser-compatible) ────────
function createFetchApi(spreadsheetId, accessToken) {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    async function request(method, path, body) {
        const url = path.startsWith('http') ? path : `${base}${path}`;
        const opts = { method, headers };
        if (body)
            opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(`Google Sheets API error (${res.status}): ${text}`);
            err.status = res.status;
            err.body = text;
            const retryAfter = res.headers.get('Retry-After');
            if (retryAfter)
                err.retryAfter = parseInt(retryAfter, 10);
            throw err;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : undefined;
    }
    function fmtRange(range) {
        return `/${encodeURIComponent(range)}`;
    }
    return {
        spreadsheets: {
            get: async (params) => {
                const data = await request('GET', `?fields=${params.fields || ''}`);
                return { data };
            },
            batchUpdate: async (params) => {
                const data = await request('POST', ':batchUpdate', params.requestBody);
                return { data };
            },
            values: {
                get: async (params) => {
                    const data = await request('GET', fmtRange(params.range));
                    return { data };
                },
                update: async (params) => {
                    const qs = `?valueInputOption=${params.valueInputOption || 'RAW'}`;
                    const data = await request('PUT', `${fmtRange(params.range)}${qs}`, params.requestBody);
                    return { data };
                },
                append: async (params) => {
                    const qs = `?valueInputOption=${params.valueInputOption || 'RAW'}&insertDataOption=${params.insertDataOption || 'INSERT_ROWS'}`;
                    await request('POST', `${fmtRange(params.range)}:append${qs}`, params.requestBody);
                    return { data: { updates: { updatedRows: (params.requestBody?.values || []).length } } };
                },
                clear: async (params) => {
                    await request('POST', `${fmtRange(params.range)}:clear`);
                    return { data: {} };
                },
            },
        },
    };
}
// ─── Adapter ──────────────────────────────────────────────────────────────────
class An5SheetsAdapter {
    constructor(config) {
        this.sheets = null;
        this.fetchApi = null;
        this.sheetsCache = null;
        this.config = (0, config_1.resolveConfig)(config);
    }
    get isOAuth() {
        return !!this.config.accessToken;
    }
    async getSheets() {
        if (this.isOAuth) {
            if (!this.fetchApi) {
                this.fetchApi = createFetchApi(this.config.spreadsheetId, this.config.accessToken);
            }
            return this.fetchApi;
        }
        if (!this.sheets) {
            const { google } = await import('googleapis');
            const auth = new google.auth.JWT({
                email: this.config.clientEmail,
                key: this.config.privateKey,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            this.sheets = google.sheets({ version: 'v4', auth });
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
        return (res.data.sheets || []).map((s) => s.properties?.title || '');
    }
    async getSheetMeta(name) {
        const api = await this.getApi();
        if (this.sheetsCache == null) {
            this.sheetsCache = (0, retry_1.withRetry)(async () => {
                const res = await api.spreadsheets.get({
                    spreadsheetId: this.config.spreadsheetId,
                    fields: 'sheets.properties',
                });
                return (res.data.sheets || []).map((s) => ({
                    sheetId: s.properties?.sheetId ?? -1,
                    title: s.properties?.title ?? '',
                })).filter((m) => m.sheetId >= 0);
            });
        }
        const all = await this.sheetsCache;
        return all.find((m) => m.title === name) || null;
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
        this.fetchApi = null;
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
