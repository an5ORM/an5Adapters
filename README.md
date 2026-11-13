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
- **Vector Search** — Similarity search using external vector databases (NBase, Qdrant, Chroma, Pinecone, Weaviate, Milvus), pgvector (PostgreSQL), `VECTOR_DISTANCE` (MSSQL), SQLite, or in-memory cosine/euclidean/dot similarity
- **Real Transactions** — Interactive and callback transactions (`$transaction(async tx => ...)` and `$begin()/$commit()/$rollback()`)
- **Cross-Language** — Unified API in TypeScript, Python, .NET (C#), Golang, Rust, Java, Kotlin, and Swift
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

### Rust

```bash
cargo add an5-adapters
```

The crate is driver-agnostic — it depends on `sqlx` with `any`, so the app enables the driver it needs. See [crates.io](https://crates.io/crates/an5-adapters) and [docs.rs](https://docs.rs/an5-adapters).

### Java

```bash
# Included in the npm package under java/, which ships its own pom.xml
```

`java/` is a Maven module with **no dependencies**: the adapter speaks JDBC through
`java.sql`, so the app picks the driver it already has — `org.xerial:sqlite-jdbc`,
`org.postgresql:postgresql` or `com.microsoft.sqlserver:mssql-jdbc`. That is what lets one
runtime serve all three engines and what keeps it usable on Android, where an adapter that
dragged in three drivers would not fit.

```xml
<dependency>
  <groupId>io.github.an5orm</groupId>
  <artifactId>an5-adapters-java</artifactId>
  <version>0.2.14</version>
</dependency>
```

From a checkout the same module is built and installed into `~/.m2`:

```bash
mvn -f java/pom.xml install
mvn -f java/pom.xml test
```

### Kotlin

```bash
# Included in the npm package under kotlin/, which ships build.gradle.kts
```

Gradle rather than Maven, because Kotlin on Android is built with Gradle and a runtime a
phone app cannot resolve is not a mobile runtime. The Kotlin runtime depends on the Java one
rather than reimplementing it, so the dialect rules and the where builder exist once:

```kotlin
dependencies {
    implementation("io.github.an5orm:an5-adapters-kotlin:0.2.14")
}
```

From a checkout the Kotlin module resolves its Java sibling from `~/.m2` — declared as
`mavenLocal()` in `build.gradle.kts`, so the checkout builds without publishing anything
first:

```bash
mvn -f java/pom.xml install
gradle -p kotlin build
```

Both JVM modules publish to Maven Central, and each release ships both
`io.github.an5orm:an5-adapters-java:<version>` and
`io.github.an5orm:an5-adapters-kotlin:<version>`: a `v*` tag runs the
`publish-maven` job in `.github/workflows/publish.yml` (`mvn -Prelease deploy` and
`gradle publish`), and a manual run is available through the workflow's `publish-maven`
input. It needs the repository secrets `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_TOKEN`
(a Central Portal token), `MAVEN_GPG_PRIVATE_KEY` and `MAVEN_GPG_PASSPHRASE`.

### Swift

```swift
.package(url: "https://github.com/an5ORM/an5Adapters.git", from: "0.2.14")
```

A SwiftPM package that links the **system** SQLite — the database every Apple platform
already ships, so there is no bundled engine and the same file works on device and in the
simulator. Building it needs SQLite's headers (`apt-get install libsqlite3-dev` on Linux).
The runtime takes a `SQLDriver`, so an app that already has a database layer can put GRDB or
SQLite.swift underneath instead.

---

## Vector Database Providers

`@an5/adapters` supports six external vector databases behind a unified `VectorStoreProvider` abstraction (`@an5/adapters/vector`). All providers work in two modes:

1. **Vector-only mode** — pass the provider connection string as `connectionString` to query vectors directly without a relational database.
2. **Sidecar mode** — keep your relational `connectionString` and pass `vectorStore` (or legacy `nbase`). Rows stay in your SQL table, `indexVectors()` syncs embeddings tagged with `an5Id` / `an5Model`, and `vectorSearch()` hydrates full rows from the relational table. If the vector provider is unreachable (`VectorProviderError`), `vectorSearch` logs a warning and falls back to the relational database's native vector support, then to in-memory similarity.

### NBase (`nbase://`)

[NBase](https://github.com/N2FlowJS/nbase) is a partitioned vector database with HNSW, LSH, and KNN indexing behind a REST API.

| Form | Result |
|------|--------|
| `nbase://localhost:1307` | `http://localhost:1307` |
| `nbase:localhost:1307` | `http://localhost:1307` |
| `nbase:http://localhost:1307` | `http://localhost:1307` |
| `nbase:https://vectors.example.com` | `https://vectors.example.com` |
| `nbase://localhost:1307?token=t&timeoutMs=500&method=hnsw` | options applied |

Query options: `token`, `timeoutMs`, `method`, `idField`, `modelField`.

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createNBaseVectorClient } from '@an5/adapters/nbase';

// Vector-only or sidecar (`nbase` alias also supported)
const db = createAn5Adapter({
  connectionString: 'sqlserver://localhost:1433;database=mydb',
  vectorStore: 'nbase://localhost:1307',
});
await db.article.indexVectors({ vectorField: 'embedding' }); // or indexVectorsInNBase(...)
const hits = await db.article.vectorSearch({ vector: queryEmbedding, take: 5 });

// Standalone client
const nbase = createNBaseVectorClient({ url: 'http://localhost:1307' });
await nbase.health();
```

### Qdrant (`qdrant://`)

Uses Qdrant's REST API (`/collections/{collection}/points/...`).

- **Connection strings**: `qdrant://localhost:6333?collection=articles`, `qdrant:https://cloud.qdrant.io:6333?apiKey=...&collection=articles`
- **Query options**: `collection`, `apiKey`, `timeoutMs`

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createQdrantClient } from '@an5/adapters/qdrant';

const db = createAn5Adapter({
  connectionString: 'sqlite:///app.db',
  vectorStore: 'qdrant://localhost:6333?collection=articles&apiKey=secret',
});
await db.article.indexVectors({ vectorField: 'embedding' });
const hits = await db.article.vectorSearch({ vector: queryEmbedding, take: 5 });

// Standalone client
const qdrant = createQdrantClient('qdrant://localhost:6333?collection=articles');
await qdrant.health();
```

### Chroma / ChromaDB (`chroma://`)

Uses Chroma's v2 REST API (`/api/v2/tenants/{tenant}/databases/{database}/collections`).

- **Connection strings**: `chroma://localhost:8000?collection=articles&tenant=default_tenant&database=default_database`, `chroma:https://chroma.example.com?collection=articles&token=...`
- **Query options**: `collection`, `tenant`, `database`, `token`, `timeoutMs`

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createChromaClient } from '@an5/adapters/chroma';

