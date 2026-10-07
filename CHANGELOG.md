# Changelog

## [Unreleased]

### Added
- Ship a portable C SQLite extension under `native/sqlite` for cosine, Euclidean
  and negative-dot-product distances over float32 BLOBs or legacy JSON text.
  It uses SSE2 on x86-64, double-precision accumulation and SQLite auxdata to cache
  the query vector. Build it with `build:sqlite:native`; the existing extension-path
  option loads it. TypeScript, Python, .NET and Swift preserve its native functions
  instead of replacing them with host-language callbacks. Add real-extension
  correctness tests, optional UBSan checks and a public-adapter benchmark.
- **Vector search on SQLite** in every runtime — TypeScript, Python, .NET, Go, Rust, Java,
  Kotlin and Swift. A `VECTOR(n)` column is stored as a BLOB of little-endian float32 and
  ranked inside the database rather than in the client, trying four strategies in a fixed
  order: the sqlite-vec extension, the runtime's own `an5_vec_cosine` / `an5_vec_l2` /
  `an5_vec_ip` functions, `json_each` in plain SQL, and the in-memory fallback. Only the
  matching rows are transferred, and a row that cannot be scored is dropped rather than
  returned with a null distance.
- `sqliteVec` (a sqlite-vec extension path) and `vectorStrategy`
  (`sqlite-vec` | `udf` | `sql` | `memory`) on the adapter config, spelled `sqlite_vec` /
  `vector_strategy` in Python, `SqliteVec` / `VectorStrategy` in .NET, `VectorSupport` in Go,
  `vector_strategy` in Rust, `SQLiteDriver.sqliteVecPath` / `An5Adapter.vectorStrategy` in
  Swift and `An5.vectorStrategy(…)` in Kotlin. Nothing is required: a plain SQLite connection
  ranks in-database through whichever of the first three it can reach.
- The vector codec is public per runtime, so a project that manages its own SQL can reuse it:
  `encodeVector` / `decodeVector` (TypeScript), `encode_vector` / `decode_vector` (Python and
  Rust), `SqliteVectors.EncodeVector` / `DecodeVector` (.NET), `EncodeVector` / `DecodeVector`
  (Go), `SqliteVectors.encodeVector` / `decodeVector` (Java, and Kotlin over the same JVM
  runtime) and `SqliteVectors.encode` / `decode` (Swift).

### Changed
- A `number[]` written to a `VECTOR(n)` column is encoded to the float32 BLOB, which is about
  a third of the JSON text it replaces, and read back as numbers. A column that already holds
  JSON text is still decoded, so an existing database needs no migration.
- `vectorSearch` on a row that cannot be scored leaves it out of the result. It was previously
  returned with a null distance on some providers.

### Fixed
- Swift vector search no longer breaks the build. The registered distance callback called an
  instance method, which Swift rejects because a C function pointer cannot capture `Self`; it
  also read the metric from the callback context instead of the user-data pointer, and read
  arguments through a `sqlite3_value` type the importer does not provide. `update` and
  `updateMany` also skipped vector encoding, so a `VECTOR(n)` column stored Swift array
  syntax instead of float32 bytes. The Swift gate now runs on Linux CI instead of skipping,
  and asserts a loaded native extension is not replaced by the Swift callbacks.
- `test:gradle` looks for the Java runtime under the coordinates that are actually published,
  `io.github.an5orm:an5-adapters-java`, and checks the version the manifest asks for. The
  gate still probed the rejected `org.an5orm` group, so it reinstalled the artifact on every
  run and never skipped when it was already there.
- An `update`/`updateMany` whose value is a `Buffer` or `Uint8Array` no longer reads it as a
  Prisma-style `{ set: … }` operator. `TypedArray.prototype.set` is the copy method, so the
  value became an unbound parameter and SQLite rejected the statement.

## [0.2.12] - 2026-10-07

### Changed
- Publish the Java and Kotlin adapters to Maven Central as `io.github.an5orm:an5-adapters-java` and `io.github.an5orm:an5-adapters-kotlin`.
  The first deployment used `org.an5orm`, which the Portal rejects unless the `an5orm.org`
  domain is proven; `io.github.an5orm` is granted from the GitHub identity that owns the
  repository. Both runtimes are live as `0.2.11` under the new coordinates — Java first,
  Kotlin beside it — so `0.2.12` is the next pair to ship, carrying the credentials fix
  below.

### Fixed
- Write the `central` server entry with `${env.…}` rather than letting `setup-java` copy the
  variable name into `settings.xml`. The publishing plugin sends the server username as a
  `userId` query parameter, so the Portal received `userId=MAVEN_CENTRAL_USERNAME`, read the
  deployment as belonging to an unknown organization and refused it with `Bundle has content
  that does NOT have a .pom file` — a complaint about the bundle while the bundle was fine.

## [0.2.11] - 2026-10-04

