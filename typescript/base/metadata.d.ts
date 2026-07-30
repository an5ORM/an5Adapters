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
export declare function setAdapterMetadata(metadata: AdapterMetadata): void;
export declare function getModelToTable(): Record<string, string>;
export declare function getFieldsForModel(modelName: string): any;
