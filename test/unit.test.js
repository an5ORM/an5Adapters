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

function assertNotIncludes(str, substr, msg) {
  if (str && str.includes(substr)) {
    throw new Error(`${msg || 'Assert'}: content should not contain "${substr}"`);
  }
}

function assertExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

function getTsFile(relativePath) {
  const p1 = path.join(__dirname, '..', 'typescript', 'src', relativePath);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(__dirname, '..', 'typescript', relativePath);
  if (fs.existsSync(p2)) return p2;
  return p1;
}

function readGoogleSheetsSource() {
  const dir = getTsFile('googlesheets');
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

function readSourceTree(dirPath, extension) {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (full.endsWith(extension)) files.push(full);
    }
  }
  walk(dirPath);
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

console.log('\n=== an5Adapters Unit Tests ===\n');

// ─── TypeScript Adapter ──────────────────────────────────────────────────────

console.log('TypeScript Adapter:');

test('an5Adapter.ts exists', () => {
  assertExists(getTsFile('an5Adapter.ts'));
});

test('exports An5Adapter class', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  const typesContent = fs.readFileSync(getTsFile(path.join('base', 'types.ts')), 'utf8');
  assertIncludes(content, 'export class An5Adapter');
  assertIncludes(typesContent, 'export interface An5AdapterConfig');
  assertIncludes(content, 'export function createAn5Adapter');
});

test('An5Adapter has exec method', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async exec<T = any>(query: string');
});

test('An5Adapter has table factory method', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'table<T = any>(modelName: string)');
});

test('An5Adapter has transaction support', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, '$transaction');
  assertIncludes(content, 'async $begin()');
  assertIncludes(content, 'async $commit()');
  assertIncludes(content, 'async $rollback()');
});

test('An5Adapter has connect/disconnect', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, '$connect');
  assertIncludes(content, '$disconnect');
});

test('AdapterTableClient has full CRUD', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
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
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async aggregate');
  assertIncludes(content, 'async groupBy');
});

test('AdapterTableClient has vectorSearch', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'async vectorSearch');
});

test('TypeScript adapter vectorSearch uses dialect-aware SQL', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'VECTOR_DISTANCE');
  assertIncludes(content, 'pgvector');
  assertIncludes(content, 'query_vector');
  assertIncludes(content, 'vectorElementType');
  assertIncludes(content, 'type "vector"');
});

test('parseWhere handles OR/AND operators', () => {
  const content = fs.readFileSync(getTsFile(path.join('base', 'sql.ts')), 'utf8');
  assertIncludes(content, "key === 'OR'");
  assertIncludes(content, "key === 'AND'");
  assertIncludes(content, "key === 'NOT'");
  assertIncludes(content, 'const items = Array.isArray(value) ? value : [value]');
});

test('parseWhere handles comparison operators', () => {
  const content = fs.readFileSync(getTsFile(path.join('base', 'sql.ts')), 'utf8');
  assertIncludes(content, 'OPERATOR_KEYS');
  assertIncludes(content, 'isOperatorValue');
  assertIncludes(content, 'equals');
  assertIncludes(content, 'contains');
  assertIncludes(content, 'startsWith');
  assertIncludes(content, 'endsWith');
  assertIncludes(content, 'gte');
  assertIncludes(content, 'lte');
  assertIncludes(content, 'not');
  assertIncludes(content, 'notIn');
  assertIncludes(content, 'IS NULL');
  assertIncludes(content, 'IS NOT NULL');
  assertIncludes(content, 'NOT (');
});

test('AdapterTableClient update supports field operations', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'function appendUpdateSet');
  assertIncludes(content, 'val.increment !== undefined');
  assertIncludes(content, 'val.decrement !== undefined');
  assertIncludes(content, 'val.multiply !== undefined');
  assertIncludes(content, 'val.divide !== undefined');
  assertIncludes(content, 'val.set !== undefined');
  assertIncludes(content, 'if (sets.length === 0) return { count: 0 }');
});

test('AdapterTableClient aggregate and groupBy skip false aggregate fields', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'function selectedAggregateFields');
  assertIncludes(content, 'for (const f of selectedAggregateFields(args._sum))');
  assertIncludes(content, 'for (const f of selectedAggregateFields(args._avg))');
  assertIncludes(content, "throw new Error('Aggregate requires at least one aggregator field')");
});