### Added
- Add the Java (JDBC), Kotlin and Swift runtimes: a dependency-free Java adapter, a Kotlin front door over it, and a Swift package that links the system SQLite. All three execute the shared query-semantics contract.
- Support desktop Google Sheets OAuth credentials with automatic refresh, shared concurrent refresh requests and one retry after an expired access token.
- Use explicit schema primary-key metadata when creating SQL or Google Sheets records, with legacy name inference retained.
- Run the Java runtime's SQLite smoke and the shared query-semantics fixture from `test:java`.
  Both were written for the Java adapter and no script invoked them, so the Java SQL builder
  was compile-checked but never executed against a database.
### Fixed
- Keep filter and update parameters distinct when column names normalize to the same parameter name.
- Generate valid skip-only pagination for SQLite and MySQL, including grouped queries; apply relation context in grouped filters.
- Handle mixed createMany column sets and generated IDs without replaying failed bulk inserts. skipDuplicates suppresses only unique/primary-key violations; Google Sheets append failures propagate.
- Reject desktop refresh tokens, client secrets and service-account credentials in browser connections; browser apps must provide a user access token.

## [0.2.10] - 2026-10-03

### Fixed
- **`better-sqlite3` was required but never declared** — the SQLite engine
  `require`s it, yet it appeared in no dependency list, so it was present only by
  accident of a workspace root. A consumer without it got a runtime error instead
  of an install instruction, and it is now a declared optional peer dependency and
  a dev dependency, matching how `mysql2` is handled.
- **A missing SQLite driver failed the whole release pipeline.** The publish jobs
  depend on the test job, so the relations contract failing on a runner without the
  driver skipped PyPI, npm and the GitHub Release without failing where anyone was
  looking: `v0.2.10` was tagged and never published. The contract now skips with
  the reason when the driver is absent.



- Align query composition across TypeScript, Python, .NET, Go and Rust.

## [Unreleased]

