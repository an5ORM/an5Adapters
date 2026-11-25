import type { Dialect } from './types';
import {
  modelHasField,
  modelHasFields,
  resolveModelEntry,
  resolveModelRelation,
  resolveRelationKeys,
  type RelationDef,
} from './metadata';

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

/** Allocate parameters without overwriting values from sibling clauses. */
export function bindParam(params: Record<string, any>, name: string, value: any): string {
  let candidate = name;
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(params, candidate)) candidate = `${name}_${suffix++}`;
  params[candidate] = value;
  return candidate;
}

function normalizeSortDirection(dir: unknown): 'ASC' | 'DESC' {
  return typeof dir === 'string' && dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

// ─── Where clause builder ──────────────────────────────────────────────────────────

const OPERATOR_KEYS = ['equals', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'not', 'gte', 'lte', 'gt', 'lt', 'mode'];
const OPERATOR_KEY_SET = new Set(OPERATOR_KEYS);
const RELATION_OPERATOR_KEYS = new Set(['some', 'none', 'every', 'is', 'isNot', 'is_not']);

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof RegExp) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isOperatorValue(value: any): boolean {
  if (!isPlainObject(value)) return false;
  return OPERATOR_KEYS.some(op => op in value);
}

function isRelationOperatorObject(value: any): boolean {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some(k => RELATION_OPERATOR_KEYS.has(k));
}

export interface WhereContext {
  /** Relations of the current model keyed by relation name. */
  relationMap?: Record<string, Record<string, RelationDef>>;
  /** model name → table name for resolving related tables. */
  modelToTable?: Record<string, string>;
  /** model name → field metadata for validating scalar fields and relation keys. */
  modelFields?: Record<string, Record<string, any>>;
  /** Fully-qualified reference to the current (self) table, e.g. `[users]` or `[dbo].[users]`. */
  selfRef?: string;
  /** Column prefix to disambiguate inside a correlated subquery (e.g. `__r.`). Includes trailing dot. */
  colPrefix?: string;
}

function resolveTable(modelName: string, ctx?: WhereContext): string {
  return resolveModelEntry(ctx?.modelToTable, modelName) || modelName;
}

