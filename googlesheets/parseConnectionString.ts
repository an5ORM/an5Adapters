import { An5SheetsAdapterConfig } from './an5SheetsAdapter';

/**
 * Parse a `googlesheets://` connection string into An5SheetsAdapterConfig.
 *
 * Format:
 *   googlesheets://spreadsheetId;clientEmail=xxx;privateKey=xxx
 *   googlesheets://spreadsheetId;clientEmail=xxx;privateKey=xxx;sheetMapping=users:Users,orders:Orders
 *
 * The privateKey must be URL-encoded (use encodeURIComponent on the raw key).
 */
export function parseSheetsConnectionString(url: string): An5SheetsAdapterConfig {
  const clean = url.replace(/^googlesheets:\/\//, '');
  const parts = clean.split(';');

  const spreadsheetId = parts[0].trim();
  const config: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    const value = decodeURIComponent(part.slice(eqIdx + 1).trim());
    config[key] = value;
  }

  const result: An5SheetsAdapterConfig = { spreadsheetId };

  if (config.clientemail) result.clientEmail = config.clientemail;
  if (config.privatekey) result.privateKey = config.privatekey;

  if (config.sheetmapping) {
    const mapping: Record<string, string> = {};
    for (const pair of config.sheetmapping.split(',')) {
      const [k, v] = pair.split(':');
      if (k && v) mapping[k.trim()] = v.trim();
    }
    result.sheetMapping = mapping;
  }

  return result;
}
