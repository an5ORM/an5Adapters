export interface RelationDef {
  modelName: string;
  relationType: "many" | "one";
  foreignKey: string;
  localKey: string;
}

export interface ModelFieldMeta {
  name?: string;
  ts?: string;
  sql?: string;
  isId?: boolean;
  [key: string]: any;
}

/** Prefer schema primary-key metadata; retain name inference for legacy clients. */
export function resolveIdField(fields: Record<string, any>): string | undefined {
  const primaryKey = Object.keys(fields).find(name => fields[name]?.isId === true);
  if (primaryKey) return primaryKey;
  if (Object.prototype.hasOwnProperty.call(fields, 'id')) return 'id';
  return Object.keys(fields).find(name => name.endsWith('_id') || name.endsWith('Id') || name.toLowerCase() === 'id');
}

export interface AdapterMetadata {
  modelToTable?: Record<string, string>;
  modelFields?: Record<string, any>;
  relationMap?: Record<string, Record<string, RelationDef>>;
}

let modelToTable: Record<string, string> = {};
let modelFields: Record<string, any> = {};
let relationMap: Record<string, Record<string, RelationDef>> = {};
let autoLoaded = false;

function loadMetadataFromConfig(): any {
  // Auto-loading scans the filesystem at runtime, so it only applies in Node.
  // Lazy requires keep Node builtins out of browser builds.
  if (typeof process === 'undefined' || !process.cwd) return null;
  const path = require('path');
  const fs = require('fs');
  const rootDir = process.cwd();
  const configNames = ['an5Orm.config.js', 'an5Orm.config.cjs', 'an5Orm.config.json'];
  const candidatesDirs = [rootDir, path.resolve(rootDir, '..'), path.resolve(rootDir, '../..')];

  for (const dir of candidatesDirs) {
    for (const name of configNames) {
      const configPath = path.join(dir, name);
      if (fs.existsSync(configPath)) {
        try {
          const config = name.endsWith('.json')
            ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
            : require(configPath);
          const metaFile = config?.outputs?.typescript?.metadataFile;
          if (metaFile) {
            const resolvedPath = path.isAbsolute(metaFile) ? metaFile : path.resolve(dir, metaFile);
            const withoutExt = resolvedPath.replace(/\.(ts|js|cjs|mjs)$/, '');
            const extensions = ['', '.js', '.ts', '.cjs'];
            for (const ext of extensions) {
              const checkPath = withoutExt + ext;
              if (fs.existsSync(checkPath)) {
                try {
                  const m = require(withoutExt);
                  if (m && (m.modelToTable || m.relationMap || m.modelFields)) {
                    return m;
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }
    }
  }
  return null;
}

function tryAutoLoadMetadata(): void {
  if (autoLoaded || Object.keys(modelToTable).length > 0) return;
  autoLoaded = true;

  const configMeta = loadMetadataFromConfig();
  if (configMeta && (configMeta.modelToTable || configMeta.relationMap || configMeta.modelFields)) {
    modelToTable = { ...(configMeta.modelToTable || {}) };
    modelFields = { ...(configMeta.modelFields || {}) };
    relationMap = { ...(configMeta.relationMap || {}) };
  }
}

export function setAdapterMetadata(metadata: AdapterMetadata): void {
  modelToTable = { ...(metadata.modelToTable || {}) };
  modelFields = { ...(metadata.modelFields || {}) };
  relationMap = { ...(metadata.relationMap || {}) };
}

export function toSnakeCase(name: string): string {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function resolveModelEntry<T>(
  map: Record<string, T> | undefined,
  modelName: string
): T | undefined {
  if (!map || !modelName) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, modelName)) return map[modelName];
  const camel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  if (Object.prototype.hasOwnProperty.call(map, camel)) return map[camel];
  const lower = modelName.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower];
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function getModelToTable(): Record<string, string> {
  tryAutoLoadMetadata();
  return modelToTable;
}

export function getModelFieldsMap(): Record<string, Record<string, any>> {
  tryAutoLoadMetadata();
  return modelFields;
}

export function getFieldsForModel(modelName: string): any {
  tryAutoLoadMetadata();
  return resolveModelEntry(modelFields, modelName) || {};
}

export function getRelationMap(): Record<string, Record<string, RelationDef>> {
  tryAutoLoadMetadata();
  return relationMap;
}

export function getRelationsForModel(modelName: string): Record<string, RelationDef> {
  tryAutoLoadMetadata();
  return resolveModelEntry(relationMap, modelName) || {};
}

export function modelHasFields(
  modelName: string,
  fieldsMap?: Record<string, Record<string, any>>
): boolean {
  const resolvedMap = fieldsMap === undefined ? getModelFieldsMap() : fieldsMap;
  const fields = resolveModelEntry(resolvedMap, modelName);
  return Boolean(fields && typeof fields === 'object' && Object.keys(fields).length > 0);
}

export function modelHasField(
  modelName: string,
  fieldName: string,
  fieldsMap?: Record<string, Record<string, any>>
): boolean {
  if (!fieldName) return false;
  const resolvedMap = fieldsMap === undefined ? getModelFieldsMap() : fieldsMap;
  const fields = resolveModelEntry(resolvedMap, modelName);
  if (!fields || typeof fields !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(fields, fieldName)) return true;
  const lowerTarget = fieldName.toLowerCase();
  const snakeTarget = toSnakeCase(fieldName);
  for (const key of Object.keys(fields)) {
    if (key.toLowerCase() === lowerTarget || toSnakeCase(key) === snakeTarget) {
      return true;
    }
  }
  return false;
}

export function resolveModelRelation(
  modelName: string,
  relKey: string,
  relMap?: Record<string, Record<string, RelationDef>>
): { name: string; relation: RelationDef } | undefined {
  if (!modelName || !relKey) return undefined;
  const resolvedMap = relMap === undefined ? getRelationMap() : relMap;
  const relations = resolveModelEntry(resolvedMap, modelName);
  if (!relations || typeof relations !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(relations, relKey)) {
    return { name: relKey, relation: relations[relKey]! };
  }
  const lowerTarget = relKey.toLowerCase();
  for (const [key, relation] of Object.entries(relations)) {
    if (key.toLowerCase() === lowerTarget) {
      return { name: key, relation };
    }
  }
  return undefined;
}

/**
 * Resolve correlated `(childKey, parentKey)` join columns for a relation.
 * Generated metadata stores FK on whichever side declares `@relation(fields: [...])`,
 * which is the parent table for FK-holding to-one relations and the child table
 * for to-many or inverse one-to-one relations.
 */
export function resolveRelationKeys(
  parentModel: string,
  relation: RelationDef,
  fieldsMap?: Record<string, Record<string, any>>,
  defaultOneFkOnParent = false
): { childKey: string; parentKey: string } {
  const fk = relation.foreignKey || 'id';
  const lk = relation.localKey || 'id';
  if (relation.relationType === 'many') {
    return { childKey: fk, parentKey: lk };
  }
  const resolvedFields = fieldsMap === undefined ? getModelFieldsMap() : fieldsMap;
  const parentHasFields = modelHasFields(parentModel, resolvedFields);
  const childHasFields = modelHasFields(relation.modelName, resolvedFields);
  if (parentHasFields || childHasFields) {
    const parentHasFk = parentHasFields && modelHasField(parentModel, fk, resolvedFields);
    const childHasFk = childHasFields && modelHasField(relation.modelName, fk, resolvedFields);
    const parentHasLk = parentHasFields && modelHasField(parentModel, lk, resolvedFields);
    const childHasLk = childHasFields && modelHasField(relation.modelName, lk, resolvedFields);
    if ((parentHasFk && !childHasFk) || (childHasLk && !parentHasLk)) {
      return { childKey: lk, parentKey: fk };
    }
    if ((childHasFk && !parentHasFk) || (parentHasLk && !childHasLk)) {
      return { childKey: fk, parentKey: lk };
    }
  }
  return defaultOneFkOnParent
    ? { childKey: lk, parentKey: fk }
    : { childKey: fk, parentKey: lk };
}

// ─── Dynamic model proxy ─────────────────────────────────────────────────────
// Shared by An5Adapter and An5SheetsAdapter: `db.user` / `db.User` /
// `db.users` resolve case-insensitively through the registered metadata and
// delegate to `table(modelName)`. Real members (`$`-prefixed helpers and
// methods) always win over model names.
export function createAdapterProxy<T extends object>(
  targetObj: T,
  tableGetter: (modelName: string) => any
): T {
  return new Proxy(targetObj, {
    get(target: any, prop: string | symbol, receiver) {
      if (typeof prop === 'string') {
        if (prop in target || prop.startsWith('_') || prop.startsWith('$') || typeof target[prop] === 'function') {
          const val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
        let modelName = prop;
        const modelToTable = getModelToTable();
        if (!modelToTable[prop]) {
          const lowerProp = prop.toLowerCase();
          for (const [mName, tName] of Object.entries(modelToTable)) {
            const lowerM = mName.toLowerCase();
            const lowerT = (tName as string).toLowerCase();
            if (
              lowerM === lowerProp ||
              lowerT === lowerProp ||
              lowerM + 's' === lowerProp ||
              lowerM + 'es' === lowerProp ||
              lowerT + 's' === lowerProp ||
              lowerT + 'es' === lowerProp
            ) {
              modelName = mName;
              break;
            }
          }
        }
        return tableGetter(modelName);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
