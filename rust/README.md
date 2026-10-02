# an5-adapters

Database adapter runtime for [AN5 ORM](https://github.com/an5ORM/an5) in Rust.

`An5Adapter` owns the connection and the dialect; `TableClient` provides the ORM
CRUD surface on top of [`sqlx`](https://github.com/launchbadge/sqlx). Dialects are
detected from the connection string, so SQL Server, PostgreSQL and SQLite are
handled without configuration. This crate mirrors the TypeScript, Python, .NET
and Go adapter packages.

## Install

```toml
[dependencies]
an5-adapters = "0.1"
```

The crate is driver-agnostic: it depends on `sqlx` with `any`, so the application
picks the driver it needs and enables the matching `sqlx` feature.

```toml
[dependencies]
sqlx = { version = "0.8", default-features = false, features = ["any", "runtime-tokio", "postgres"] }
```

## Usage

```rust
use an5_adapters::{An5Adapter, FindManyArgs};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Register the drivers this binary needs, then hand the URL to the adapter.
    sqlx::any::install_drivers(&[sqlx::postgres::any::DRIVER])?;
    let db = An5Adapter::connect("postgres://localhost:5432/mydb").await?;

    // Dynamic access, the Rust equivalent of `db.user` in TypeScript.
    let users = db
        .table("User")
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "email": { "contains": "@example.com" } })),
            take: 10,
            ..Default::default()
        })
        .await?;

    println!("{} users", users.len());
    Ok(())
}
```

Generated Rust clients (`an5-client`) wrap this crate and expose one typed handle
per model — `db.user().find_many(&UserFindManyArgs { .. })` — instead of the
dynamic `db.table("User")` access shown above.

### Features

- `An5Adapter::connect` / `create_an5_adapter`, with the connection string read
  from `DATABASE_URL` when omitted
- Dialect detection and identifier quoting for MSSQL, PostgreSQL and SQLite
- `TableClient`: `find_many`, `find_first`, `find_unique`, `count`, `create`,
  `create_many`, `update`, `update_many`, `delete_many`, `upsert`, `aggregate`,
  `group_by` and `vector_search`
- Transactions, raw SQL execution and view clients
- `base` module with the where/order-by builders, adapter metadata and vector
  distance math

## License

MIT