test('AdapterTableClient groupBy supports string by and pagination', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'function normalizeByFields');
  assertIncludes(content, 'const byFields = normalizeByFields(args?.by)');
  assertIncludes(content, 'buildOrderBy(args?.orderBy, this.dialect)');
  assertIncludes(content, 'FETCH NEXT');
  assertIncludes(content, 'LIMIT');
});

test('TypeScript adapter supports PostgreSQL dialect', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  const typesContent = fs.readFileSync(getTsFile(path.join('base', 'types.ts')), 'utf8');
  const postgresContent = fs.readFileSync(getTsFile(path.join('postgres', 'engine.ts')), 'utf8');
  const mssqlContent = fs.readFileSync(getTsFile(path.join('mssql', 'engine.ts')), 'utf8');
  assertIncludes(typesContent, "'postgres'");
  assertIncludes(postgresContent, 'class PostgresEngine');
  assertIncludes(mssqlContent, 'class MssqlEngine');
  assertIncludes(content, "cs.startsWith('postgres://')");
  assertIncludes(content, "cs.startsWith('postgresql://')");
  assertIncludes(postgresContent, "require('pg')");
  assertIncludes(postgresContent, '$${idx}');
});

test('TypeScript adapter uses dialect-aware quoting', () => {
  const content = fs.readFileSync(getTsFile(path.join('base', 'sql.ts')), 'utf8');
  const tableContent = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'function quote(name: string, dialect: Dialect)');
  assertIncludes(content, 'dialect === \'postgres\'');
  assertIncludes(content, 'replace(/"/g, \'""\')');
  assertIncludes(content, 'replace(/`/g, \'``\')');
  assertIncludes(content, 'replace(/\\]/g, \']]\')');
  assertIncludes(content, 'function sanitizeParamName');
  assertIncludes(content, 'function normalizeSortDirection');
  assertIncludes(tableContent, 'LIMIT');
  assertIncludes(tableContent, 'OFFSET');
});

test('TypeScript SQL providers are split by provider folder', () => {
  assertExists(getTsFile(path.join('base', 'types.ts')));
  assertExists(getTsFile(path.join('base', 'sql.ts')));
  assertExists(getTsFile(path.join('mssql', 'engine.ts')));
  assertExists(getTsFile(path.join('postgres', 'engine.ts')));
  assertExists(getTsFile(path.join('mysql', 'engine.ts')));
  assertExists(getTsFile(path.join('sqlite', 'engine.ts')));
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, './mssql');
  assertIncludes(content, './postgres');
  assertIncludes(content, './mysql');
  assertIncludes(content, './sqlite');
});

// ─── Config Module (DB-backed config) ─────────────────────────────────────────

console.log('\nConfig Module:');

test('config.ts exists', () => {
  assertExists(getTsFile('config.ts'));
});

test('config.ts exports config functions', () => {
  const content = fs.readFileSync(getTsFile('config.ts'), 'utf8');
  assertIncludes(content, 'getLlmConfig');
  assertIncludes(content, 'setLlmConfig');
  assertIncludes(content, 'getEmbeddingConfig');
  assertIncludes(content, 'setEmbeddingConfig');
  assertIncludes(content, 'resetAdapter');
  assertIncludes(content, 'DATABASE_URL');
});

test('config.ts exports from index.ts barrel', () => {
  const content = fs.readFileSync(getTsFile('index.ts'), 'utf8');
  assertIncludes(content, 'getLlmConfig');
  assertIncludes(content, 'getEmbeddingConfig');
  assertIncludes(content, 'setEmbeddingConfig');
});

