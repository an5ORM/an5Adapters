import type { Dialect } from './types';
import type { RelationDef } from './metadata';

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

/** Quote a full table reference (may already be quoted, and may contain schema parts). */
export function quoteTable(name: string, dialect: Dialect): string {
  const raw = String(name);
  if (raw.startsWith('[') || raw.startsWith('"') || raw.startsWith('`')) return raw;
  if (raw.includes('.')) {
    const open = dialect === 'mysql' ? '`' : dialect === 'postgres' ? '"' : '[';
    const close = open === '[' ? ']' : open;
    return raw.split('.').map(p => `${open}${p.replace(new RegExp(close.replace(/[[\]]/g, '\\$&'), 'g'), close.repeat(2))}${close}`).join('.');
  }
  return quote(raw, dialect);
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

export interface WhereContext {
  /** Relations of the current model keyed by relation name. */
  relationMap?: Record<string, Record<string, RelationDef>>;
  /** model name → table name for resolving related tables. */
  modelToTable?: Record<string, string>;
  /** Fully-qualified reference to the current (self) table, e.g. `[users]` or `[dbo].[users]`. */
  selfRef?: string;
  /** Column prefix to disambiguate inside a correlated subquery (e.g. `__r.`). Includes trailing dot. */
  colPrefix?: string;
}

function resolveTable(modelName: string, ctx?: WhereContext): string {
  if (ctx?.modelToTable?.[modelName]) return ctx.modelToTable[modelName];
  const camel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  if (ctx?.modelToTable?.[camel]) return ctx.modelToTable[camel];
  const lower = modelName.toLowerCase();
  if (ctx?.modelToTable?.[lower]) return ctx.modelToTable[lower];
  return modelName;
}

/**
 * Build a WHERE clause. Supports scalar fields, operators and relation filters
 * (`some`/`none`/`every` for to-many, `is`/`isNot` for to-one) via EXISTS
 * subqueries when `ctx.relationMap` is provided.
 */
export function parseWhere(
  modelName: string,
  where: any,
  params: Record<string, any>,
  dialect: Dialect,
  prefix = '',
  ctx?: WhereContext,
): string {
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

  const relations = ctx?.relationMap?.[modelName] || {};
  const colPrefix = ctx?.colPrefix || '';

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (key === 'OR' && Array.isArray(value)) {
      const sub = value.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}or_${i}_`, ctx)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' OR ')})`);
    } else if (key === 'AND') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}and_${i}_`, ctx)).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' AND ')})`);
    } else if (key === 'NOT') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => parseWhere(modelName, v, params, dialect, `${prefix}not_${i}_`, ctx)).filter(Boolean);
      if (sub.length > 0) conditions.push(`NOT (${sub.join(' AND ')})`);
    } else if (relations[key] && value && typeof value === 'object') {
      const clause = buildRelationClause(relations[key], value, modelName, params, dialect, prefix, ctx);
      if (clause) conditions.push(clause);
    } else {
      const pname = sanitizeParamName(`${prefix}${key}`);
      const col = `${colPrefix}${quote(key, dialect)}`;

      if (value === null) {
        conditions.push(`${col} IS NULL`);
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        const v = value as any;
        if (v.not !== undefined) {
          if (v.not === null) { conditions.push(`${col} IS NOT NULL`); }
          else if (v.not && typeof v.not === 'object' && !(v.not instanceof Date) && !Array.isArray(v.not)) {
            const nestedParams: Record<string, any> = {};
            const nestedSql = parseWhere(modelName, { [key]: v.not }, nestedParams, dialect, `${prefix}${key}_not_`, ctx);
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

function buildRelationClause(
  relation: RelationDef,
  value: any,
  modelName: string,
  params: Record<string, any>,
  dialect: Dialect,
  prefix: string,
  ctx?: WhereContext,
): string | null {
  const isMany = relation.relationType === 'many';
  const qname = `${prefix}rel_${sanitizeParamName(relation.modelName)}`;
  const childAlias = `__r_${sanitizeParamName(relation.modelName)}${qname.length}`.replace(/[^A-Za-z0-9_]/g, '_');
  const childTable = quoteTable(resolveTable(relation.modelName, ctx), dialect);
  const fk = quote(relation.foreignKey, dialect);
  const lk = quote(relation.localKey, dialect);
  const selfRef = (ctx?.selfRef || quoteTable(modelName, dialect)) + `.`;

  // Correlation between the parent row and the related row.
  const correlation = `${childAlias}.${fk} = ${selfRef}${lk}`;

  // Correlated subquery for "there exists a related row matching <innerWhere>".
  const buildExists = (innerWhere: string): string => {
    const inner = innerWhere ? ` AND (${innerWhere})` : '';
    return `EXISTS (SELECT 1 FROM ${childTable} AS ${childAlias} WHERE ${correlation}${inner})`;
  };

  const parts: string[] = [];

  if (isMany) {
    if (value.some !== undefined) {
      const inner = buildInnerWhere(relation.modelName, value.some === null ? {} : value.some, params, dialect, prefix, ctx, childAlias);
      parts.push(buildExists(inner));
    }
    if (value.none !== undefined) {
      const inner = buildInnerWhere(relation.modelName, value.none === null ? {} : value.none, params, dialect, prefix, ctx, childAlias);
      parts.push(`NOT ${buildExists(inner)}`);
    }
    if (value.every !== undefined) {
      // "every" = no related row violates the condition.
      const inner = buildInnerWhere(relation.modelName, value.every === null ? {} : value.every, params, dialect, prefix, ctx, childAlias);
      const negated = inner ? `NOT (${inner})` : '';
      const violated = `EXISTS (SELECT 1 FROM ${childTable} AS ${childAlias} WHERE ${correlation}${negated ? ` AND ${negated}` : ' AND 1=0'})`;
      parts.push(`NOT ${violated}`);
    }
  } else {
    if (value.is !== undefined) {
      const inner = buildInnerWhere(relation.modelName, value.is === null ? {} : value.is, params, dialect, prefix, ctx, childAlias);
      parts.push(buildExists(inner));
    }
    if (value.isNot !== undefined) {
      const inner = buildInnerWhere(relation.modelName, value.isNot === null ? {} : value.isNot, params, dialect, prefix, ctx, childAlias);
      parts.push(`NOT ${buildExists(inner)}`);
    }
  }

  return parts.length > 0 ? parts.join(' AND ') : null;
}

function buildInnerWhere(
  relModel: string,
  where: any,
  params: Record<string, any>,
  dialect: Dialect,
  prefix: string,
  ctx?: WhereContext,
  childAlias?: string,
): string {
  const subCtx: WhereContext = {
    relationMap: ctx?.relationMap,
    modelToTable: ctx?.modelToTable,
    selfRef: childAlias || quoteTable(resolveTable(relModel, ctx), dialect),
    colPrefix: childAlias ? `${childAlias}.` : '',
  };
  return parseWhere(relModel, where, params, dialect, `${prefix}rel_inner_`, subCtx);
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