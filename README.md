# an5Adapters

Standalone runtime adapters for AN5 ORM. Provides connection pooling, query execution, typed table clients in TypeScript, Python, .NET, and Google Sheets API.

Adapters are runtime packages only. They do not import generated `an5Client` artifacts; generated clients or applications can pass model metadata explicitly when table-name mapping or field type coercion is needed.

## Features

- **Connection pooling** — Managed connection pools with configurable limits
- **Type-safe table clients** — Generic CRUD operations with type inference
- **Full query support** — WHERE, ORDER BY, pagination, aggregates
- **Vector search** — Cosine, euclidean, and dot product similarity
- **Transactions** — Begin/commit/rollback with automatic cleanup
- **Cross-language** — Same API in TypeScript, Python, and .NET
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

## Usage

### TypeScript

```typescript
import { createAn5Adapter, setAdapterMetadata } from '@an5/adapters';

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

### .NET

```csharp
using System.Collections.Generic;
using An5Orm;

var db = new An5Adapter("sqlserver://localhost:1433;database=mydb;user=sa;password=pass");

// Table client
var users = db.Table<User>("dbo.users");
var activeUsers = users.FindMany(
    "IsActive = @p",
    new Dictionary<string, object> { ["p"] = true });

// Raw queries
var rows = db.QueryRaw("SELECT * FROM users WHERE Id = @id",
    new Dictionary<string, object> { ["id"] = "123" });

// Create / Update / Delete
users.Create(new User { Name = "John", IsActive = true });
users.Update(existingUser);            // uses the Id property as the key
users.Delete("123");

// Transactions (must return a value; use db.Transaction<int> for void-style)
db.Transaction(tx =>
{
    tx.Table<User>("dbo.users").Create(new User { Name = "John" });
    return 0;
});
```

Note: `QueryRaw`/`FindMany` take parameters as a `Dictionary<string, object>`,
not anonymous objects. See `dotnet/An5Adapter.cs` for the full API.

### Google Sheets

```typescript
import { createAn5SheetsAdapter } from '@an5/adapters/googlesheets';

const db = createAn5SheetsAdapter({
  spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  // Option 1: client email + private key
  clientEmail: 'sa@project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
  // Option 2: full service account JSON
  // credentials: { client_email: '...', private_key: '...' },
  // Optional: map model names to sheet names
  sheetMapping: { users: 'UsersData', orders: 'OrdersData' },
});

// Table client (same API as SQL adapters)
const users = db.table<User>('users');
await users.findMany({ where: { active: true }, take: 10 });
await users.create({ data: { name: 'John', email: 'john@example.com' } });
await users.update({ where: { email: 'john@example.com' }, data: { name: 'Johnny' } });
await users.delete({ where: { email: 'john@example.com' } });

// Raw range access (Google Sheets specific)
const rawData = await db.readRange('Sheet1!A1:C10');
await db.writeRange('Sheet1!A1:B2', [['Name', 'Age'], ['Alice', '30']]);
await db.appendRange('Sheet1!A:A', [['Bob', '25']]);

// Auto-creates sheet + header row on first create()
await db.table('orders').create({ data: { id: '1', total: 100 } });

// List, delete sheets
const sheets = await db.listSheets();
await db.deleteSheet('OldSheet');

// Clear data (keeps headers) or delete all rows
await db.table('users').clear();
await db.table('users').deleteAll();
```

### Browser Mode (Google Sheets)

For browser environments (React, Vue, Svelte, Next.js client components), import from `@an5/adapters/browser` and configure `accessToken` or `apiKey`. In browser mode, the adapter uses native `fetch()` without importing Node.js modules (`googleapis`, `crypto`, `fs`).

```typescript
import { createAn5SheetsAdapter } from '@an5/adapters/browser';

// Option 1: OAuth2 Access Token (e.g. from Firebase Auth or Google Sign-In)
const db = createAn5SheetsAdapter({
  spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  accessToken: userOAuthAccessToken,
});

// Option 2: Google API Key
const db2 = createAn5SheetsAdapter({
  spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  apiKey: 'AIzaSy...',
});
```

### Integrated factory (auto-detect adapter)

```typescript
import { createAn5Adapter, An5Adapter } from '@an5/adapters';

// Auto-detects from connection string
const sqlDb = createAn5Adapter({ connectionString: 'sqlserver://localhost:1433;database=mydb;user=sa;password=pass' });