function formatPatternCondition(
  col: string,
  paramRef: string,
  dialect: Dialect,
  insensitive: boolean,
): string {
  if (!insensitive) return `${col} LIKE @${paramRef}`;
  if (dialect === 'postgres') return `${col} ILIKE @${paramRef}`;
  return `LOWER(${col}) LIKE LOWER(@${paramRef})`;
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
  if (where === null || where === undefined) return '';
  if (!isPlainObject(where)) {
    throw new Error('Where clause must be a plain object');
  }
  const conditions: string[] = [];

  const relMap = ctx?.relationMap || {};
  const modelFields = ctx?.modelFields || {};
  const hasModelFields = Boolean(modelName) && modelHasFields(modelName, modelFields);

  const cleanWhere: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key !== 'OR' &&
      key !== 'AND' &&
      key !== 'NOT' &&
      key.includes('_') &&
      !resolveModelRelation(modelName, key, relMap) &&
      !(hasModelFields && modelHasField(modelName, key, modelFields)) &&
      isPlainObject(value) &&
      !isOperatorValue(value) &&
      !isRelationOperatorObject(value)
    ) {
      const subKeys = Object.keys(value).filter(sk => value[sk] !== undefined);
      const canFlatten = subKeys.length > 0 && (
        hasModelFields
          ? subKeys.every(sk => modelHasField(modelName, sk, modelFields))
          : subKeys.every(sk => key.includes(sk))
      );
      if (canFlatten) {
        Object.assign(cleanWhere, value);
        continue;
      }
    }
    cleanWhere[key] = value;
  }

  const colPrefix = ctx?.colPrefix || '';

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (value === undefined) continue;
    if (key === 'OR') {
      if (!Array.isArray(value)) {
        throw new Error('OR filter must be an array of filter objects');
      }
      const sub = value.map((v, i) => {
        if (!isPlainObject(v)) {
          throw new Error('OR filter entries must be plain objects');
        }
        return parseWhere(modelName, v, params, dialect, `${prefix}or_${i}_`, ctx) || '1=1';
      });
      conditions.push(sub.length > 0 ? `(${sub.join(' OR ')})` : '1=0');
    } else if (key === 'AND') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => {
        if (!isPlainObject(v)) {
          throw new Error('AND filter must be a plain object or an array of plain objects');
        }
        return parseWhere(modelName, v, params, dialect, `${prefix}and_${i}_`, ctx);
      }).filter(Boolean);
      if (sub.length > 0) conditions.push(`(${sub.join(' AND ')})`);
    } else if (key === 'NOT') {
      const items = Array.isArray(value) ? value : [value];
      const sub = items.map((v, i) => {
        if (!isPlainObject(v)) {
          throw new Error('NOT filter must be a plain object or an array of plain objects');
        }
        return parseWhere(modelName, v, params, dialect, `${prefix}not_${i}_`, ctx) || '1=1';
      });
      if (sub.length > 0) conditions.push(`NOT (${sub.join(' OR ')})`);
    } else {
      const relMatch = resolveModelRelation(modelName, key, relMap);
      if (relMatch) {
        const clause = buildRelationClause(relMatch.relation, key, value, modelName, params, dialect, `${prefix}${key}_`, ctx);
        if (clause) conditions.push(clause);
      } else {
        if (hasModelFields && !modelHasField(modelName, key, modelFields)) {
          throw new Error(`Unknown field '${key}' on model '${modelName}'`);
        }
        if (Array.isArray(value)) {
          throw new Error(`Invalid array filter value for field '${key}'; use { in: [...] } instead`);
        }

        const pname = sanitizeParamName(`${prefix}${key}`);
        const col = `${colPrefix}${quote(key, dialect)}`;

        if (value === null) {
          conditions.push(`${col} IS NULL`);
        } else if (isPlainObject(value)) {
          const v = value as Record<string, any>;
          for (const op of Object.keys(v)) {
            if (v[op] === undefined) continue;
            if (RELATION_OPERATOR_KEYS.has(op)) {
              throw new Error(`Relation filter operator '${op}' cannot be used on scalar field '${key}'`);
            }
            if (!OPERATOR_KEY_SET.has(op)) {
              throw new Error(`Unknown filter operator '${op}' on field '${key}'`);
            }
          }
          if (v.mode !== undefined && v.mode !== 'default' && v.mode !== 'insensitive') {
            throw new Error(`Invalid filter mode '${String(v.mode)}' on field '${key}'; expected 'default' or 'insensitive'`);
          }
          const insensitive = v.mode === 'insensitive';

          if (v.not !== undefined) {
            if (v.not === null) {
              conditions.push(`${col} IS NOT NULL`);
            } else if (Array.isArray(v.not)) {
              throw new Error(`Filter operator 'not' on field '${key}' cannot be an array; use 'notIn' instead`);
            } else if (isPlainObject(v.not)) {
              const nestedSql = parseWhere(modelName, { [key]: v.not }, params, dialect, `${prefix}${key}_not_`, ctx);
              if (nestedSql) conditions.push(`NOT (${nestedSql})`);
            } else {
              const p = bindParam(params, `${pname}_not`, v.not);
              if (insensitive && typeof v.not === 'string') {
                conditions.push(`LOWER(${col}) <> LOWER(@${p})`);
              } else {
                conditions.push(`${col} <> @${p}`);
              }
            }
          }
          if (v.equals !== undefined) {
            if (v.equals === null) {
              conditions.push(`${col} IS NULL`);
            } else if (Array.isArray(v.equals) || isPlainObject(v.equals)) {
              throw new Error(`Filter operator 'equals' on field '${key}' must be a scalar value or null`);
            } else {
              const p = bindParam(params, `${pname}_eq`, v.equals);
              if (insensitive && typeof v.equals === 'string') {
                conditions.push(`LOWER(${col}) = LOWER(@${p})`);
              } else {
                conditions.push(`${col} = @${p}`);
              }
            }
          }
          if (v.contains !== undefined) {
            if (typeof v.contains !== 'string') {
              throw new Error(`Filter operator 'contains' on field '${key}' must be a string`);
            }
            const p = bindParam(params, `${pname}_co`, `%${v.contains}%`);
            conditions.push(formatPatternCondition(col, p, dialect, insensitive));
          }
          if (v.startsWith !== undefined) {
            if (typeof v.startsWith !== 'string') {
              throw new Error(`Filter operator 'startsWith' on field '${key}' must be a string`);
            }
            const p = bindParam(params, `${pname}_sw`, `${v.startsWith}%`);
            conditions.push(formatPatternCondition(col, p, dialect, insensitive));
          }
          if (v.endsWith !== undefined) {
            if (typeof v.endsWith !== 'string') {
              throw new Error(`Filter operator 'endsWith' on field '${key}' must be a string`);
            }
            const p = bindParam(params, `${pname}_ew`, `%${v.endsWith}`);
            conditions.push(formatPatternCondition(col, p, dialect, insensitive));
          }
          for (const [op, sqlOp, suffix] of [
            ['gte', '>=', 'gte'],
            ['lte', '<=', 'lte'],
            ['gt', '>', 'gt'],
            ['lt', '<', 'lt'],
          ] as const) {
            if (v[op] !== undefined) {
              if (v[op] === null || Array.isArray(v[op]) || isPlainObject(v[op])) {
                throw new Error(`Filter operator '${op}' on field '${key}' must be a scalar comparison value`);
              }
              const p = bindParam(params, `${pname}_${suffix}`, v[op]);
              conditions.push(`${col} ${sqlOp} @${p}`);
            }
          }
          if (v.in !== undefined) {
            if (!Array.isArray(v.in)) {
              throw new Error(`Filter operator 'in' on field '${key}' must be an array`);
            }
            if (v.in.length > 0) {
              const lower = insensitive && v.in.some((x: any) => typeof x === 'string');
              const ps = v.in.map((x: any, i: number) => {
                const p = bindParam(params, `${pname}_in${i}`, x);
                return lower && typeof x === 'string' ? `LOWER(@${p})` : `@${p}`;
              });
              conditions.push(`${lower ? `LOWER(${col})` : col} IN (${ps.join(', ')})`);
            } else {
              conditions.push('1=0');
            }
          }
          if (v.notIn !== undefined) {
            if (!Array.isArray(v.notIn)) {
              throw new Error(`Filter operator 'notIn' on field '${key}' must be an array`);
            }
            if (v.notIn.length > 0) {
              const lower = insensitive && v.notIn.some((x: any) => typeof x === 'string');
              const ps = v.notIn.map((x: any, i: number) => {
                const p = bindParam(params, `${pname}_notin${i}`, x);
                return lower && typeof x === 'string' ? `LOWER(@${p})` : `@${p}`;
              });
              conditions.push(`${lower ? `LOWER(${col})` : col} NOT IN (${ps.join(', ')})`);
            } else {
              conditions.push('1=1');
            }
          }
        } else if (typeof value === 'function' || typeof value === 'symbol' || value instanceof RegExp) {
          throw new Error(`Invalid filter value for field '${key}'`);
        } else {
          const p = bindParam(params, pname, value);
          conditions.push(`${col} = @${p}`);
        }
      }
    }
  }
  return conditions.join(' AND ');
}