const schemaDir = path.join(__dirname, '..', '..', 'an5Schema');
if (fs.existsSync(schemaDir)) {
  test('.an5 schema files exist', () => {
    assertExists(path.join(schemaDir, 'LlmConfig.an5'));
    assertExists(path.join(schemaDir, 'EmbeddingConfig.an5'));
  });

  test('LlmConfig.an5 has proper fields', () => {
    const content = fs.readFileSync(path.join(schemaDir, 'LlmConfig.an5'), 'utf8');
    assertIncludes(content, 'model LlmConfig');
    assertIncludes(content, 'provider');
    assertIncludes(content, 'apiKey');
    assertIncludes(content, 'isActive');
    assertIncludes(content, 'createdAt');
  });

  test('EmbeddingConfig.an5 has proper fields', () => {
    const content = fs.readFileSync(path.join(schemaDir, 'EmbeddingConfig.an5'), 'utf8');
    assertIncludes(content, 'model EmbeddingConfig');
    assertIncludes(content, 'provider');
    assertIncludes(content, 'apiKey');
    assertIncludes(content, 'isActive');
  });
} else {
  console.log(`  (skipping .an5 schema tests: an5Schema directory not found)`);
}

// ─── Python Adapter ──────────────────────────────────────────────────────────

console.log('\nPython Adapter:');

test('an5_adapter.py exists', () => {
  assertExists(path.join(__dirname, '..', 'python', 'an5_adapter.py'));
});

test('exports An5Adapter class', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, 'class An5Adapter');
  assertIncludes(content, 'class AdapterTableClient');
  assertIncludes(content, 'def create_an5_adapter');
});

test('Python adapter has CRUD methods', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
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
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, 'def aggregate');
  assertIncludes(content, 'def group_by');
  assertIncludes(content, 'def vector_search');
});

test('Python adapter supports ORM-style filters and update operations', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, '_OPERATOR_KEYS');
  assertIncludes(content, 'key == "NOT"');
  assertIncludes(content, '"notIn" in value');
  assertIncludes(content, 'value["equals"] is None');
  assertIncludes(content, 'def _append_update_set');
  assertIncludes(content, '"increment" in val');
  assertIncludes(content, '"multiply" in val');
  assertIncludes(content, 'return {"count": 0}');
});

test('Python adapter aggregate/group_by supports truthy fields and pagination', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, 'def _selected_aggregate_fields');
  assertIncludes(content, 'def _normalize_by_fields');
  assertIncludes(content, 'raise ValueError("Aggregate requires at least one aggregator field")');
  assertIncludes(content, 'FETCH NEXT');
  assertIncludes(content, 'LIMIT');
});

test('Python adapter has transaction support', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'python', 'an5_adapter.py'), 'utf8');
  assertIncludes(content, 'def transaction');
});

test('Python adapter parses connection string', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, 'def parse_connection_string');
});

test('Python adapter supports PostgreSQL dialect', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, 'DIALECT_POSTGRES');
  assertIncludes(content, 'psycopg2');
  assertIncludes(content, "_detect_dialect");
  assertIncludes(content, "_quote(");
  assertIncludes(content, "%s");
});

test('Python adapter detects postgres connection string', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'python'), '.py');
  assertIncludes(content, "postgres://");
  assertIncludes(content, "postgresql://");
});

test('Python providers are split by provider folder', () => {
  assertExists(path.join(__dirname, '..', 'python', 'base', 'sql.py'));
  assertExists(path.join(__dirname, '..', 'python', 'mssql', 'provider.py'));
  assertExists(path.join(__dirname, '..', 'python', 'postgres', 'provider.py'));
  assertExists(path.join(__dirname, '..', 'python', 'table_client.py'));
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
  assertIncludes(content, 'VECTOR_DISTANCE');
  assertIncludes(content, 'pgvector');
  assertIncludes(content, 'EuclideanDistance');
  assertIncludes(content, '_adapter.QueryRaw<T>');
  assertNotIncludes(content, 'An5Dialect');
  assertNotIncludes(content, 'TableSql');
  assertNotIncludes(content, 'NoLockSql');
  assertNotIncludes(content, 'SqlQuote(vectorField)');
});

test('.NET adapter supports PostgreSQL dialect', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'dotnet'), '.cs');
  assertIncludes(content, 'enum Dialect');
  assertIncludes(content, 'Postgres');
  assertIncludes(content, 'Mssql');
  assertIncludes(content, 'class PostgresEngine');
  assertIncludes(content, 'class MssqlEngine');
  assertIncludes(content, 'Npgsql');
  assertIncludes(content, "StartsWith(\"postgres://\")");
});