const sheetsDb = createAn5Adapter({
  connectionString: 'googlesheets://spreadsheetId;clientEmail=sa@project.iam.gserviceaccount.com;privateKey=...',
});

// Or use the Sheets config object directly (also auto-detected)
const sheetsDb2 = createAn5Adapter({
  spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  clientEmail: 'sa@project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
});

// Constructor form also delegates googlesheets:// to the Sheets adapter
const sheetsDb3 = new An5Adapter({
  connectionString: 'googlesheets://spreadsheetId;clientEmail=sa@project.iam.gserviceaccount.com;privateKey=...',
});
```

**Notes:**
- Each model/table maps to a **sheet tab** (first row = headers)
- Sheets without header rows get auto-created on first `create()`
- Type coercion can use optional adapter metadata (`setAdapterMetadata`) for field types and model-to-table mapping
- Numeric strings (without leading zeros) are auto-coerced; `"00123"` stays string
- Boolean strings `"true"` / `"false"` are auto-coerced
- Sheet names with spaces are automatically escaped (A1 notation)
- Supports service account JSON or individual `clientEmail`+`privateKey`
- Automatic retry with exponential backoff for rate limits (429/500/503)

### Provider Imports

Use the package root for normal SQL applications:

```typescript
import { createAn5Adapter, An5Adapter } from '@an5/adapters';
```

The Sheets adapter is exposed through its own subpath:

```typescript
import { createAn5SheetsAdapter, An5SheetsAdapter } from '@an5/adapters/googlesheets';
import { parseSheetsConnectionString } from '@an5/adapters/googlesheets';
```

Browser builds (no Node.js modules) use `@an5/adapters/browser`. The public SQL factory `createAn5Adapter` lives in `typescript/src/an5Adapter.ts` and auto-detects `googlesheets://` connection strings.

## API Reference

### An5Adapter / An5SheetsAdapter

| Method | Description |
|--------|-------------|
| `exec(query, params)` | Execute query, return rows (SQL only) |
| `table<T>(name)` | Get typed table client |
| `$transaction(fn)` | Execute in transaction |
| `$connect()` | Open connection / authenticate |
| `$disconnect()` | Close connection / clear auth |
| `readRange(range)` | Read raw sheet range (Sheets only) |
| `writeRange(range, values)` | Write raw sheet range (Sheets only) |
| `appendRange(range, values)` | Append rows to sheet (Sheets only) |
| `listSheets()` | List all sheet tab names (Sheets only) |
| `deleteSheet(name)` | Delete a sheet tab (Sheets only) |

### AdapterTableClient / SheetsTableClient

| Method | Description |
|--------|-------------|
| `findMany(args)` | Query multiple rows |
| `findFirst(args)` | Query single row |
| `findUnique(where)` | Find by unique key |
| `count(where)` | Count rows |
| `create(data)` | Insert row |
| `createMany(data)` | Bulk insert |
| `update(where, data)` | Update row |
| `updateMany(where, data)` | Update multiple rows |
| `delete(where)` | Delete row |
| `deleteMany(where)` | Delete multiple rows |
| `upsert(where, create, update)` | Insert or update |
| `aggregate(args)` | SUM, AVG, MIN, MAX, COUNT |
| `groupBy(args)` | Group by fields |
| `vectorSearch(args)` | Semantic similarity search |
| `clear()` | Clear all data rows, keep headers (Sheets only) |
| `deleteAll()` | Delete all data rows including headers (Sheets only) |

## Provider Layout

- TypeScript source providers live under `typescript/src/{base,mssql,postgres,mysql,sqlite,googlesheets}`; `npm run build` compiles them into `dist/` (also exposed via `@an5/adapters/base`, `@an5/adapters/mssql`, … subpaths).
- Python providers live under `python/{base,mssql,postgres}`, with `python/an5_adapter.py` kept as the public facade. `npm run build:python` (or `python -m build --outdir dist-py`) builds the package into `dist-py/`.
- .NET providers live under `dotnet/{Base,Mssql,Postgres}`, with `dotnet/an5Adapter.cs` kept as the public facade.
- Adapters do not depend on generated `an5-client` artifacts; generated clients may pass metadata in explicitly when they need model/table mapping.

## Testing

```bash
# TypeScript/Node
node test/unit.test.js

# Python
python -m compileall python
python test/smoke.py
```

## License

MIT
