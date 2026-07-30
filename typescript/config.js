"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetAdapter = resetAdapter;
exports.getLlmConfig = getLlmConfig;
exports.setLlmConfig = setLlmConfig;
exports.getEmbeddingConfig = getEmbeddingConfig;
exports.setEmbeddingConfig = setEmbeddingConfig;
const an5Adapter_1 = require("./an5Adapter");
let _adapter = null;
function getAdapter() {
    if (_adapter)
        return _adapter;
    const url = process.env.DATABASE_URL;
    if (!url)
        return null;
    try {
        _adapter = (0, an5Adapter_1.createAn5Adapter)({ connectionString: url });
        return _adapter;
    }
    catch {
        return null;
    }
}
function resetAdapter() {
    _adapter = null;
}
async function getLlmConfig() {
    const adapter = getAdapter();
    if (!adapter)
        return null;
    try {
        const rows = await adapter.table('LlmConfig').findMany({
            where: { isActive: true },
        });
        if (rows.length > 0) {
            const c = rows[0];
            return { provider: c.provider, apiKey: c.apiKey, model: c.model, endpoint: c.endpoint };
        }
    }
    catch { }
    return null;
}
async function setLlmConfig(data) {
    const adapter = getAdapter();
    if (!adapter)
        throw new Error('DATABASE_URL not configured');
    const existing = await adapter.table('LlmConfig').findFirst({ where: { isActive: true } });
    if (existing) {
        await adapter.table('LlmConfig').update({
            where: { id: existing.id },
            data: { ...data, updatedAt: new Date() },
        });
    }
    else {
        await adapter.table('LlmConfig').create({
            data: { ...data, isActive: true, createdAt: new Date(), updatedAt: new Date() },
        });
    }
}
async function getEmbeddingConfig() {
    const adapter = getAdapter();
    if (!adapter)
        return null;
    try {
        const rows = await adapter.table('EmbeddingConfig').findMany({
            where: { isActive: true },
        });
        if (rows.length > 0) {
            const c = rows[0];
            return { provider: c.provider, apiKey: c.apiKey, model: c.model, endpoint: c.endpoint };
        }
    }
    catch { }
    return null;
}
async function setEmbeddingConfig(data) {
    const adapter = getAdapter();
    if (!adapter)
        throw new Error('DATABASE_URL not configured');
    const existing = await adapter.table('EmbeddingConfig').findFirst({ where: { isActive: true } });
    if (existing) {
        await adapter.table('EmbeddingConfig').update({
            where: { id: existing.id },
            data: { ...data, updatedAt: new Date() },
        });
    }
    else {
        await adapter.table('EmbeddingConfig').create({
            data: { ...data, isActive: true, createdAt: new Date(), updatedAt: new Date() },
        });
    }
}
