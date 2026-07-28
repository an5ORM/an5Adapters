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
}

let modelToTable: Record<string, string> = {};
let modelFields: Record<string, any> = {};

export function setAdapterMetadata(metadata: AdapterMetadata): void {
  modelToTable = { ...(metadata.modelToTable || {}) };
  modelFields = { ...(metadata.modelFields || {}) };
}

export function getModelToTable(): Record<string, string> {
  return modelToTable;
}

export function getFieldsForModel(modelName: string): any {
  return modelFields[modelName] || {};
}