### Added
- Publish the Java and Kotlin adapters to Maven Central: a `publish-maven` job on `v*` tags
  (and through the workflow's dispatch input) builds both manifests first, then uploads the
  Java module with `-Prelease` — sources, javadoc, detached signatures, `central-publishing` —
  and the Kotlin module with `maven-publish` and in-memory signing. A tag that does not match
  the module versions fails before anything is uploaded.
- Build a checkout with Gradle: `build.gradle.kts` now declares `mavenLocal()`, so the Java
  sibling resolves from `~/.m2` after `mvn -f java/pom.xml install` instead of being looked
  up on a repository that does not have it yet.
- Run the Kotlin manifest through Gradle in CI (`test:gradle`), because `useJUnitPlatform()`
  without an engine and a broken repository block compile fine under `kotlinc` and fail on a
  Gradle consumer's machine.
- Extend the version sync test to `java/pom.xml` and `kotlin/build.gradle.kts`, which are
  maintained by hand and now publish: a stale one would ask Central for a version that
  already exists.

### Fixed
- **Query composition behaved differently from what it said, identically in all five
  runtimes.** `OR: []` silently dropped the clause and returned every row; it now matches
  no rows. An empty branch inside an `OR` was dropped; it is a true disjunct and now
  matches every row. `NOT` over an array was built as `NOT (a AND b)`, matching only rows
  that fail *every* condition; it now excludes each branch, `NOT (a OR b)`. `NOT: {}` now
  matches no rows. A filter value of `undefined` is skipped instead of corrupting the
  clause. `AND` accepts a bare object, not only an array.

  **This changes results.** Queries relying on `OR: []` returning every row, or on the old
  `NOT`-over-an-array behaviour, will return different rows.
- **Relation filters overwrote each other's bound parameters** — every quantifier
  (`some`, `none`, `every`, `is`, `isNot`) now gets its own parameter prefix, so two
  relations pointing at the same model no longer clobber each other's values.
- **`is: null` and `isNot: null` were inverted for to-one relations** — `is: null` now
  means *no related row* (`NOT EXISTS`) and `isNot: null` means *a related row exists*
  (`EXISTS`).
- **A relation whose name contains an underscore was treated as a compound key** — the
  key was destructured into the parent clause. TypeScript now checks the relation map
  first, and the Google Sheets matcher uses the full operator list instead of a partial
  one, which also preserves falsy operands such as `{ total_score: { equals: 0 } }`.
- **Google Sheets string operators skipped empty cells** — `contains`, `startsWith` and
  `endsWith` no longer match a `null`/empty cell, `''` matches an empty cell, and nested
  `not`, bare-object `AND` and `notIn` are supported.
- **Rust and Python kept the SQL Server `dbo.` prefix under SQLite** — both strip it now.
  Rust additionally parses dots inside quoted identifiers instead of splitting on every
  dot, so `[dot.name]` survives.
- **`sqlite:` and `:memory:` connection strings were not detected as SQLite** in
  TypeScript; both are recognised now.

### Added
- **A shared query-semantics contract.** One 12-case fixture
  (`test/fixtures/query-semantics.json`) is now executed by the TypeScript SQL builder,
  the Google Sheets matcher, Python, Go, Rust and .NET — the first cross-language parity
  contract for query semantics rather than five separate interpretations.
- Real SQLite runtime tests for Python, Go, Rust and .NET. `test:python` ran
  `compileall` only and now executes the query-semantics and smoke suites; the Rust gate
  runs `cargo test` instead of `cargo check`; `golang/base/where_test.go` runs the shared
  fixture through `BuildWhere`, executing the SQL with Python's stdlib SQLite to stay
  driver-neutral. It therefore requires `python3` on `PATH`.
- `test/query-relations.integration.test.js` covers `some`+`none` combined, `every`, two
  relations to the same model, a nullable to-one, and transaction rollback — against
  SQLite, and against PostgreSQL, SQL Server and MySQL when their URLs are set.
- A `TEST_METADATA_LOCK` in the Rust unit tests, which mutate process-global metadata and
  were racing.

### Changed
- **`mysql2` is now a declared optional peer dependency.** Consumers of the MySQL engine
  must install it themselves; the engine already failed with a clear error. `googleapis`
  moves to 183.x.
- SQLite connection-string detection is consistent across TypeScript, Go, Rust and Python.

## [0.2.9] - 2026-10-02

### Fixed
- **A `.sqlite3` file was sent to the SQL Server engine** — `@an5/orm` reads the
  database provider from the connection string to validate field types and write DDL,
  and it read the scheme from here. A `.sqlite3` path was not in this list, so the ORM
  produced SQLite DDL that this package then executed against SQL Server. Both accept
  `.sqlite`, `.sqlite3` and `.db` now.
- **A capitalised scheme selected the wrong database** — `MySQL://` fell through every
  check here and became SQL Server, in both packages. A URI scheme is case-insensitive,
  so the comparison now runs on a lower-cased copy of the connection string.

## [0.2.8] - 2026-10-02

### Added
- **SQLite in the Python adapter** — the adapter detected `DIALECT_SQLITE` but
  had no provider, so `_connect()` fell through to MSSQL and every statement
  carried `WITH (NOLOCK)` and `OFFSET ... FETCH NEXT`, which SQLite rejects.
  A stdlib `sqlite3` provider now handles it: no `NOLOCK` hint,
  `LIMIT`/`OFFSET` pagination, `query_proc`/`execute_proc` raising
  `NotImplementedError` instead of emitting invalid `EXEC`, one connection kept
  alive for `:memory:` targets, `file:` URIs, and `WAL` plus
  `PRAGMA foreign_keys`.

### Added
- **SQLite in the .NET adapter** — `SqliteEngine` on `Microsoft.Data.Sqlite`,
  with `sqlite:`/`Data Source=`/bare-path detection, `LIMIT`/`OFFSET` instead of
  `OFFSET`/`FETCH NEXT`, no `WITH (NOLOCK)`, no `SELECT TOP`, double-quoted
  identifiers, `WAL` plus `PRAGMA foreign_keys`. Stored procedures raise
  `NotSupportedException` rather than emitting `EXEC`, and vector search skips
  the native path for the in-memory fallback. Covered by
  `scripts/dotnet-sqlite-smoke.js`.

### Fixed
- **The PyPI version had drifted from the npm version** — `pyproject.toml` sat at
  0.2.6 while `package.json` reached 0.2.7, so the publish step built the old
  wheel and skipped it as already published. Both are at 0.2.7 now, and
  `test/version-sync.test.js` fails the build if they disagree again.

- **`skip` was discarded without `take`** in the .NET adapter's simple
  `FindMany`, on every dialect. `BuildPagination` returned empty unless `take`
  was set, so `skip: 2` alone returned every row.
- **`OFFSET n ROWS` reached Postgres and SQLite** — `ROWS` is MSSQL's
  `OFFSET`/`FETCH` spelling and a syntax error elsewhere.
- **`LIMIT` came after `OFFSET`** in the Postgres branch, which SQLite rejects
  outright even though Postgres tolerates it.
- **.NET transactions ran statements on the wrong connection** — `BeginTransaction`
  opened a connection while every statement opened another, so commit and
  rollback covered nothing. `MssqlEngine` already reused its transaction
  connection; `PostgresEngine` now does the same, and `SqliteEngine` follows.
  On SQLite this surfaced as `database is locked`.
- **Model metadata across naming styles** — the generated client registers table
  clients under the PascalCase name (`CatalogType`) while `MODEL_TO_TABLE` and
  `MODEL_FIELDS` are keyed camelCase, so field lookup found nothing. That
  silently included `isId`, so `create()` generated no primary key and returned
  `id: None`. One resolver (`metadata.resolve_model_key`) is now shared by
  table-name, field and relation lookup.
- **Two pre-existing bugs that hit every dialect** — `transaction()` opened its
  own connection while `exec()`/`execute()` opened another per statement, so
  commit and rollback ran on an idle connection.
- **The wheel now contains `sqlite`** — `[tool.setuptools] packages` lists
  subpackages explicitly, so `python/sqlite/` was present in a checkout and
  absent from the built distribution. Editable installs hid this because the
  path entry exposes the whole `python/` tree.

## [0.2.6] - 2026-08-19

- chore: update build

## [0.2.4] - 2026-07-31

- chore: update docs, build, misc

## [0.2.3] - 2026-07-31

- chore: update misc

## [0.1.1] - 2026-07-27

- some

## [0.1.0] - 2026-07-04

- Initial release