test('.NET adapter has SqlQuote with dialect-aware quoting', () => {
  const content = readSourceTree(path.join(__dirname, '..', 'dotnet'), '.cs');
  assertIncludes(content, 'static class SqlQuote');
  assertIncludes(content, 'QuoteTable');
  assertIncludes(content, 'QuoteName');
  assertIncludes(content, 'StripWrapping');
  assertIncludes(content, 'Replace("\\\"", "\\\"\\\"")');
  assertIncludes(content, 'Replace("]", "]]")');
});

test('.NET providers are split by provider folder', () => {
  assertExists(path.join(__dirname, '..', 'dotnet', 'Base', 'Core.cs'));
  assertExists(path.join(__dirname, '..', 'dotnet', 'Mssql', 'MssqlEngine.cs'));
  assertExists(path.join(__dirname, '..', 'dotnet', 'Postgres', 'PostgresEngine.cs'));
});

test('.NET MSSQL provider uses Microsoft.Data.SqlClient', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'dotnet', 'Mssql', 'MssqlEngine.cs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dotnet-compile-check.js'), 'utf8');
  assertIncludes(content, 'using Microsoft.Data.SqlClient;');
  assertNotIncludes(content, 'System.Data.SqlClient');
  assertIncludes(script, 'Microsoft.Data.SqlClient');
  assertNotIncludes(script, 'System.Data.SqlClient');
});

// ─── Golang Adapter ───────────────────────────────────────────────────────────

console.log('\nGolang Adapter:');

const goDir = path.join(__dirname, '..', 'golang');

function readGoSource() {
  return readSourceTree(goDir, '.go');
}

test('an5_adapter.go exists', () => {
  assertExists(path.join(goDir, 'an5_adapter.go'));
});

test('Go adapter has An5Adapter struct', () => {
  const content = fs.readFileSync(path.join(goDir, 'an5_adapter.go'), 'utf8');
  assertIncludes(content, 'type An5Adapter struct');
  assertIncludes(content, 'func NewAn5Adapter(');
});

test('Go adapter has QueryRaw and ExecuteRaw', () => {
  const content = fs.readFileSync(path.join(goDir, 'an5_adapter.go'), 'utf8');
  assertIncludes(content, 'func (a *An5Adapter) QueryRaw(');
  assertIncludes(content, 'func (a *An5Adapter) ExecuteRaw(');
});

test('Go adapter has Connect and Disconnect', () => {
  const content = fs.readFileSync(path.join(goDir, 'an5_adapter.go'), 'utf8');
  assertIncludes(content, 'func (a *An5Adapter) Connect(');
  assertIncludes(content, 'func (a *An5Adapter) Disconnect(');
});

test('Go adapter has Transaction support', () => {
  const content = fs.readFileSync(path.join(goDir, 'an5_adapter.go'), 'utf8');
  assertIncludes(content, 'func (a *An5Adapter) Transaction(');
});

test('Go adapter has VectorSearch with dialect-aware SQL', () => {
  const content = readGoSource();
  assertIncludes(content, 'func (a *An5Adapter) VectorSearch(');
  assertIncludes(content, 'VectorSearchFallback(');
  assertIncludes(content, 'VECTOR_DISTANCE');
  assertIncludes(content, 'pgvector');
});

test('Go adapter has SetAdapterMetadata', () => {
  const content = readGoSource();
  assertIncludes(content, 'SetAdapterMetadata(');
  assertIncludes(content, 'ModelToTable');
  assertIncludes(content, 'GetModelToTable(');
});

test('Go TableClient has CRUD operations', () => {
  const content = fs.readFileSync(path.join(goDir, 'table_client.go'), 'utf8');
  assertIncludes(content, 'func (t *TableClient) FindMany(');
  assertIncludes(content, 'func (t *TableClient) FindFirst(');
  assertIncludes(content, 'func (t *TableClient) Count(');
  assertIncludes(content, 'func (t *TableClient) Create(');
  assertIncludes(content, 'func (t *TableClient) CreateMany(');
  assertIncludes(content, 'func (t *TableClient) Update(');
  assertIncludes(content, 'func (t *TableClient) UpdateMany(');
  assertIncludes(content, 'func (t *TableClient) Delete(');
  assertIncludes(content, 'func (t *TableClient) DeleteMany(');
  assertIncludes(content, 'func (t *TableClient) VectorSearch(');
});