function buildRelationClause(
  relation: RelationDef,
  relKey: string,
  value: any,
  modelName: string,
  params: Record<string, any>,
  dialect: Dialect,
  prefix: string,
  ctx?: WhereContext,
): string | null {
  if (!isPlainObject(value)) {
    throw new Error(`Relation filter for '${relKey}' on '${modelName}' must be a plain object`);
  }

  const isMany = relation.relationType === 'many';
  const normalized: Record<string, any> = {};
  for (const [rawOp, opVal] of Object.entries(value)) {
    if (opVal === undefined) continue;
    const canonical = rawOp === 'is_not' ? 'isNot' : rawOp;
    const allowed = isMany
      ? canonical === 'some' || canonical === 'none' || canonical === 'every'
      : canonical === 'is' || canonical === 'isNot';
    if (!allowed) {
      const kind = isMany ? 'to-many' : 'to-one';
      throw new Error(`Unsupported relation filter operator '${rawOp}' for ${kind} relation '${relKey}' on '${modelName}'`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, canonical)) {
      throw new Error(`Duplicate relation filter operator '${rawOp}' for relation '${relKey}' on '${modelName}'`);
    }
    normalized[canonical] = opVal;
  }

  const opEntries = Object.entries(normalized);
  if (opEntries.length === 0) return null;

  const childTable = quoteTable(resolveTable(relation.modelName, ctx), dialect);
  const { childKey, parentKey } = resolveRelationKeys(modelName, relation, ctx?.modelFields || {}, false);
  const childCol = quote(childKey, dialect);
  const parentCol = quote(parentKey, dialect);
  const selfRef = (ctx?.selfRef || quoteTable(resolveTable(modelName, ctx), dialect)) + `.`;

  const makeAlias = (op: string): string => `__r_${sanitizeParamName(`${prefix}${op}_${relation.modelName}`)}`;

  const buildExists = (childAlias: string, correlation: string, innerWhere: string): string => {
    const inner = innerWhere ? ` AND (${innerWhere})` : '';
    return `EXISTS (SELECT 1 FROM ${childTable} AS ${childAlias} WHERE ${correlation}${inner})`;
  };

  const parts: string[] = [];

  if (isMany) {
    for (const op of ['some', 'none', 'every'] as const) {
      if (!Object.prototype.hasOwnProperty.call(normalized, op)) continue;
      const opVal = normalized[op];
      if (!isPlainObject(opVal)) {
        throw new Error(`Relation filter '${op}' on '${relKey}' must be a plain object`);
      }
      const childAlias = makeAlias(op);
      const correlation = `${childAlias}.${childCol} = ${selfRef}${parentCol}`;
      const inner = buildInnerWhere(relation.modelName, opVal, params, dialect, `${prefix}${op}_`, ctx, childAlias);
      if (op === 'some') {
        parts.push(buildExists(childAlias, correlation, inner));
      } else if (op === 'none') {
        parts.push(`NOT ${buildExists(childAlias, correlation, inner)}`);
      } else {
        const negated = inner ? `NOT (${inner})` : '';
        const violated = `EXISTS (SELECT 1 FROM ${childTable} AS ${childAlias} WHERE ${correlation}${negated ? ` AND ${negated}` : ' AND 1=0'})`;
        parts.push(`NOT ${violated}`);
      }
    }
  } else {
    for (const op of ['is', 'isNot'] as const) {
      if (!Object.prototype.hasOwnProperty.call(normalized, op)) continue;
      const opVal = normalized[op];
      const childAlias = makeAlias(op);
      const correlation = `${childAlias}.${childCol} = ${selfRef}${parentCol}`;
      if (opVal === null) {
        parts.push(op === 'is' ? `NOT ${buildExists(childAlias, correlation, '')}` : buildExists(childAlias, correlation, ''));
      } else if (!isPlainObject(opVal)) {
        throw new Error(`Relation filter '${op}' on '${relKey}' must be a plain object or null`);
      } else {
        const inner = buildInnerWhere(relation.modelName, opVal, params, dialect, `${prefix}${op}_`, ctx, childAlias);
        parts.push(op === 'is' ? buildExists(childAlias, correlation, inner) : `NOT ${buildExists(childAlias, correlation, inner)}`);
      }
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
    ...(ctx?.relationMap !== undefined ? { relationMap: ctx.relationMap } : {}),
    ...(ctx?.modelToTable !== undefined ? { modelToTable: ctx.modelToTable } : {}),
    ...(ctx?.modelFields !== undefined ? { modelFields: ctx.modelFields } : {}),
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