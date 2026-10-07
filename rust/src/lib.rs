//! AN5 adapters runtime for Rust.
//!
//! Provides [`An5Adapter`] (connection + dialect) and [`TableClient`] (ORM CRUD)
//! on top of `sqlx`, plus a `base` module with dialect-aware SQL building blocks.
//! Mirrors the Go / TypeScript / Python adapter packages.
//!
//! ```no_run
//! use an5_adapters::{An5Adapter, FindManyArgs};
//! use serde_json::json;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
//! // Register the drivers this binary needs (swap in `sqlx::postgres::any::DRIVER`
//! // or `sqlx::mysql::any::DRIVER` and enable the matching cargo feature), then
//! // hand the connection string to the adapter.
//! sqlx::any::install_drivers(&[sqlx::sqlite::any::DRIVER])?;
//! let db = An5Adapter::connect("sqlite:file:app.sqlite?mode=rwc").await?;
//!
//! // Dynamic access, the Rust equivalent of `db.user` in TypeScript.
//! let users = db
//!     .table("User")
//!     .find_many(&FindManyArgs {
//!         r#where: Some(json!({ "email": { "contains": "@example.com" } })),
//!         take: 10,
//!         ..Default::default()
//!     })
//!     .await?;
//! # Ok(()) }
//! ```

pub mod adapter;
pub mod base;

pub use adapter::{
    blob_bytes, blob_value, AggregateArgs, An5Adapter, CountArgs, CreateArgs, CreateManyArgs,
    DeleteManyArgs, FindManyArgs, GroupByArgs, Result, RowMap, TableClient, UpdateArgs,
    UpdateManyArgs, UpsertArgs, VectorSearchArgs, ViewClient,
};
pub use base::{
    add_table_override, build_order_by, build_where, cosine_similarity, dot_product,
    euclidean_distance, get_fields_for_model, get_model_to_table, get_relations_for_model,
    resolve_table, set_adapter_metadata, vector_distance, AdapterMetadata, Dialect, RelationDef,
    Where,
};

/// Default connection string: `DATABASE_URL` or a local MSSQL fallback.
pub fn get_default_connection_string() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "Server=localhost;Database=master;Trusted_Connection=True;TrustServerCertificate=True;"
            .to_string()
    })
}

/// Build an adapter using [`get_default_connection_string`].
pub async fn create_an5_adapter(connection_string: Option<&str>) -> Result<An5Adapter> {
    An5Adapter::connect(connection_string.unwrap_or(&get_default_connection_string())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_connection_string_falls_back_to_mssql() {
        // DATABASE_URL may be set in CI; only assert the shape when it is not.
        if std::env::var("DATABASE_URL").is_err() {
            assert!(get_default_connection_string().starts_with("Server=localhost"));
        }
    }

    #[test]
    fn exports_are_reachable() {
        assert_eq!(Dialect::detect("sqlite::memory:"), Dialect::Sqlite);
        assert!(!resolve_table("Whatever").is_empty());
    }
}
