// ─── Config ───────────────────────────────────────────────────────────────────

export interface An5SheetsAdapterConfig {
  spreadsheetId: string;
  clientEmail?: string;
  privateKey?: string;
  credentials?: { client_email: string; private_key: string };
  sheetMapping?: Record<string, string>;
  /** OAuth2 access token for browser-based authentication (e.g. from Firebase Auth Google sign-in).
   * When provided, the adapter uses raw fetch() instead of googleapis JWT, making it compatible
   * with browser environments. Mutually exclusive with clientEmail/privateKey/credentials. */
  accessToken?: string;
}

export function normalizeKey(key: string): string {
  if (key.includes('PRIVATE KEY')) return key;
  const lines = key.split('\\n').join('\n');
  if (lines.includes('PRIVATE KEY')) return lines;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

export function resolveConfig(config: An5SheetsAdapterConfig) {
  if (config.accessToken) {
    return {
      spreadsheetId: config.spreadsheetId,
      accessToken: config.accessToken,
      sheetMapping: config.sheetMapping,
    };
  }
  if (config.credentials) {
    return {
      spreadsheetId: config.spreadsheetId,
      clientEmail: config.credentials.client_email,
      privateKey: normalizeKey(config.credentials.private_key),
      sheetMapping: config.sheetMapping,
    };
  }
  return {
    spreadsheetId: config.spreadsheetId,
    clientEmail: config.clientEmail!,
    privateKey: normalizeKey(config.privateKey!),
    sheetMapping: config.sheetMapping,
  };
}
