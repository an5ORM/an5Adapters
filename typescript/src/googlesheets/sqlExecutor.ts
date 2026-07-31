import type { An5SheetsAdapter } from './adapter';
import { esc } from './helpers';
import { withRetry } from './retry';

// ─── SQL query executor ───────────────────────────────────────────────────────

export type ExecResult = any[] | number;

export async function execQuery(adapter: An5SheetsAdapter, query: string, params: Record<string, any> | undefined, _modelMap?: Record<string, string>, _sheetId?: string): Promise<ExecResult> {
  const q = query.trim();
  const upper = q.toUpperCase();

  if (upper.startsWith('SELECT')) return execSelect(adapter, q, params);
  if (upper.startsWith('INSERT')) return execInsert(adapter, q, params);
  if (upper.startsWith('UPDATE')) return execUpdate(adapter, q, params);
  if (upper.startsWith('DELETE')) return execDelete(adapter, q, params);

  // Fallback: treat as raw range or sheet name
  const range = q.includes('!') ? q : esc(q) + '!A:ZZ';
  const raw = await adapter.readRange(range);
  return raw;
}

export function substParams(sql: string, params?: Record<string, any>): { text: string; values: any[] } {
  if (!params) return { text: sql, values: [] };
  const values: any[] = [];
  const text = sql.replace(/@(\w+)/g, (_, name) => {
    if (params[name] !== undefined) {
      const idx = values.length;
      values.push(params[name]);
      return `?${idx}`;
    }
    return `@${name}`;
  });
  return { text, values };
}

