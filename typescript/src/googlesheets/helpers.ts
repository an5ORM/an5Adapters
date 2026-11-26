import { getModelToTable } from '../base/metadata';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function esc(name: string): string {
  return name.includes(' ') || /[^\w]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

export function resolveSheetName(modelName: string, mapping?: Record<string, string>): string {
  if (mapping?.[modelName]) return mapping[modelName];
  const modelToTable = getModelToTable();
  return modelToTable[modelName] || modelName;
}

const SHEETS_OPERATOR_KEYS = new Set([
  'equals', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'not', 'gte', 'lte', 'gt', 'lt', 'mode',
]);
const SHEETS_RELATION_OPERATOR_KEYS = new Set(['some', 'none', 'every', 'is', 'isNot', 'is_not']);

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof RegExp) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function matchScalarFilter(cellVal: any, fieldLabel: string, value: any): boolean {
  if (Array.isArray(value)) {
    throw new Error(`Invalid array filter value for field '${fieldLabel}'; use { in: [...] } instead`);
  }

  if (value === null) {
    return cellVal === null || cellVal === undefined;
  }

  if (isPlainObject(value)) {
    const v = value as Record<string, any>;
    for (const op of Object.keys(v)) {
      if (v[op] === undefined) continue;
      if (SHEETS_RELATION_OPERATOR_KEYS.has(op)) {
        throw new Error(`Relation filter operator '${op}' is not supported on scalar field '${fieldLabel}'`);
      }
      if (!SHEETS_OPERATOR_KEYS.has(op)) {
        throw new Error(`Unknown filter operator '${op}' on field '${fieldLabel}'`);
      }
    }
    if (v.mode !== undefined && v.mode !== 'default' && v.mode !== 'insensitive') {
      throw new Error(`Invalid filter mode '${String(v.mode)}' on field '${fieldLabel}'; expected 'default' or 'insensitive'`);
    }

    const caseInsensitive = v.mode === 'insensitive';
    const normalize = (s: any) => (caseInsensitive && typeof s === 'string' ? s.toLowerCase() : s);

    if (v.not !== undefined) {
      if (v.not === null) { if (cellVal === null || cellVal === undefined) return false; }
      else if (Array.isArray(v.not)) {
        throw new Error(`Filter operator 'not' on field '${fieldLabel}' cannot be an array; use 'notIn' instead`);
      } else if (isPlainObject(v.not)) {
        if (matchScalarFilter(cellVal, fieldLabel, v.not)) return false;
      } else if (normalize(cellVal) == normalize(v.not)) {
        return false;
      }
    }
    if (v.equals !== undefined) {
      if (v.equals === null) {
        if (cellVal !== null && cellVal !== undefined) return false;
      } else if (Array.isArray(v.equals) || isPlainObject(v.equals)) {
        throw new Error(`Filter operator 'equals' on field '${fieldLabel}' must be a scalar value or null`);
      } else if (normalize(cellVal) != normalize(v.equals)) {
        return false;
      }
    }
    for (const [op, matchFn] of [
      ['contains', (hay: string, needle: string) => hay.includes(needle)],
      ['startsWith', (hay: string, needle: string) => hay.startsWith(needle)],
      ['endsWith', (hay: string, needle: string) => hay.endsWith(needle)],
    ] as const) {
      if (v[op] !== undefined) {
        if (typeof v[op] !== 'string') throw new Error(`Filter operator '${op}' on field '${fieldLabel}' must be a string`);
        if (cellVal === null || cellVal === undefined) return false;
        const hay = caseInsensitive ? String(cellVal).toLowerCase() : String(cellVal);
        const needle = caseInsensitive ? v[op].toLowerCase() : v[op];
        if (!matchFn(hay, needle)) return false;
      }
    }
    for (const [op, cmp] of [
      ['gte', (a: number, b: number) => a >= b],
      ['lte', (a: number, b: number) => a <= b],
      ['gt', (a: number, b: number) => a > b],
      ['lt', (a: number, b: number) => a < b],
    ] as const) {
      if (v[op] !== undefined) {
        if (v[op] === null || Array.isArray(v[op]) || isPlainObject(v[op])) {
          throw new Error(`Filter operator '${op}' on field '${fieldLabel}' must be a scalar comparison value`);
        }
        if (cellVal === null || cellVal === undefined) return false;
        if (!cmp(Number(cellVal), Number(v[op]))) return false;
      }
    }
    if (v.in !== undefined) {
      if (!Array.isArray(v.in)) {
        throw new Error(`Filter operator 'in' on field '${fieldLabel}' must be an array`);
      }
      if (!v.in.some((item: any) => normalize(item) == normalize(cellVal))) return false;
    }
    if (v.notIn !== undefined) {
      if (!Array.isArray(v.notIn)) {
        throw new Error(`Filter operator 'notIn' on field '${fieldLabel}' must be an array`);
      }
      if (v.notIn.some((item: any) => normalize(item) == normalize(cellVal))) return false;
    }
    return true;
  }

  if (typeof value === 'function' || typeof value === 'symbol' || value instanceof RegExp) {
    throw new Error(`Invalid filter value for field '${fieldLabel}'`);
  }

  // loose equality to handle string/number coercion from sheet cells
  return cellVal == value;
}

