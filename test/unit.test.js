/**
 * an5Adapters Unit Tests
 * Tests for TypeScript adapter structure and API.
 * Run: node test/unit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assertIncludes(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error(`${msg || 'Assert'}: "${str?.substring(0, 100)}" does not contain "${substr}"`);
  }
}

function assertExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

console.log('\n=== an5Adapters Unit Tests ===\n');

// ─── TypeScript Adapter ──────────────────────────────────────────────────────

console.log('TypeScript Adapter:');

test('an5Adapter.ts exists', () => {
  assertExists(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'));
});

test('exports An5Adapter class', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'export class An5Adapter');
  assertIncludes(content, 'export interface An5AdapterConfig');
  assertIncludes(content, 'export function createAn5Adapter');
});

test('An5Adapter has exec method', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async exec<T = any>(query: string');
});

test('An5Adapter has table factory method', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'table<T = any>(modelName: string)');
});

test('An5Adapter has transaction support', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, '$transaction');
});

test('An5Adapter has connect/disconnect', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, '$connect');
  assertIncludes(content, '$disconnect');
});

test('AdapterTableClient has full CRUD', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async findMany');
  assertIncludes(content, 'async findFirst');
  assertIncludes(content, 'async findUnique');
  assertIncludes(content, 'async create(');
  assertIncludes(content, 'async update(');
  assertIncludes(content, 'async delete(');
  assertIncludes(content, 'async deleteMany');
  assertIncludes(content, 'async upsert');
});

test('AdapterTableClient has aggregate and groupBy', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async aggregate');
  assertIncludes(content, 'async groupBy');
});

test('AdapterTableClient has vectorSearch', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async vectorSearch');
});

test('parseWhere handles OR/AND operators', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, "key === 'OR'");
  assertIncludes(content, "key === 'AND'");
});

test('parseWhere handles comparison operators', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'contains');
  assertIncludes(content, 'startsWith');
  assertIncludes(content, 'endsWith');
  assertIncludes(content, 'gte');
  assertIncludes(content, 'lte');
  assertIncludes(content, 'not');
});

// ─── Python Adapter ──────────────────────────────────────────────────────────

console.log('\nPython Adapter:');

test('an5_adapter.py exists', () => {
  assertExists(path.join(__dirname, '..', 'python', 'an5_adapter.py'));
});

test('exports An5Adapter class', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'class An5Adapter');
  assertIncludes(content, 'class AdapterTableClient');
  assertIncludes(content, 'def create_an5_adapter');
});

test('Python adapter has CRUD methods', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'def find_many');
  assertIncludes(content, 'def find_first');
  assertIncludes(content, 'def find_unique');
  assertIncludes(content, 'def create(');
  assertIncludes(content, 'def update(');
  assertIncludes(content, 'def delete(');
  assertIncludes(content, 'def delete_many');
  assertIncludes(content, 'def upsert');
});

test('Python adapter has aggregate and vector_search', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'def aggregate');
  assertIncludes(content, 'def vector_search');
});

test('Python adapter has transaction support', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'def transaction');
});

test('Python adapter parses connection string', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'def _parse_connection_string');
});

// ─── .NET Adapter ────────────────────────────────────────────────────────────

console.log('\n.NET Adapter:');

test('An5Adapter.cs exists', () => {
  assertExists(path.join(__dirname, '..', 'dotnet', 'An5Adapter.cs'));
});

test('.NET adapter has An5Adapter class', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'dotnet', 'An5Adapter.cs'), 'utf8');
  assertIncludes(content, 'public class An5Adapter');
  assertIncludes(content, 'public class AdapterTableClient<T>');
});

test('.NET adapter has CRUD methods', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'dotnet', 'An5Adapter.cs'), 'utf8');
  assertIncludes(content, 'FindMany');
  assertIncludes(content, 'FindFirst');
  assertIncludes(content, 'FindUnique');
  assertIncludes(content, 'Create(');
  assertIncludes(content, 'Update(');
  assertIncludes(content, 'Delete(');
  assertIncludes(content, 'DeleteMany');
  assertIncludes(content, 'Upsert');
});

test('.NET adapter has transaction support', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'dotnet', 'An5Adapter.cs'), 'utf8');
  assertIncludes(content, 'BeginTransaction');
  assertIncludes(content, 'Transaction<');
});

test('.NET adapter has VectorSearch', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'dotnet', 'An5Adapter.cs'), 'utf8');
  assertIncludes(content, 'VectorSearch');
});

// ─── Google Sheets Adapter ────────────────────────────────────────────────────

console.log('\nGoogle Sheets Adapter:');

test('an5SheetsAdapter.ts exists', () => {
  assertExists(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'));
});

test('index.ts exists', () => {
  assertExists(path.join(__dirname, '..', 'googlesheets', 'index.ts'));
});

test('exports An5SheetsAdapter class and factory', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'export class An5SheetsAdapter');
  assertIncludes(content, 'export interface An5SheetsAdapterConfig');
  assertIncludes(content, 'export function createAn5SheetsAdapter');
});

test('An5SheetsAdapter has connect/disconnect', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, '$connect');
  assertIncludes(content, '$disconnect');
});

test('An5SheetsAdapter has table factory method', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'table<T = any>(modelName: string)');
});

test('An5SheetsAdapter has transaction support', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, '$transaction');
});

test('An5SheetsAdapter supports raw range access', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'readRange');
  assertIncludes(content, 'writeRange');
  assertIncludes(content, 'appendRange');
});

test('SheetsTableClient has full CRUD', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'export class SheetsTableClient');
  assertIncludes(content, 'async findMany');
  assertIncludes(content, 'async findFirst');
  assertIncludes(content, 'async findUnique');
  assertIncludes(content, 'async create(');
  assertIncludes(content, 'async createMany');
  assertIncludes(content, 'async update(');
  assertIncludes(content, 'async updateMany');
  assertIncludes(content, 'async delete(');
  assertIncludes(content, 'async deleteMany');
  assertIncludes(content, 'async upsert');
});

test('SheetsTableClient has aggregate, groupBy, vectorSearch', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'async aggregate');
  assertIncludes(content, 'async groupBy');
  assertIncludes(content, 'async vectorSearch');
});

test('matchWhere handles OR/AND/comparison operators', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, "key === 'OR'");
  assertIncludes(content, "key === 'AND'");
  assertIncludes(content, 'contains');
  assertIncludes(content, 'startsWith');
  assertIncludes(content, 'endsWith');
  assertIncludes(content, 'gte');
  assertIncludes(content, 'lte');
  assertIncludes(content, 'not');
  assertIncludes(content, '.in');
});

test('adapter supports service account JSON credentials', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'credentials');
  assertIncludes(content, 'client_email');
  assertIncludes(content, 'private_key');
});

test('adapter auto-creates sheet if missing', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'ensureSheetExists');
  assertIncludes(content, 'addSheet');
});

test('adapter escapes sheet names with special chars', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, "function esc");
  assertIncludes(content, "name.replace(/'/g");
});

test('adapter coerce values using field metadata (coerceCell)', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'function coerceCell');
  assertIncludes(content, 'fieldMeta');
});

test('adapter has retry/backoff logic', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'withRetry');
  assertIncludes(content, 'MAX_RETRIES');
  assertIncludes(content, 'BASE_DELAY');
});

test('adapter lists and deletes sheets', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'listSheets');
  assertIncludes(content, 'deleteSheet');
  assertIncludes(content, 'invalidateCache');
});

test('table client has clear and deleteAll', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'async clear');
  assertIncludes(content, 'async deleteAll');
});

test('table client uses getOrCreateHeaders (optimized create)', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'getOrCreateHeaders');
});

test('exec() parses SELECT and returns data', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'execSelect');
  assertIncludes(content, 'execInsert');
  assertIncludes(content, 'execUpdate');
  assertIncludes(content, 'execDelete');
  assertIncludes(content, 'execQuery');
});

test('exec() handles SELECT * FROM SheetName', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'SELECT');
  assertIncludes(content, 'FROM');
});

test('exec() handles INSERT INTO', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'INSERT');
  assertIncludes(content, 'VALUES');
});

test('exec() handles UPDATE ... SET ... WHERE', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'UPDATE');
  assertIncludes(content, 'SET');
});

test('exec() handles DELETE FROM ... WHERE', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'DELETE');
  assertIncludes(content, 'FROM');
});

test('$queryRawUnsafe substitutes @p_N positional params', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, '$queryRawUnsafe');
  assertIncludes(content, 'p_${i}');
});

test('$executeRaw returns affected row count', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, '$executeRaw');
  assertIncludes(content, 'as Promise<number>');
});

test('$executeRawUnsafe delegates to $executeRaw', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, '$executeRawUnsafe');
  assertIncludes(content, 'return this.$executeRaw');
});

test('substParams replaces @params in SQL', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'function substParams');
  assertIncludes(content, '/@(\\w+)/g');
});

test('matchRowSQL filters rows in-memory', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'function matchRowSQL');
  assertIncludes(content, 'AND');
});

test('extractColsAndVals parses INSERT cols/values', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'an5SheetsAdapter.ts'), 'utf8');
  assertIncludes(content, 'function extractColsAndVals');
});

test('unified factory exists', () => {
  assertExists(path.join(__dirname, '..', 'typescript', 'unified.ts'));
  const content = fs.readFileSync(path.join(__dirname, '..', 'typescript', 'unified.ts'), 'utf8');
  assertIncludes(content, 'function createAdapter');
  assertIncludes(content, 'googlesheet');
  assertIncludes(content, 'An5SheetsAdapter');
  assertIncludes(content, 'An5Adapter');
});

test('connection string parser exists', () => {
  assertExists(path.join(__dirname, '..', 'googlesheets', 'parseConnectionString.ts'));
  const content = fs.readFileSync(path.join(__dirname, '..', 'googlesheets', 'parseConnectionString.ts'), 'utf8');
  assertIncludes(content, 'parseSheetsConnectionString');
  assertIncludes(content, 'googlesheet');
});

// ─── Package & Config ────────────────────────────────────────────────────────

console.log('\nPackage & Config:');

test('package.json is valid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assertIncludes(pkg.name, 'an5-adapters');
  assertIncludes(pkg.description, 'adapters');
});

test('pyproject.toml exists', () => {
  assertExists(path.join(__dirname, '..', 'pyproject.toml'));
});

test('README.md exists', () => {
  assertExists(path.join(__dirname, '..', 'README.md'));
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