export function matchRowSQL(row: Record<string, any>, whereText: string, values: any[]): boolean {
  if (!whereText) return true;
  const trimmed = whereText.trim();

  // Handle simple AND conditions: field = ?0 AND field2 = ?1
  const parts = trimmed.split(/\s+AND\s+/i);
  for (const part of parts) {
    const m = part.match(/^(.+?)\s*(=|!=|<>|>|<|>=|<=|LIKE|CONTAINS)\s*(.+)$/i);
    if (!m) continue;
    const field = m[1].trim().replace(/[[\]]/g, '');
    const op = m[2].toUpperCase();
    const valRef = m[3].trim();

    const val = valRef.startsWith('?') ? values[parseInt(valRef.slice(1))] : valRef.replace(/^['"]|['"]$/g, '');
    const cell = row[field];

    switch (op) {
      case '=': if (cell != val) return false; break;
      case '!=': case '<>': if (cell == val) return false; break;
      case '>': if (!(Number(cell) > Number(val))) return false; break;
      case '<': if (!(Number(cell) < Number(val))) return false; break;
      case '>=': if (!(Number(cell) >= Number(val))) return false; break;
      case '<=': if (!(Number(cell) <= Number(val))) return false; break;
      case 'LIKE': if (!cell || !String(cell).toLowerCase().includes(String(val).toLowerCase().replace(/%/g, ''))) return false; break;
      case 'CONTAINS': if (!cell || !String(cell).includes(String(val))) return false; break;
    }
  }
  return true;
}

export function extractColsAndVals(sql: string, params?: Record<string, any>): { cols: string[]; vals: any[] } {
  const cols: string[] = [];
  const vals: any[] = [];

  const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (colMatch) {
    const rawCols = colMatch[1].split(',').map(c => c.trim().replace(/[[\]]/g, ''));
    // Find actual values
    const valMatch = sql.substring(colMatch.index! + colMatch[0].length).match(/\(([^)]+)\)/);
    if (valMatch) {
      const rawVals = valMatch[1].split(',').map(v => v.trim());
      for (let i = 0; i < rawCols.length; i++) {
        cols.push(rawCols[i]);
        const rv = rawVals[i];
        if (rv.startsWith('@') && params && params[rv.slice(1)] !== undefined) {
          vals.push(params[rv.slice(1)]);
        } else {
          vals.push(rv.replace(/^['"]|['"]$/g, ''));
        }
      }
    }
  }
  return { cols, vals };
}

async function execSelect(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<any[]> {
  const m = query.match(/SELECT\s+(.+?)\s+FROM\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:WHERE\s+(.+))?$/i);
  if (!m) {
    // Try reading as raw range
    const raw = await adapter.readRange(esc(query.replace(/^SELECT\s+\*\s+FROM\s+/i, '').trim()) + '!A:ZZ');
    const headers = raw[0] || [];
    return raw.slice(1).map(r => {
      const obj: any = {};
      headers.forEach((h: any, i: number) => { obj[h] = r[i] ?? null; });
      return obj;
    });
  }

  const sheetName = m[2] || m[3] || m[4];
  const whereClause = m[5];

  const raw = await adapter.readRange(esc(sheetName) + '!A:ZZ');
  if (raw.length < 1) return [];

  const headers = raw[0] as string[];
  const fieldList = m[1].trim();
  const selectAll = fieldList === '*';

  const rows = raw.slice(1).map(row => {
    const obj: any = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
    return obj;
  });

  if (!whereClause) return selectAll ? rows : rows.map(r => pickFields(r, fieldList, headers));
  const { text, values } = substParams(query, params);
  // Extract just the WHERE part
  const whereParts = query.match(/WHERE\s+(.+)$/i);
  const whereText = whereParts ? whereParts[1] : '';
  const { text: whereSubst, values: whereVals } = substParams(whereText, params);

  const result = rows.filter(r => matchRowSQL(r, whereSubst, whereVals));
  return selectAll ? result : result.map(r => pickFields(r, fieldList, headers));
}

function pickFields(row: any, fieldList: string, headers: string[]): any {
  const fields = fieldList.split(',').map(f => f.trim().replace(/[[\]]/g, ''));
  const obj: any = {};
  fields.forEach(f => { obj[f] = row[f]; });
  return obj;
}

async function execInsert(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/INSERT\s+INTO\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(.*)/i);
  if (!m) throw new Error('Invalid INSERT syntax');

  const sheetName = m[1] || m[2] || m[3];
  const { cols, vals } = extractColsAndVals(query, params);
  if (cols.length === 0) throw new Error('Cannot extract columns from INSERT');

  // Ensure headers exist
  const raw = await adapter.readRange(esc(sheetName) + '!A1:ZZ1');
  const existingHeaders = (raw[0] || []) as string[];
  let headers = existingHeaders.length > 0 ? existingHeaders : cols;

  if (existingHeaders.length === 0) {
    // Write headers first
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.values.update({
        spreadsheetId: adapter.config.spreadsheetId,
        range: esc(sheetName) + '!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [cols] },
      })
    );
    headers = cols;
  }

  const rowData: any = {};
  cols.forEach((c, i) => { rowData[c] = vals[i]; });
  for (const h of headers) { if (rowData[h] === undefined) rowData[h] = null; }

  const rowVals = headers.map(h => {
    const v = rowData[h];
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  });

  await adapter.appendRange(esc(sheetName) + '!A:A', [rowVals]);
  return 1;
}

async function execUpdate(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/UPDATE\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
  if (!m) throw new Error('Invalid UPDATE syntax');

  const sheetName = m[1] || m[2] || m[3];
  const setClause = m[4];
  const whereClause = m[5];

  // Parse SET clause
  const setPairs = setClause.split(',').map(p => p.trim());
  const setFields: string[] = [];
  const setVals: any[] = [];
  for (const pair of setPairs) {
    const sm = pair.match(/^(\w+)\s*=\s*(.+)$/i);
    if (!sm) continue;
    setFields.push(sm[1].replace(/[[\]]/g, ''));
    const rv = sm[2].trim();
    if (rv.startsWith('@') && params && params[rv.slice(1)] !== undefined) {
      setVals.push(params[rv.slice(1)]);
    } else {
      setVals.push(rv.replace(/^['"]|['"]$/g, ''));
    }
  }

  // Read data
  const range = esc(sheetName) + '!A:ZZ';
  const raw = await adapter.readRange(range);
  if (raw.length < 1) return 0;

  const headers = raw[0] as string[];
  const rows = raw.slice(1);

  // Determine which rows to update
  const { text: whereSubst, values: whereVals } = substParams(whereClause || '', params);
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = {};
    headers.forEach((h, j) => { row[h] = rows[i][j] ?? null; });
    row.__row = i + 2;

    if (whereClause && !matchRowSQL(row, whereSubst, whereVals)) continue;

    // Apply SET values
    setFields.forEach((f, idx) => { row[f] = setVals[idx]; });
    const updated = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString();
      return String(v);
    });

    await adapter.writeRange(esc(sheetName) + `!A${row.__row}`, [updated]);
    count++;
  }
  return count;
}

async function execDelete(adapter: An5SheetsAdapter, query: string, params?: Record<string, any>): Promise<number> {
  const m = query.match(/DELETE\s+FROM\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:WHERE\s+(.+))?$/i);
  if (!m) throw new Error('Invalid DELETE syntax');

  const sheetName = m[1] || m[2] || m[3];
  const whereClause = m[4];

  const meta = await adapter.getSheetMeta(sheetName);
  if (!meta) return 0;

  if (!whereClause) {
    // Delete all rows (keep headers)
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 999999 },
            },
          }],
        },
      })
    );
    return -1; // unknown count
  }

  // Read and find matching rows
  const raw = await adapter.readRange(esc(sheetName) + '!A:ZZ');
  if (raw.length < 1) return 0;

  const headers = raw[0] as string[];
  const { text: whereSubst, values: whereVals } = substParams(whereClause, params);

  const toDelete: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const row: any = {};
    headers.forEach((h, j) => { row[h] = raw[i][j] ?? null; });
    if (matchRowSQL(row, whereSubst, whereVals)) {
      toDelete.push(i + 1);
    }
  }

  // Delete from bottom to top
  toDelete.sort((a, b) => b - a);
  for (const rowIdx of toDelete) {
    const api = await adapter.getSheets();
    await withRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId: adapter.config.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: rowIdx - 1, endIndex: rowIdx },
            },
          }],
        },
      })
    );
  }
  return toDelete.length;
}
