export interface An5SheetsAdapterConfig {
    spreadsheetId: string;
    clientEmail?: string;
    privateKey?: string;
    credentials?: {
        client_email: string;
        private_key: string;
    };
    sheetMapping?: Record<string, string>;
}
export declare function normalizeKey(key: string): string;
export declare function resolveConfig(config: An5SheetsAdapterConfig): {
    spreadsheetId: string;
    clientEmail: string;
    privateKey: string;
    sheetMapping: Record<string, string> | undefined;
};
