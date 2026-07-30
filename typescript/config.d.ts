export interface LlmConfigData {
    provider: string;
    apiKey: string;
    model?: string;
    endpoint?: string;
}
export interface EmbeddingConfigData {
    provider: string;
    apiKey: string;
    model?: string;
    endpoint?: string;
}
export declare function resetAdapter(): void;
export declare function getLlmConfig(): Promise<LlmConfigData | null>;
export declare function setLlmConfig(data: LlmConfigData): Promise<void>;
export declare function getEmbeddingConfig(): Promise<EmbeddingConfigData | null>;
export declare function setEmbeddingConfig(data: EmbeddingConfigData): Promise<void>;
