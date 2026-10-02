# Changelog

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

