# @an5/adapters

Standalone runtime database adapter and query engine for AN5 ORM. Provides connection pooling, SQL dialect query building (`parseWhere`, `buildOrderBy`, `quote`), dynamic model proxy access, eager loading (`include`), nested writes, vector search, transactions, and typed table clients across TypeScript, Python, .NET (C#), Golang, and Google Sheets.

## Features

- **Dynamic Model Access** — Access models directly via `db.user.findMany()` or `db.User.create()` (proxy resolves casing/plurals via metadata); `db.table('User')` is the escape hatch for runtime-known model names
- **Typed Model Access** — Bind generated delegates for full type-safety: `createAn5Adapter<{ user: UserTableClient }>({...})`, plus the `TypedAn5Adapter` / `AdapterAPI` helper types
- **Relations & Eager Loading** — Query nested relations with `include`, relation-level `select`, `where`, `orderBy`, pagination, and `_count`
- **Nested Writes** — Create and update records with nested relation writes (`create`, `update`, `disconnect`)
- **Query Builder & Dialects** — Dialect-aware SQL formatting for MSSQL, PostgreSQL, MySQL, and SQLite
- **Aggregations & GroupBy** — Standard ORM aggregates (`_count`, `_sum`, `_avg`, `_min`, `_max`) and `groupBy`
- **Field Math Operators** — Atomic updates with `increment`, `decrement`, `multiply`, `divide`, `set`
- **Vector Search** — Similarity search using NBase, pgvector (PostgreSQL), `VECTOR_DISTANCE` (MSSQL), or in-memory cosine/euclidean/dot similarity
- **Real Transactions** — Interactive and callback transactions (`$transaction(async tx => ...)` and `$begin()/$commit()/$rollback()`)
- **Cross-Language** — Unified API in TypeScript, Python, .NET (C#), Golang, and Rust
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

## NBase — Neural Vector Database

[NBase](https://github.com/N2FlowJS/nbase) is a partitioned vector database with
HNSW, LSH and KNN indexing behind a REST API. an5 can run vector search there
instead of loading every row into memory, which matters once a table holds
millions of embeddings.

The rows stay in your relational table: only the vectors move to NBase, each one
tagged with its row id, and search results are hydrated from the table.

### Configure

NBase is configured through the connection string, like every other backend:

```ts
import { createAn5Adapter } from '@an5/adapters';

const db = createAn5Adapter({ connectionString: 'nbase://localhost:1307' });
await db.$connect(); // probes NBase
```

Accepted forms:

| Form | Result |
|------|--------|
| `nbase://localhost:1307` | `http://localhost:1307` |
| `nbase:localhost:1307` | `http://localhost:1307` |
| `nbase:http://localhost:1307` | `http://localhost:1307` |
| `nbase:https://vectors.example.com` | `https://vectors.example.com` |
| `nbase://localhost:1307?token=t&timeoutMs=500&method=hnsw` | options applied |

`?token`, `?timeoutMs`, `?method`, `?idField` and `?modelField` are read from the
query string, and a path is kept as a base path for deployments behind a
reverse proxy.

This adapter is **vector-only**: it has no relational database, so a search
returns the NBase hits — id, metadata and `distance` — instead of table rows.

### Search

With an `nbase://` connection string, search returns the hits themselves:

```ts
const hits = await db.table('Article').vectorSearch({ vector: queryEmbedding, take: 5 });
// hits[0] = { id: 'Article:42', an5Id: '42', an5Model: 'Article', distance: 0.11 }
```

### Search rows from your own table

To get real rows back, keep your database connection string and point it at the
same NBase instance. NBase is still configured with a connection string, never a
params object:

```ts
const db = createAn5Adapter({
  connectionString: 'sqlserver://localhost:1433;database=mydb',
  nbase: 'nbase://localhost:1307',
});

await db.table('Article').indexVectorsInNBase({ vectorField: 'embedding' });
// → { indexed: 1200 }

const hits = await db.table('Article').vectorSearch({ vector: queryEmbedding, take: 5 });
// hits[0] = { id, title, ..., distance }
```

Vectors are tagged with their row id, so a hit is hydrated from the table by
that id and the result keeps the `{ ...row, distance }` shape the other engines
return.

### Standalone client

```ts
import { createNBaseVectorClient } from '@an5/adapters/nbase';

const nbase = createNBaseVectorClient({ url: 'http://localhost:1307' });
await nbase.health();
await nbase.addVectors([{ id: 'a:1', vector: [0.1, 0.2], metadata: { an5Id: '1' } }]);
const { results } = await nbase.search([0.1, 0.2], { k: 5, distanceMetric: 'cosine' });
```

If NBase is unreachable, `vectorSearch` logs a warning and falls back to the
database's native vector support, then to in-memory similarity, so an outage
degrades performance rather than breaking queries.


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
