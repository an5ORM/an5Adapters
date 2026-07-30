export interface An5SheetsAdapterConfig {
    spreadsheetId: string;
    clientEmail?: string;
    privateKey?: string;
    credentials?: {
        client_email: string;
        private_key: string;
    };
    sheetMapping?: Record<string, string>;
    /** OAuth2 access token for browser-based authentication (e.g. from Firebase Auth Google sign-in).
     * When provided, the adapter uses raw fetch() instead of googleapis JWT, making it compatible
     * with browser environments. Mutually exclusive with clientEmail/privateKey/credentials. */
    accessToken?: string;
}
export declare function normalizeKey(key: string): string;
export declare function resolveConfig(config: An5SheetsAdapterConfig): {
    spreadsheetId: string;
    accessToken: string;
    sheetMapping: Record<string, string> | undefined;
    clientEmail?: undefined;
    privateKey?: undefined;
} | {
    spreadsheetId: string;
    clientEmail: string;
    privateKey: string;
    sheetMapping: Record<string, string> | undefined;
    accessToken?: undefined;
};
