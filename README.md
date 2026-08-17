# @an5/adapters

Standalone runtime database adapter and query engine for AN5 ORM. Provides connection pooling, SQL dialect query building (`parseWhere`, `buildOrderBy`, `quote`), dynamic model proxy access, eager loading (`include`), nested writes, vector search, transactions, and typed table clients across TypeScript, Python, .NET (C#), Golang, and Google Sheets.

## Features

- **Dynamic Model Access** — Access models directly via `db.user.findMany()`, `db.order.create()`, or `db.table('User')`
- **Relations & Eager Loading** — Query nested relations with `include`, relation-level `select`, `where`, `orderBy`, pagination, and `_count`
- **Nested Writes** — Create and update records with nested relation writes (`create`, `update`, `disconnect`)
- **Query Builder & Dialects** — Dialect-aware SQL formatting for MSSQL, PostgreSQL, MySQL, and SQLite
- **Aggregations & GroupBy** — Standard ORM aggregates (`_count`, `_sum`, `_avg`, `_min`, `_max`) and `groupBy`
- **Field Math Operators** — Atomic updates with `increment`, `decrement`, `multiply`, `divide`, `set`
- **Vector Search** — Similarity search using pgvector (PostgreSQL), `VECTOR_DISTANCE` (MSSQL), or in-memory cosine/euclidean/dot similarity
- **Real Transactions** — Interactive and callback transactions (`$transaction(async tx => ...)` and `$begin()/$commit()/$rollback()`)
- **Cross-Language** — Unified API in TypeScript, Python, .NET (C#), and Golang
- **Google Sheets Database** — Use spreadsheets as a live database with full CRUD and SQL syntax support

---

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

```bash
# Included in the npm package under golang/ or via go module
```

---

## Usage

### TypeScript

```typescript
import { createAn5Adapter } from '@an5/adapters';

const db = createAn5Adapter({
  connectionString: process.env.DATABASE_URL!,
});

// Dynamic model access
const users = await db.user.findMany({
  where: { active: true },
  include: {
    orders: {
      where: { status: 'paid' },
      orderBy: { total: 'desc' },
      take: 5,
    },
    _count: true,
  },
  take: 10,
});

// Nested writes
const created = await db.user.create({
  data: {
    email: 'alpha@example.com',
    name: 'Alpha',
    orders: {
      create: [
        { total: 100, status: 'open' },
        { total: 250, status: 'paid' },
      ],
    },
  },
  include: { orders: true, _count: true },
});

// Atomic updates
await db.user.update({
  where: { id: created.id },
  data: {
    score: { increment: 10 },
  },
});

// Aggregations
const stats = await db.order.aggregate({
  _count: true,
  _sum: { total: true },
  _avg: { total: true },
});
console.log(stats._count._all, stats._sum.total, stats._avg.total);

// Transactions
await db.$transaction(async (tx) => {
  await tx.user.update({
    where: { id: created.id },
    data: { score: { increment: 5 } },
  });
  await tx.order.create({
    data: { userId: created.id, total: 50, status: 'paid' },
  });
});

// Raw query
const rawRows = await db.$queryRawUnsafe('SELECT * FROM users WHERE active = @p_0', 1);

// Disconnect
await db.$disconnect();
```

### Python

```python
from an5_adapter import create_an5_adapter

db = create_an5_adapter("sqlserver://localhost:1433;database=mydb;user=sa;password=pass")

# Dynamic model access
users = db.user.find_many(where={"active": True}, take=10)

# Nested create
created = db.user.create({
    "data": {
        "email": "alpha@example.com",
        "name": "Alpha",
    }
})

# Transactions
def perform_transfer(tx):
    tx.user.update({"where": {"id": "u1"}, "data": {"score": {"increment": 10}}})

db.transaction(perform_transfer)
```

---

## API Reference

### `An5Adapter`

| Method / Property | Description |
|-------------------|-------------|
| `db[modelName]` | Dynamic proxy returning `AdapterTableClient` for the model |
| `table<T>(name)` | Explicitly returns `AdapterTableClient<T>` |
| `exec(query, params)` | Execute raw parameterized query returning rows |
| `$queryRawUnsafe(sql, ...args)` | Positional raw query |
| `$executeRaw(sql, ...args)` | Raw DML execution returning affected count |
| `$transaction(fn)` | Callback transaction with automatic commit/rollback |
| `$begin()` | Interactive transaction returning `An5AdapterTx` |
| `$connect()` | Open connection / pool |
| `$disconnect()` | Close connections |

### `AdapterTableClient`

| Method | Description |
|--------|-------------|
| `findMany(args)` | Query multiple records with `where`, `orderBy`, `skip`, `take`, `select`, `include` |
| `findFirst(args)` | Query first matching record |
| `findUnique(args)` | Query unique record by unique filter |
| `create(args)` | Insert a record with support for nested relation writes |
| `createMany(args)` | Bulk insert records |
| `update(args)` | Update record with field math operations & nested relation writes |
| `updateMany(args)` | Update multiple records |
| `delete(args)` | Delete a single record |
| `deleteMany(args)` | Delete multiple records |
| `upsert(args)` | Insert or update a record |
| `count(args)` | Count matching records |
| `aggregate(args)` | Compute `_count`, `_sum`, `_avg`, `_min`, `_max` |
| `groupBy(args)` | Group by fields with aggregations and pagination |
| `vectorSearch(args)` | Semantic vector similarity search |

---

## License

MIT
