"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quote = quote;
exports.parseWhere = parseWhere;
exports.buildOrderBy = buildOrderBy;
// ─── Quoting ───────────────────────────────────────────────────────────────────────
function quote(name, dialect) {
    if (dialect === 'postgres') {
        if (name.startsWith('[') && name.endsWith(']'))
            return `"${name.slice(1, -1)}"`;
        if (name.startsWith('"'))
            return name;
        return `"${name}"`;
    }
    if (dialect === 'mysql') {
        if (name.startsWith('[') && name.endsWith(']'))
            return `\`${name.slice(1, -1)}\``;
        if (name.startsWith('`'))
            return name;
        return `\`${name}\``;
    }
    // mssql / sqlite
    return name.startsWith('[') ? name : `[${name}]`;
}
// ─── Where clause builder ──────────────────────────────────────────────────────────
function parseWhere(modelName, where, params, dialect, prefix = '') {
    if (!where)
        return '';
    const conditions = [];
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
            const sub = value.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}or_${i}_`)).filter(Boolean);
            if (sub.length > 0)
                conditions.push(`(${sub.join(' OR ')})`);
        }
        else if (key === 'AND' && Array.isArray(value)) {
            const sub = value.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}and_${i}_`)).filter(Boolean);
            if (sub.length > 0)
                conditions.push(`(${sub.join(' AND ')})`);
        }
        else {
            const pname = `${prefix}${key}`;
            const col = quote(key, dialect);
            if (value === null) {
                conditions.push(`${col} IS NULL`);
            }
            else if (typeof value === 'object' && !(value instanceof Date)) {
                const v = value;
                if (v.not !== undefined) {
                    if (v.not === null) {
                        conditions.push(`${col} IS NOT NULL`);
                    }
                    else {
                        const p = `${pname}_not`;
                        params[p] = v.not;
                        conditions.push(`${col} <> @${p}`);
                    }
                }
                if (v.equals !== undefined) {
                    const p = `${pname}_eq`;
                    params[p] = v.equals;
                    conditions.push(`${col} = @${p}`);
                }
                if (v.contains !== undefined) {
                    const p = `${pname}_co`;
                    params[p] = `%${v.contains}%`;
                    conditions.push(`${col} LIKE @${p}`);
                }
                if (v.startsWith !== undefined) {
                    const p = `${pname}_sw`;
                    params[p] = `${v.startsWith}%`;
                    conditions.push(`${col} LIKE @${p}`);
                }
                if (v.endsWith !== undefined) {
                    const p = `${pname}_ew`;
                    params[p] = `%${v.endsWith}`;
                    conditions.push(`${col} LIKE @${p}`);
                }
                if (v.gte !== undefined) {
                    const p = `${pname}_gte`;
                    params[p] = v.gte;
                    conditions.push(`${col} >= @${p}`);
                }
                if (v.lte !== undefined) {
                    const p = `${pname}_lte`;
                    params[p] = v.lte;
                    conditions.push(`${col} <= @${p}`);
                }
                if (v.gt !== undefined) {
                    const p = `${pname}_gt`;
                    params[p] = v.gt;
                    conditions.push(`${col} > @${p}`);
                }
                if (v.lt !== undefined) {
                    const p = `${pname}_lt`;
                    params[p] = v.lt;
                    conditions.push(`${col} < @${p}`);
                }
                if (v.in !== undefined) {
                    if (Array.isArray(v.in) && v.in.length > 0) {
                        const ps = v.in.map((x, i) => { const p = `${pname}_in${i}`; params[p] = x; return `@${p}`; });
                        conditions.push(`${col} IN (${ps.join(', ')})`);
                    }
                    else {
                        conditions.push('1=0');
                    }
                }
            }
            else {
                params[pname] = value;
                conditions.push(`${col} = @${pname}`);
            }
        }
    }
    return conditions.join(' AND ');
}
// ─── Order by builder ──────────────────────────────────────────────────────────────
function buildOrderBy(orderBy, dialect) {
    if (!orderBy)
        return '';
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = [];
    for (const entry of entries) {
        for (const [key, dir] of Object.entries(entry)) {
            parts.push(`${quote(key, dialect)} ${dir.toUpperCase()}`);
        }
    }
    return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}
