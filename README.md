# an5Adapters

Standalone runtime adapters and Query Builder engine for AN5 ORM. Provides connection pooling, SQL dialect query building (`parseWhere`, `buildOrderBy`, `quote`), executor bridges (`executorFromAdapter`), and typed table clients in TypeScript, Python, .NET (C#), Golang, and Google Sheets API.

Adapters are runtime packages only. They do not import generated `an5Client` artifacts; generated clients or applications can pass model metadata explicitly when table-name mapping or field type coercion is needed.

## Features

- **Query Builder & Dialects** — Dialect-aware SQL formatting (`parseWhere`, `buildOrderBy`, `quote`) for MSSQL, PostgreSQL, MySQL, and SQLite
- **Executor Bridge** — `executorFromAdapter()` for seamless driver binding and transaction handling
- **Connection pooling** — Managed connection pools with configurable limits
- **Type-safe table clients** — Generic CRUD operations with type inference
- **Full query support** — WHERE, ORDER BY, pagination, aggregates
- **Vector search** — Cosine, euclidean, and dot product similarity
- **Transactions** — Begin/commit/rollback with automatic cleanup
- **Cross-language** — Same API in TypeScript, Python, .NET (C#), and Golang
- **Google Sheets** — Use spreadsheets as a database with the same CRUD API

## Installation

### TypeScript

```bash
npm install @an5/adapters
```

### Python

```bash
pip install an5-adapters
```

### .NET

```bash
dotnet add package An5Adapters
```

### Go

The Go adapter sources are included in the npm package under `golang/` and can also be copied into Go projects that use the `an5adapters` module layout.

## Usage

### TypeScript

```typescript
import { createAn5Adapter, setAdapterMetadata, parseWhere, buildOrderBy, executorFromAdapter } from '@an5/adapters';

setAdapterMetadata({
  modelToTable: { User: 'dbo.users' },
  modelFields: {
    User: {
      id: { ts: 'string', sql: 'uniqueidentifier', isId: true },
      active: { ts: 'boolean', sql: 'bit' },
    },
  },
});

const db = createAn5Adapter({
  connectionString: 'sqlserver://localhost:1433;database=mydb;user=sa;password=pass',
});

// Table client
const users = db.table<User>('users');
await users.findMany({ where: { active: true }, take: 10 });

// Raw queries
const rows = await db.exec('SELECT * FROM users WHERE id = @id', { id: '123' });

// Transactions
await db.$transaction(async (tx) => {
  await tx.table('users').create({ data: { name: 'John' } });
});

const tx = await db.$begin();
try {
  await tx.table('users').create({ data: { name: 'Jane' } });
  await tx.$commit();
} catch (error) {
  await tx.$rollback();
  throw error;
}
```

### Python

```python
from an5_adapter import create_an5_adapter
from base.metadata import set_adapter_metadata

set_adapter_metadata({
    "modelToTable": {"User": "dbo.users"},
    "modelFields": {
        "User": {
            "id": {"py": "str", "sql": "uniqueidentifier", "isId": True},
            "active": {"py": "bool", "sql": "bit"},
        }
    },
})

db = create_an5_adapter("sqlserver://localhost:1433;database=mydb;user=sa;password=pass")

# Table client
users = db.table("User")
users.find_many(where={"active": True}, take=10)

# Raw queries
rows = db.exec("SELECT * FROM users WHERE id = ?", params=["123"])

# Transactions
db.transaction(lambda tx: tx.table("User").create({"name": "John"}))
```

## API Reference

### An5Adapter / An5SheetsAdapter

| Method | Description |
|--------|-------------|
| `exec(query, params)` | Execute query, return rows (SQL only) |
| `table<T>(name)` | Get typed table client |
| `$transaction(fn)` | Execute in transaction |
| `$connect()` | Open connection / authenticate |
| `$disconnect()` | Close connection / clear auth |

### Query Builder Utilities

| Function | Description |
|----------|-------------|
| `parseWhere(model, where, params, dialect)` | Format WHERE clause across dialects |
| `buildOrderBy(orderBy, dialect)` | Format ORDER BY clause across dialects |
| `quote(name, dialect)` | Quote identifier according to SQL dialect |
| `executorFromAdapter(adapter)` | Wrap adapter into an ExecutorFn |

## License

MITIT
