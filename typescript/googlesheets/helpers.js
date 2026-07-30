"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.esc = esc;
exports.resolveSheetName = resolveSheetName;
exports.matchWhere = matchWhere;
exports.buildOrderBy = buildOrderBy;
exports.sortRows = sortRows;
exports.coerceCell = coerceCell;
const metadata_1 = require("../base/metadata");
// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(name) {
    return name.includes(' ') || /[^\w]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}
function resolveSheetName(modelName, mapping) {
    if (mapping?.[modelName])
        return mapping[modelName];
    const modelToTable = (0, metadata_1.getModelToTable)();
    return modelToTable[modelName] || modelName;
}
function matchWhere(row, where) {
    if (!where)
        return true;
    const cleanWhere = {};
    for (const [key, value] of Object.entries(where)) {
        if (key.includes('_') &&
            value && typeof value === 'object' &&
            !(value instanceof Date) &&
            !value.in && !value.contains &&
            !value.not && !value.gte &&
            !value.lte && !value.gt && !value.lt) {
            Object.assign(cleanWhere, value);
        }
        else {
            cleanWhere[key] = value;
        }
    }
    for (const [key, value] of Object.entries(cleanWhere)) {
        if (key === 'OR' && Array.isArray(value)) {
            if (!value.some((v) => matchWhere(row, v)))
                return false;
            continue;
        }
        if (key === 'AND' && Array.isArray(value)) {
            if (!value.every((v) => matchWhere(row, v)))
                return false;
            continue;
        }
        const cellVal = row[key];
        if (value === null) {
            if (cellVal !== null && cellVal !== undefined)
                return false;
        }
        else if (typeof value === 'object' && !(value instanceof Date)) {
            const v = value;
            if (v.not !== undefined) {
                if (v.not === null) {
                    if (cellVal === null || cellVal === undefined)
                        return false;
                }
                else if (cellVal == v.not)
                    return false;
            }
            if (v.equals !== undefined && cellVal != v.equals)
                return false;
            if (v.contains !== undefined && (!cellVal || !String(cellVal).includes(v.contains)))
                return false;
            if (v.startsWith !== undefined && (!cellVal || !String(cellVal).startsWith(v.startsWith)))
                return false;
            if (v.endsWith !== undefined && (!cellVal || !String(cellVal).endsWith(v.endsWith)))
                return false;
            if (v.gte !== undefined && !(Number(cellVal) >= Number(v.gte)))
                return false;
            if (v.lte !== undefined && !(Number(cellVal) <= Number(v.lte)))
                return false;
            if (v.gt !== undefined && !(Number(cellVal) > Number(v.gt)))
                return false;
            if (v.lt !== undefined && !(Number(cellVal) < Number(v.lt)))
                return false;
            if (v.in !== undefined) {
                if (!Array.isArray(v.in) || !v.in.includes(cellVal))
                    return false;
            }
        }
        else {
            if (cellVal != value)
                return false;
        }
    }
    return true;
}
function buildOrderBy(orderBy) {
    if (!orderBy)
        return '';
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = [];
    for (const entry of entries) {
        for (const [key, dir] of Object.entries(entry)) {
            parts.push(`${key} ${dir.toUpperCase()}`);
        }
    }
    return parts.join(', ');
}
function sortRows(rows, orderBy) {
    if (!orderBy)
        return rows;
    const clauses = orderBy.split(',').map(c => c.trim());
    return [...rows].sort((a, b) => {
        for (const clause of clauses) {
            const [field, dir] = clause.split(/\s+/);
            const direction = dir?.toUpperCase() === 'DESC' ? -1 : 1;
            const aVal = a[field];
            const bVal = b[field];
            if (aVal == null && bVal == null)
                continue;
            if (aVal == null)
                return 1 * direction;
            if (bVal == null)
                return -1 * direction;
            if (aVal < bVal)
                return -1 * direction;
            if (aVal > bVal)
                return 1 * direction;
        }
        return 0;
    });
}
function coerceCell(raw, fieldMeta) {
    if (raw === undefined || raw === '')
        return null;
    if (raw instanceof Date)
        return raw.toISOString();
    if (fieldMeta) {
        const tsType = (fieldMeta.ts || '').toLowerCase().replace('?', '');
        if (['number', 'int', 'float', 'double', 'decimal'].includes(tsType)) {
            const n = Number(raw);
            return isNaN(n) ? raw : n;
        }
        if (tsType === 'boolean' || tsType === 'bool') {
            if (raw === 'true' || raw === true)
                return true;
            if (raw === 'false' || raw === false)
                return false;
        }
    }
    if (typeof raw === 'string' && /^-?\d+\.?\d*$/.test(raw.trim()) && !/^0\d/.test(raw.trim())) {
        const n = Number(raw);
        if (!isNaN(n) && String(n) === raw.trim())
            return n;
    }
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    return raw;
}