test('Go TableClient has Aggregate and GroupBy', () => {
  const content = fs.readFileSync(path.join(goDir, 'table_client.go'), 'utf8');
  assertIncludes(content, 'func (t *TableClient) Aggregate(');
  assertIncludes(content, 'func (t *TableClient) GroupBy(');
});

test('Go adapter supports PostgreSQL dialect', () => {
  const content = readGoSource();
  assertIncludes(content, 'DialectPostgres');
  assertIncludes(content, 'DialectMssql');
  assertIncludes(content, 'DetectDialect(');
});

test('Go adapter has dialect-aware quoting', () => {
  const content = readGoSource();
  assertIncludes(content, 'QuoteIdentifier(');
  assertIncludes(content, 'QuoteTable(');
  assertIncludes(content, 'stripWrapping(');
  assertIncludes(content, 'strings.ReplaceAll(raw, `"`, `""`)');
  assertIncludes(content, 'strings.ReplaceAll(raw, "]", "]]")');
});

test('Go providers are split by provider folder', () => {
  assertExists(path.join(goDir, 'base', 'base.go'));
  assertExists(path.join(goDir, 'base', 'metadata.go'));
  assertExists(path.join(goDir, 'mssql', 'mssql.go'));
  assertExists(path.join(goDir, 'postgres', 'postgres.go'));
  assertExists(path.join(goDir, 'table_client.go'));
  assertExists(path.join(goDir, 'go.mod'));
});

test('package exposes Go compile test script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['test:go'], 'cd golang && go test ./...');
});

// ─── Google Sheets Adapter ────────────────────────────────────────────────────

console.log('\nGoogle Sheets Adapter:');

test('an5SheetsAdapter.ts exists', () => {
  assertExists(getTsFile(path.join('googlesheets', 'an5SheetsAdapter.ts')));
});

test('index.ts exists', () => {
  assertExists(getTsFile(path.join('googlesheets', 'index.ts')));
});

test('exports An5SheetsAdapter class and factory', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'export class An5SheetsAdapter');
  assertIncludes(content, 'export interface An5SheetsAdapterConfig');
  assertIncludes(content, 'export function createAn5SheetsAdapter');
});

test('An5SheetsAdapter has connect/disconnect', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, '$connect');
  assertIncludes(content, '$disconnect');
});

test('An5SheetsAdapter has table factory method', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'table<T = any>(modelName: string)');
});

test('An5SheetsAdapter has transaction support', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, '$transaction');
});

test('An5SheetsAdapter supports raw range access', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'readRange');
  assertIncludes(content, 'writeRange');
  assertIncludes(content, 'appendRange');
});

test('SheetsTableClient has full CRUD', () => {
  const content = readGoogleSheetsSource();
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
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'async aggregate');
  assertIncludes(content, 'async groupBy');
  assertIncludes(content, 'async vectorSearch');
});

test('matchWhere handles OR/AND/comparison operators', () => {
  const content = readGoogleSheetsSource();
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
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'credentials');
  assertIncludes(content, 'client_email');
  assertIncludes(content, 'private_key');
});

test('adapter auto-creates sheet if missing', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'ensureSheetExists');
  assertIncludes(content, 'addSheet');
});

test('adapter escapes sheet names with special chars', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, "function esc");
  assertIncludes(content, "name.replace(/'/g");
});

test('adapter coerce values using field metadata (coerceCell)', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'function coerceCell');
  assertIncludes(content, 'fieldMeta');
});

test('adapter has retry/backoff logic', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'withRetry');
  assertIncludes(content, 'MAX_RETRIES');
  assertIncludes(content, 'BASE_DELAY');
});

test('adapter lists and deletes sheets', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'listSheets');
  assertIncludes(content, 'deleteSheet');
  assertIncludes(content, 'invalidateCache');
});

test('table client has clear and deleteAll', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'async clear');
  assertIncludes(content, 'async deleteAll');
});

test('table client uses getOrCreateHeaders (optimized create)', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'getOrCreateHeaders');
});

test('exec() parses SELECT and returns data', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'execSelect');
  assertIncludes(content, 'execInsert');
  assertIncludes(content, 'execUpdate');
  assertIncludes(content, 'execDelete');
  assertIncludes(content, 'execQuery');
});

test('exec() handles SELECT * FROM SheetName', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'SELECT');
  assertIncludes(content, 'FROM');
});

