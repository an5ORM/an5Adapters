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

export function getModelToTable(): Record<string, string> {
  tryAutoLoadMetadata();
  return modelToTable;
}

export function getFieldsForModel(modelName: string): any {
  tryAutoLoadMetadata();
  return modelFields[modelName] || {};
}

export function getRelationMap(): Record<string, Record<string, RelationDef>> {
  tryAutoLoadMetadata();
  return relationMap;
}

export function getRelationsForModel(modelName: string): Record<string, RelationDef> {
  tryAutoLoadMetadata();
  return relationMap[modelName] || {};
}
