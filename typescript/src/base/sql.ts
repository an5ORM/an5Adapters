import type { Dialect } from './types';

// ─── Quoting ───────────────────────────────────────────────────────────────────────

function stripWrapping(name: string, left: string, right: string): string {
  return name.startsWith(left) && name.endsWith(right) ? name.slice(left.length, -right.length) : name;
}

export function quote(name: string, dialect: Dialect): string {
  const raw = String(name);
  if (dialect === 'postgres') {
    const unwrapped = stripWrapping(stripWrapping(raw, '[', ']'), '"', '"');
    return `"${unwrapped.replace(/"/g, '""')}"`;
  }
  if (dialect === 'mysql') {
    const unwrapped = stripWrapping(stripWrapping(raw, '[', ']'), '`', '`');
    return `\`${unwrapped.replace(/`/g, '``')}\``;
  }
  // mssql / sqlite
  const unwrapped = stripWrapping(raw, '[', ']');
  return `[${unwrapped.replace(/\]/g, ']]')}]`;
}

function sanitizeParamName(name: string): string {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `p_${cleaned}`;
}

function normalizeSortDirection(dir: unknown): 'ASC' | 'DESC' {
  return typeof dir === 'string' && dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

// ─── Where clause builder ──────────────────────────────────────────────────────────

const OPERATOR_KEYS = ['equals', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'not', 'gte', 'lte', 'gt', 'lt'];

function isOperatorValue(value: any): boolean {
  if (!value || typeof value !== 'object' || value instanceof Date) return false;
  return OPERATOR_KEYS.some(op => op in value);
}

export function parseWhere(modelName: string, where: any, params: Record<string, any>, dialect: Dialect, prefix = ''): string {
  if (!where) return '';
  const conditions: string[] = [];

  const cleanWhere: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key.includes('_') &&
      value && typeof value === 'object' &&
      !(value instanceof Date) &&
      !isOperatorValue(value)
    ) {
      Object.assign(cleanWhere, value);
    } else {
      cleanWhere[key] = value;
    }
  }

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (key === 'OR' && Array.isArray(value)) {
      const sub = value.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}or_${i}_`)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' OR ')})`);
    } else if (key === 'AND') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}and_${i}_`)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' AND ')})`);
    } else if (key === 'NOT') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}not_${i}_`)).filter(Boolean);
      if (sub.length > 0) conditions.push(`NOT (${sub.join(' AND ')})`);
    } else {
      const pname = sanitizeParamName(`${prefix}${key}`);
      const col = quote(key, dialect);

      if (value === null) {
        conditions.push(`${col} IS NULL`);
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        const v = value as any;
        if (v.not !== undefined) {
          if (v.not === null) { conditions.push(`${col} IS NOT NULL`); }
          else if (v.not && typeof v.not === 'object' && !(v.not instanceof Date) && !Array.isArray(v.not)) {
            const nestedParams: Record<string, any> = {};
            const nestedSql = parseWhere(modelName, { [key]: v.not }, nestedParams, dialect, `${prefix}${key}_not_`);
            Object.assign(params, nestedParams);
            if (nestedSql) conditions.push(`NOT (${nestedSql})`);
          } else { const p = `${pname}_not`; params[p] = v.not; conditions.push(`${col} <> @${p}`); }
        }
        if (v.equals !== undefined) {
          if (v.equals === null) { conditions.push(`${col} IS NULL`); }
          else { const p = `${pname}_eq`; params[p] = v.equals; conditions.push(`${col} = @${p}`); }
        }
        if (v.contains !== undefined) { const p = `${pname}_co`; params[p] = `%${v.contains}%`; conditions.push(`${col} LIKE @${p}`); }
        if (v.startsWith !== undefined) { const p = `${pname}_sw`; params[p] = `${v.startsWith}%`; conditions.push(`${col} LIKE @${p}`); }
        if (v.endsWith !== undefined) { const p = `${pname}_ew`; params[p] = `%${v.endsWith}`; conditions.push(`${col} LIKE @${p}`); }
        if (v.gte !== undefined) { const p = `${pname}_gte`; params[p] = v.gte; conditions.push(`${col} >= @${p}`); }
        if (v.lte !== undefined) { const p = `${pname}_lte`; params[p] = v.lte; conditions.push(`${col} <= @${p}`); }
        if (v.gt !== undefined) { const p = `${pname}_gt`; params[p] = v.gt; conditions.push(`${col} > @${p}`); }
        if (v.lt !== undefined) { const p = `${pname}_lt`; params[p] = v.lt; conditions.push(`${col} < @${p}`); }
        if (v.in !== undefined) {
          if (Array.isArray(v.in) && v.in.length > 0) {
            const ps = v.in.map((x: any, i: number) => { const p = `${pname}_in${i}`; params[p] = x; return `@${p}`; });
            conditions.push(`${col} IN (${ps.join(', ')})`);
          } else {
            conditions.push('1=0');
          }
        }
        if (v.notIn !== undefined) {
          if (Array.isArray(v.notIn) && v.notIn.length > 0) {
            const ps = v.notIn.map((x: any, i: number) => { const p = `${pname}_notin${i}`; params[p] = x; return `@${p}`; });
            conditions.push(`${col} NOT IN (${ps.join(', ')})`);
          } else {
            conditions.push('1=1');
          }
        }
      } else {
        params[pname] = value;
        conditions.push(`${col} = @${pname}`);
      }
    }
  }
  return conditions.join(' AND ');
}

// ─── Order by builder ──────────────────────────────────────────────────────────────

export function buildOrderBy(orderBy: any, dialect: Dialect): string {
  if (!orderBy) return '';
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const entry of entries) {
    for (const [key, dir] of Object.entries(entry)) {
      parts.push(`${quote(key, dialect)} ${normalizeSortDirection(dir)}`);
    }
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}
