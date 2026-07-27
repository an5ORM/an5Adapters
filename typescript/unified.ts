import { An5Adapter, An5AdapterConfig } from './an5Adapter';
import { An5SheetsAdapter, An5SheetsAdapterConfig } from '../googlesheets/an5SheetsAdapter';
import { parseSheetsConnectionString } from '../googlesheets/parseConnectionString';

export type AnyAdapter = An5Adapter | An5SheetsAdapter;
export type AnyAdapterConfig = An5AdapterConfig | An5SheetsAdapterConfig | { connectionString: string };

function isSheetsConfig(config: AnyAdapterConfig): config is An5SheetsAdapterConfig {
  return (config as any).spreadsheetId !== undefined;
}

function hasConnectionString(config: AnyAdapterConfig): config is { connectionString: string } {
  return (config as any).connectionString !== undefined;
}

export function createAdapter(config: AnyAdapterConfig): AnyAdapter {
  if (isSheetsConfig(config)) {
    return new An5SheetsAdapter(config);
  }

  if (hasConnectionString(config)) {
    if (config.connectionString.startsWith('googlesheets://')) {
      const sheetsConfig = parseSheetsConnectionString(config.connectionString);
      return new An5SheetsAdapter(sheetsConfig);
    }
    return new An5Adapter(config);
  }

  return new An5Adapter(config as An5AdapterConfig);
}