const db = createAn5Adapter({
  connectionString: 'chroma://localhost:8000?collection=articles',
});
await db.$connect();
const hits = await db.article.vectorSearch({ vector: queryEmbedding, take: 5 });

// Standalone client
const chroma = createChromaClient('chroma://localhost:8000?collection=articles');
await chroma.upsert([{ id: 'Article:1', vector: [0.1, 0.2], metadata: { an5Id: '1', an5Model: 'Article' } }]);
```

### Pinecone (`pinecone://`)

Uses Pinecone's index data-plane REST API (`/vectors/upsert`, `/query`, `/vectors/delete`, `/describe_index_stats`).

- **Connection strings**: `pinecone://my-index.svc.region.pinecone.io?apiKey=...&namespace=articles`, `pinecone:https://my-index.svc.region.pinecone.io?apiKey=...`
- **Query options**: `apiKey`, `namespace`, `timeoutMs`

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createPineconeClient } from '@an5/adapters/pinecone';

const db = createAn5Adapter({
  connectionString: 'postgres://user:pass@localhost:5432/mydb',
  vectorStore: 'pinecone://my-index.svc.region.pinecone.io?apiKey=pcsk_...&namespace=articles',
});

// Standalone client
const pinecone = createPineconeClient({
  url: 'https://my-index.svc.region.pinecone.io',
  apiKey: 'pcsk_...',
  namespace: 'articles',
});
const results = await pinecone.search([0.1, 0.2], { k: 5 });
```

### Weaviate (`weaviate://`)