export function matchWhere(row: Record<string, any>, where: any): boolean {
  if (where === null || where === undefined) return true;
  if (!isPlainObject(where)) {
    throw new Error('Where clause must be a plain object');
  }

  const cleanWhere: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key !== 'OR' &&
      key !== 'AND' &&
      key !== 'NOT' &&
      key.includes('_') &&
      !Object.prototype.hasOwnProperty.call(row, key) &&
      isPlainObject(value) &&
      !Object.keys(value).some(op => SHEETS_OPERATOR_KEYS.has(op) || SHEETS_RELATION_OPERATOR_KEYS.has(op))
    ) {
      const subKeys = Object.keys(value).filter(sk => value[sk] !== undefined);
      if (subKeys.length > 0 && subKeys.every(sk => Object.prototype.hasOwnProperty.call(row, sk) || key.includes(sk))) {
        Object.assign(cleanWhere, value);
        continue;
      }
    }
    cleanWhere[key] = value;
  }

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (value === undefined) continue;
    if (key === 'OR') {
      if (!Array.isArray(value)) {
        throw new Error('OR filter must be an array of filter objects');
      }
      for (const v of value) {
        if (!isPlainObject(v)) throw new Error('OR filter entries must be plain objects');
      }
      if (!value.some((v: any) => matchWhere(row, v))) return false;
      continue;
    }
    if (key === 'AND') {
      const clauses = Array.isArray(value) ? value : [value];
      for (const v of clauses) {
        if (!isPlainObject(v)) throw new Error('AND filter must be a plain object or an array of plain objects');
      }
      if (!clauses.every((v: any) => matchWhere(row, v))) return false;
      continue;
    }
    if (key === 'NOT') {
      const notClauses = Array.isArray(value) ? value : [value];
      for (const v of notClauses) {
        if (!isPlainObject(v)) throw new Error('NOT filter must be a plain object or an array of plain objects');
      }
      if (notClauses.some((v: any) => matchWhere(row, v))) return false;
      continue;
    }

    if (!matchScalarFilter(row[key], key, value)) return false;
  }
  return true;
}

const SHEETS_HAVING_AGGREGATES = new Set(['_count', '_sum', '_avg', '_min', '_max']);

export function computeGroupAggregates(
  group: Record<string, any>[],
  aggKey: string,
  field: string,
): any {
  if (aggKey === '_count') {
    if (field === '_all') return group.length;
    return group.filter(r => r[field] !== null && r[field] !== undefined).length;
  }
  const nonNull = group.map(r => r[field]).filter(v => v !== null && v !== undefined);
  if (nonNull.length === 0) return null;
  if (aggKey === '_sum' || aggKey === '_avg') {
    const nums = nonNull
      .filter(v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)))
      .map(Number);
    if (nums.length === 0) return null;
    const sum = nums.reduce((s, n) => s + n, 0);
    return aggKey === '_sum' ? sum : sum / nums.length;
  }
  if (nonNull.every(v => typeof v === 'number' && Number.isFinite(v))) {
    const nums = nonNull as number[];
    return aggKey === '_min' ? Math.min(...nums) : Math.max(...nums);
  }
  const sorted = [...nonNull].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return aggKey === '_min' ? sorted[0] : sorted[sorted.length - 1];
}

