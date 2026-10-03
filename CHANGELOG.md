# Changelog

## [0.2.10] - 2026-10-03

- Align query composition across TypeScript, Python, .NET, Go and Rust.

## [Unreleased]

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

