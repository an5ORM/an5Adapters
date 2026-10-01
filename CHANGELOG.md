# Changelog

## [0.2.7] - 2026-10-01

### Added
- **SQLite in the Python adapter** — the adapter detected `DIALECT_SQLITE` but
  had no provider, so `_connect()` fell through to MSSQL and every statement
  carried `WITH (NOLOCK)` and `OFFSET ... FETCH NEXT`, which SQLite rejects.
  A stdlib `sqlite3` provider now handles it: no `NOLOCK` hint,
  `LIMIT`/`OFFSET` pagination, `query_proc`/`execute_proc` raising
  `NotImplementedError` instead of emitting invalid `EXEC`, one connection kept
  alive for `:memory:` targets, `file:` URIs, and `WAL` plus
  `PRAGMA foreign_keys`.

### Fixed
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