Uses Weaviate's REST & GraphQL API (`/v1/batch/objects`, `/v1/graphql`, `/v1/objects/...`, `/v1/.well-known/ready`).

- **Connection strings**: `weaviate://localhost:8080?className=Article`, `weaviate:https://cluster.weaviate.network?className=Article&apiKey=...&tenant=t1`
- **Query options**: `className` (or `collection`), `apiKey`, `tenant`, `timeoutMs`

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createWeaviateClient } from '@an5/adapters/weaviate';

const db = createAn5Adapter({
  connectionString: 'weaviate://localhost:8080?className=Article',
});

// Standalone client
const weaviate = createWeaviateClient('weaviate://localhost:8080?className=Article');
await weaviate.health();
```

### Milvus / Zilliz (`milvus://`)

Uses Milvus / Zilliz Cloud v2 REST API (`/v2/vectordb/entities/upsert`, `/search`, `/delete`, `/collections/list`).

- **Connection strings**: `milvus://localhost:19530?collection=articles&dbName=default`, `milvus:https://in01-xxx.api.gcp-us-west1.zillizcloud.com?collection=articles&token=...`
- **Query options**: `collection`, `token`, `dbName`, `timeoutMs`

```ts
import { createAn5Adapter } from '@an5/adapters';
import { createMilvusClient } from '@an5/adapters/milvus';

const db = createAn5Adapter({
  connectionString: 'milvus://localhost:19530?collection=articles&token=root:Milvus',
});

// Standalone client
const milvus = createMilvusClient('milvus://localhost:19530?collection=articles');
await milvus.health();
```

### Unified Factory & Multi-language Support

Use `createVectorStore(connectionString)` to auto-detect any of the six providers at runtime:

```ts
import { createVectorStore } from '@an5/adapters/vector';

const store = createVectorStore(process.env.VECTOR_URL!);
await store.health();
```

Zero-dependency REST clients for all six vector providers (`nbase`, `qdrant`, `chroma`, `pinecone`, `weaviate`, `milvus`) are included across every language runtime:

- **TypeScript**: `typescript/src/vector/` (`@an5/adapters/vector`)
- **Python**: `python/base/vector_providers.py` (`create_vector_store`, `vector_store=...`, `index_vectors()`, `vector_health()`)
- **Go**: `golang/vector/vector.go` (`vector.CreateVectorStore`, `NewVectorAn5Adapter`, `SetVectorStore`, `VectorHealth`)
- **Rust**: `rust/src/vector.rs` (`an5_adapters::vector::HttpVectorClient`)
- **Java**: `java/src/main/java/an5/adapters/vector/VectorStoreProvider.java`
- **.NET**: `dotnet/Vector/VectorProviders.cs`
- **Kotlin**: `kotlin/src/main/kotlin/an5/adapters/VectorProviders.kt`
- **Swift**: `swift/Sources/An5Adapters/VectorProviders.swift`

---

## SQLite — vector search without a vector database

For host-language-free distance calculation, build the shared
[AN5 C extension](native/sqlite/README.md) with
`npm run build:sqlite:native` and pass the printed library path as `sqliteVec`.
It runs cosine, Euclidean and dot-product distances natively, with SSE2 on
x86-64 and query-vector caching. The existing fallback remains available when
an extension is not loaded.

SQLite has no vector type, so a `VECTOR(n)` column stores a **BLOB of
little-endian float32** — 4 bytes per dimension. Write a plain array of numbers
and the adapter encodes it; read it back and you get the same array. A column
that already holds JSON text (`'[0.1, 0.2]'`) keeps working, so nothing has to
be migrated.

```ts
await db.article.create({ data: { title: '…', embedding: queryEmbedding } });

const row = await db.article.findFirst({ where: { title: '…' } });
row.embedding; // number[]
```

The search is ranked **inside the database**, trying four strategies in order:

| Order | Strategy | Needs | Reaches |
|-------|----------|-------|---------|
| 1 | `sqlite-vec` | The extension loaded | Scalar distances over ordinary tables |
| 2 | `udf` | A driver that can register a function | `BLOB` and legacy text columns |
| 3 | `sql` | JSON1 (built in since SQLite 3.38) | Legacy text columns |
| 4 | `memory` | Nothing | Any column, whole table loaded |

Strategies 1-3 transfer only the rows that match, which is the reason to prefer
them. A row whose stored vector cannot be scored is left out rather than returned
with a null distance.

[sqlite-vec](https://github.com/asg017/sqlite-vec) supplies native vector distance
functions for exact search. The adapter scans an ordinary table with those
functions; it does not create or synchronize a `vec0` virtual table:

```ts
const db = createAn5Adapter({
  connectionString: 'sqlite:///app.db',
  sqliteVec: require('sqlite-vec').getLoadablePath(),
});
```

`vectorStrategy` pins one strategy instead of probing — `'auto'` (the default),
`'sqlite-vec'`, `'udf'`, `'sql'` or `'memory'`. In TypeScript it can also be
supplied per query on `vectorSearch`. Every other runtime implements
the same four strategies with the same order; `sqlx` (Rust) and JDBC (Java,
Kotlin) use `sql` for JSON text and `memory` for BLOB columns without
driver-specific vector functions.

```python
from an5_adapter import create_an5_adapter
db = create_an5_adapter("sqlite:///app.db", sqlite_vec="vec0", vector_strategy="auto")
```


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
| `vectorStore()` | Return the configured `VectorStoreProvider` instance (if any) |
| `$vectorHealth()` | Probe health of the configured external vector store |

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
| `indexVectors(args)` | Index table embeddings into the configured `vectorStore` (`indexVectorsInNBase` alias also supported) |
| `vectorSearch(args)` | Semantic vector similarity search; uses `vectorStore` (NBase, Qdrant, Chroma, Pinecone, Weaviate, Milvus) when configured, SQLite in-DB ranking, native SQL vector distance, or in-memory fallback |

Generated TypeScript field metadata marks schema primary keys with `isId: true`.
SQL and Google Sheets `create` use this marker to identify custom primary-key
names before falling back to `id` or `...Id` for older metadata. Regenerate the
client to enable this behavior for existing custom-key schemas.

`createMany` uses a bulk statement when every row supplies the same columns.
Rows with different column sets or missing generated UUID keys are inserted
individually so omitted columns retain their defaults and UUID keys are assigned. Bulk failures are propagated without retrying
individual rows. Wrap mixed-column inserts in `$transaction` when they must
succeed or roll back together.

For SQL adapters, `skipDuplicates: true` skips only unique or primary-key
violations. Connection failures and other constraint errors are propagated.
Google Sheets does not enforce unique constraints; this flag does not deduplicate
sheet rows, and failed batch appends are propagated without individual retries.

For SQL adapters, `findMany` and `groupBy` accept `skip` without `take` to
return all remaining rows or groups. Supply `orderBy` for stable row pagination;
`groupBy` orders by its grouping fields when pagination has no explicit ordering.
With relation metadata configured, `groupBy.where` supports the same relation
filters as `findMany.where`, including `some`, `none`, `every`, `is`, and `isNot`.

---

## License

MIT

### Google Sheets desktop OAuth

Google Sheets connections accept `accessToken`, `refreshToken`, `oauthClientId`, optional `oauthClientSecret`, and `tokenExpiresAt` (Unix milliseconds). The VS Code connection UI can generate and store this URI after browser sign-in and spreadsheet selection. Values in the semicolon-delimited URI must be URL encoded. Keep offline credentials in secure storage; do not commit them.

The adapter refreshes expired access tokens before requests, shares concurrent refresh requests, and retries authentication failures once after refreshing. Revoked credentials report a reconnect error. Existing service account, API key and access-token-only configurations remain supported.

For web applications, use a Google Web OAuth client and per-user access tokens. The browser adapter rejects offline desktop credentials and service account private keys. A browser connection manager must handle account selection, token reacquisition and SQLite persistence; see the [browser connection design](https://an5orm.github.io/docs/guides/browser-connections/).