export function matchHaving(
  group: Record<string, any>[],
  byFields: string[],
  having: any,
): boolean {
  if (having === null || having === undefined) return true;
  if (!isPlainObject(having)) {
    throw new Error('Having clause must be a plain object');
  }
  const byFieldSet = new Set(byFields.map(f => f.toLowerCase()));
  const sampleRow = group[0] || {};

  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;
    if (key === 'OR') {
      if (!Array.isArray(value)) throw new Error('OR filter must be an array of filter objects');
      for (const v of value) {
        if (!isPlainObject(v)) throw new Error('OR filter entries must be plain objects');
      }
      if (!value.some((v: any) => matchHaving(group, byFields, v))) return false;
      continue;
    }
    if (key === 'AND') {
      const clauses = Array.isArray(value) ? value : [value];
      for (const v of clauses) {
        if (!isPlainObject(v)) throw new Error('AND filter must be a plain object or an array of plain objects');
      }
      if (!clauses.every((v: any) => matchHaving(group, byFields, v))) return false;
      continue;
    }
    if (key === 'NOT') {
      const notClauses = Array.isArray(value) ? value : [value];
      for (const v of notClauses) {
        if (!isPlainObject(v)) throw new Error('NOT filter must be a plain object or an array of plain objects');
      }
      if (notClauses.some((v: any) => matchHaving(group, byFields, v))) return false;
      continue;
    }
    if (SHEETS_HAVING_AGGREGATES.has(key)) {
      if (!isPlainObject(value)) {
        throw new Error(`Having '${key}' filter must be a plain object`);
      }
      for (const [field, filter] of Object.entries(value)) {
        if (filter === undefined) continue;
        if (field === '_all' && key !== '_count') {
          throw new Error(`Having '${key}' does not support '_all'; specify a field name`);
        }
        const metric = computeGroupAggregates(group, key, field);
        if (!matchScalarFilter(metric, `${key}.${field}`, filter)) return false;
      }
      continue;
    }
    if (key.startsWith('_')) {
      throw new Error(`Unknown having aggregate key '${key}'`);
    }
    if (byFieldSet.size > 0 && !byFieldSet.has(key.toLowerCase())) {
      throw new Error(
        `Field '${key}' in having must be included in groupBy 'by' fields or wrapped in an aggregate (_count, _sum, _avg, _min, _max)`,
      );
    }
    if (!matchScalarFilter(sampleRow[key], key, value)) return false;
  }
  return true;
}


export function buildOrderBy(orderBy: any): string {
  if (!orderBy) return '';
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const entry of entries) {
    for (const [key, dir] of Object.entries(entry)) {
      parts.push(`${key} ${String(dir || 'asc').toUpperCase()}`);
    }
  }
  return parts.join(', ');
}

export function sortRows(rows: Record<string, any>[], orderBy: string): Record<string, any>[] {
  if (!orderBy) return rows;
  const clauses = orderBy.split(',').map(c => c.trim());
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, dir] = clause.split(/\s+/);
      if (field === undefined) continue;
      const direction = dir?.toUpperCase() === 'DESC' ? -1 : 1;
      const aVal = a[field];
      const bVal = b[field];
      if (aVal == null && bVal == null) continue;
      if (aVal == null) return 1 * direction;
      if (bVal == null) return -1 * direction;
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
    }
    return 0;
  });
}

export function coerceCell(raw: any, fieldMeta?: { ts?: string; sql?: string }): any {
  if (raw === undefined || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString();
  if (fieldMeta) {
    const tsType = (fieldMeta.ts || '').toLowerCase().replace('?', '');
    if (['number', 'int', 'float', 'double', 'decimal'].includes(tsType)) {
      const n = Number(raw);
      return isNaN(n) ? raw : n;
    }
    if (tsType === 'boolean' || tsType === 'bool') {
      if (raw === 'true' || raw === true) return true;
      if (raw === 'false' || raw === false) return false;
    }
  }
  if (typeof raw === 'string' && /^-?\d+\.?\d*$/.test(raw.trim()) && !/^0\d/.test(raw.trim())) {
    const n = Number(raw);
    if (!isNaN(n) && String(n) === raw.trim()) return n;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}
