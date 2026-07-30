"use strict";
// ─── Config ───────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeKey = normalizeKey;
exports.resolveConfig = resolveConfig;
function normalizeKey(key) {
    if (key.includes('PRIVATE KEY'))
        return key;
    const lines = key.split('\\n').join('\n');
    if (lines.includes('PRIVATE KEY'))
        return lines;
    return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}
function resolveConfig(config) {
    if (config.accessToken) {
        return {
            spreadsheetId: config.spreadsheetId,
            accessToken: config.accessToken,
            sheetMapping: config.sheetMapping,
        };
    }
    if (config.credentials) {
        return {
            spreadsheetId: config.spreadsheetId,
            clientEmail: config.credentials.client_email,
            privateKey: normalizeKey(config.credentials.private_key),
            sheetMapping: config.sheetMapping,
        };
    }
    return {
        spreadsheetId: config.spreadsheetId,
        clientEmail: config.clientEmail,
        privateKey: normalizeKey(config.privateKey),
        sheetMapping: config.sheetMapping,
    };
}