test('exec() handles INSERT INTO', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'INSERT');
  assertIncludes(content, 'VALUES');
});

test('exec() handles UPDATE ... SET ... WHERE', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'UPDATE');
  assertIncludes(content, 'SET');
});

test('exec() handles DELETE FROM ... WHERE', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'DELETE');
  assertIncludes(content, 'FROM');
});

test('$queryRawUnsafe substitutes @p_N positional params', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, '$queryRawUnsafe');
  assertIncludes(content, 'p_${i}');
});

test('$executeRaw returns affected row count', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, '$executeRaw');
  assertIncludes(content, 'as Promise<number>');
});

test('$executeRawUnsafe delegates to $executeRaw', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, '$executeRawUnsafe');
  assertIncludes(content, 'return this.$executeRaw');
});

test('substParams replaces @params in SQL', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'function substParams');
  assertIncludes(content, '/@(\\w+)/g');
});

test('matchRowSQL filters rows in-memory', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'function matchRowSQL');
  assertIncludes(content, 'AND');
});

test('extractColsAndVals parses INSERT cols/values', () => {
  const content = readGoogleSheetsSource();
  assertIncludes(content, 'function extractColsAndVals');
});

test('An5Adapter factory handles Google Sheets directly', () => {
  const content = fs.readFileSync(getTsFile('an5Adapter.ts'), 'utf8');
  assertIncludes(content, 'function createAn5Adapter');
  assertIncludes(content, 'createAdapter');
  assertIncludes(content, 'googlesheet');
  assertIncludes(content, 'An5SheetsAdapter');
  assertIncludes(content, 'An5Adapter');
});

test('package no longer exports unified subpath', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.exports['./unified'], undefined);
});

test('connection string parser handles accessToken and apiKey', () => {
  assertExists(getTsFile(path.join('googlesheets', 'parseConnectionString.ts')));
  const content = fs.readFileSync(getTsFile(path.join('googlesheets', 'parseConnectionString.ts')), 'utf8');
  assertIncludes(content, 'parseSheetsConnectionString');
  assertIncludes(content, 'accessToken');
  assertIncludes(content, 'apiKey');
});

test('browser entry exports Sheets adapter and metadata helpers', () => {
  const content = fs.readFileSync(getTsFile('browser.ts'), 'utf8');
  assertIncludes(content, 'An5SheetsAdapter');
  assertIncludes(content, 'createAn5SheetsAdapter');
  assertIncludes(content, 'setAdapterMetadata');
});

// ─── Package & Config ────────────────────────────────────────────────────────

console.log('\nPackage & Config:');

test('package.json is valid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assertIncludes(pkg.name, '@an5/adapters');
  assertIncludes(pkg.description, 'adapters');
});

test('package manifest includes cross-language adapter sources and gates', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.exports['./python'], './python/an5_adapter.py');
  assert.strictEqual(pkg.exports['./dotnet'], './dotnet/An5Adapter.cs');
  assert.strictEqual(pkg.exports['./golang'], './golang/an5_adapter.go');
  assert.ok(pkg.files.includes('python/**/*.py'), 'python sources must be packaged');
  assert.ok(pkg.files.includes('dotnet/**/*'), 'dotnet sources must be packaged');
  assert.ok(pkg.files.includes('golang/**/*'), 'golang sources must be packaged');
  assert.strictEqual(pkg.scripts['test:python'], 'python -m compileall python 2>&1');
  assert.strictEqual(pkg.scripts['test:dotnet'], 'node scripts/dotnet-compile-check.js');
  assert.strictEqual(pkg.scripts['test:go'], 'cd golang && go test ./...');
  assert.strictEqual(pkg.scripts['test:integration:live'], 'node test/live-db.integration.test.js');
});

test('adapters do not depend on generated an5-client artifacts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies?.['an5-client'], undefined);
  const source = [
    readSourceTree(path.join(__dirname, '..', 'typescript'), '.ts'),
    readSourceTree(path.join(__dirname, '..', 'python'), '.py'),
  ].join('\n');
  if (source.includes('an5-client') || source.includes('an5Client') || source.includes('an5Metadata')) {
    throw new Error('Adapter source must not import generated an5-client artifacts');
  }
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
