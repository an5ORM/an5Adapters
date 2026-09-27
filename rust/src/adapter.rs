//! Runtime database adapter for AN5 (Rust).
//!
//! `An5Adapter` owns the connection pool; `TableClient` provides the ORM CRUD
//! surface. Rows are `serde_json::Value` maps, matching the Go and TypeScript
//! adapters, so the same query code works across languages.

use serde_json::{Map, Value};
use sqlx::any::AnyArguments;
use sqlx::{Any, AnyConnection, AnyPool, Row};
use std::collections::HashMap;

use crate::base::{
    build_order_by, build_where, get_fields_for_model, resolve_table, set_adapter_metadata,
    vector_distance, AdapterMetadata, Dialect, RelationDef, Where,
};

/// A database row as a plain JSON object.
pub type RowMap = Map<String, Value>;

/// Generates an RFC 4122 version 4 UUID from the system entropy source.
///
/// Used to fill string primary keys that the schema marks as `@default(uuid())`
/// so `create` works on engines without a server-side UUID default. Matches the
/// TypeScript adapter's `generateUUID`.
fn generate_uuid() -> String {
    use std::io::Read;

    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut bytes).is_err() {
            // Fall through to the time-seeded fallback below.
            bytes = [0u8; 16];
        }
    } else {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes[..16].copy_from_slice(&nanos.to_le_bytes()[..16]);
    }

    // Version 4, variant 1.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Fills in a string primary key with a generated UUID when the caller omitted
/// it and the schema declares that column as a string.
fn apply_generated_primary_key(model: &str, data: &mut RowMap) {
    let Some(fields) = get_fields_for_model(model) else {
        return;
    };
    let Some(fields) = fields.as_object() else {
        return;
    };

    for (name, def) in fields {
        let is_id = def
            .get("isId")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| name.eq_ignore_ascii_case("id"));
        if !is_id || data.contains_key(name) {
            continue;
        }

        let declared = def
            .get("sql")
            .or_else(|| def.get("ts"))
            .or_else(|| def.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_string = matches!(
            declared.split('(').next().unwrap_or("").trim(),
            "string" | "uuid" | "uniqueidentifier" | "nvarchar" | "varchar" | "text" | "char"
        );
        if is_string {
            data.insert(name.clone(), Value::String(generate_uuid()));
        }
    }
}

/// Result alias for adapter operations.
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

// ─── Args types (ORM-standard structured args) ───────────────────────────────

/// Configures `find_many` / `find_first` / `find_unique`.
#[derive(Debug, Default, Clone)]
pub struct FindManyArgs {
    /// ORM-style where object, e.g. `{"name": {"contains": "Jo"}}`.
    pub r#where: Option<Value>,
    pub order_by: Option<Value>,
    pub skip: i64,
    pub take: i64,
    /// `Vec<String>` of column names, or an object of column -> bool.
    pub select: Option<Value>,
    /// Relation keys to eager-load.
    pub include: Option<Value>,
}

impl FindManyArgs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the where clause from any serializable value.
    pub fn where_value(mut self, value: Value) -> Self {
        self.r#where = Some(value);
        self
    }
}

/// Configures `count`.
#[derive(Debug, Default, Clone)]
pub struct CountArgs {
    pub r#where: Option<Value>,
}

/// Configures `delete_many`.
#[derive(Debug, Default, Clone)]
pub struct DeleteManyArgs {
    pub r#where: Option<Value>,
}

/// Configures `create`.
#[derive(Debug, Default, Clone)]
pub struct CreateArgs {
    pub data: RowMap,
}

/// Configures `create_many`.
#[derive(Debug, Default, Clone)]
pub struct CreateManyArgs {
    pub data: Vec<RowMap>,
}

/// Configures `update`.
#[derive(Debug, Default, Clone)]
pub struct UpdateArgs {
    pub r#where: Option<Value>,
    /// Supports `{ "field": { "set"|"increment"|"decrement"|"multiply"|"divide": v } }`.
    pub data: Value,
}

/// Configures `update_many`.
#[derive(Debug, Default, Clone)]
pub struct UpdateManyArgs {
    pub r#where: Option<Value>,
    pub data: Value,
}

/// Configures `upsert`.
#[derive(Debug, Default, Clone)]
pub struct UpsertArgs {
    pub r#where: Option<Value>,
    pub create: RowMap,
    pub update: Value,
}

/// Configures `aggregate`.
#[derive(Debug, Default, Clone)]
pub struct AggregateArgs {
    pub r#where: Option<Value>,
    pub count: Option<Value>,
    pub sum: Option<Value>,
    pub avg: Option<Value>,
    pub min: Option<Value>,
    pub max: Option<Value>,
}

/// Configures `group_by`.
#[derive(Debug, Default, Clone)]
pub struct GroupByArgs {
    /// Column name or list of column names.
    pub by: Option<Value>,
    pub r#where: Option<Value>,
    pub order_by: Option<Value>,
    pub skip: i64,
    pub take: i64,
    pub sum: Option<Value>,
    pub avg: Option<Value>,
    pub min: Option<Value>,
    pub max: Option<Value>,
}

/// Configures `vector_search`.
#[derive(Debug, Default, Clone)]
pub struct VectorSearchArgs {
    pub vector: Vec<f64>,
    pub take: i64,
    pub r#where: Option<Value>,
    pub vector_field: String,
    /// `cosine` (default), `euclidean` or `dot`.
    pub distance_metric: String,
}

// ─── An5Adapter ─────────────────────────────────────────────────────────────

/// Manages runtime database execution.
#[derive(Clone)]
pub struct An5Adapter {
    pool: AnyPool,
    dialect: Dialect,
    connection_string: String,
}

impl An5Adapter {
    /// Build an adapter from a connection string using the given driver.
    ///
    /// The driver must be registered beforehand (for example
    /// `sqlx::any::install_postgres()`), which lets one binary speak several
    /// dialects while the SQL itself is generated per dialect.
    pub async fn connect(connection_string: &str) -> Result<Self> {
        let pool = AnyPool::connect(connection_string).await?;
        Ok(Self {
            dialect: Dialect::detect(connection_string),
            pool,
            connection_string: connection_string.to_string(),
        })
    }

    /// Build an adapter from an existing pool, detecting the dialect from
    /// `connection_string`.
    pub fn from_pool(pool: AnyPool, connection_string: &str) -> Self {
        Self {
            dialect: Dialect::detect(connection_string),
            pool,
            connection_string: connection_string.to_string(),
        }
    }

    /// Verify the connection is alive.
    pub async fn connect_check(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    /// Close the pool.
    pub async fn disconnect(&self) -> Result<()> {
        self.pool.close().await;
        Ok(())
    }

    /// The detected dialect.
    pub fn dialect(&self) -> Dialect {
        self.dialect
    }

    /// The connection string this adapter was built with.
    pub fn connection_string(&self) -> &str {
        &self.connection_string
    }

    /// Underlying pool, for escape-hatch queries.
    pub fn pool(&self) -> &AnyPool {
        &self.pool
    }

    /// Register the metadata emitted by the generated client.
    pub fn set_metadata(&self, meta: AdapterMetadata) {
        set_adapter_metadata(meta);
    }

    /// Table-scoped CRUD client.
    pub fn table(&self, name: &str) -> TableClient {
        let resolved = resolve_table(name);
        TableClient {
            adapter: self.clone(),
            table_name: name.to_string(),
            physical_table: resolved,
        }
    }

    /// Point a model alias at a different physical table.
    ///
    /// Schema-less engines (SQLite) have no `[dbo]` prefix, so the generated
    /// mapping needs a per-model override.
    pub fn add_table_override(&self, model: &str, table: &str) {
        crate::base::add_table_override(model, table);
    }

    /// Read-only view client.
    pub fn view(&self, name: &str) -> ViewClient {
        ViewClient {
            table: self.table(name),
        }
    }

    /// Execute a SELECT and return rows as JSON maps.
    pub async fn query_raw(&self, sql: &str, args: &[Value]) -> Result<Vec<RowMap>> {
        let mut q = sqlx::query(sql);
        for a in args {
            q = bind_value(q, a);
        }
        let rows = q.fetch_all(&self.pool).await?;
        rows_to_maps(&rows)
    }

    /// Execute a non-SELECT statement and return the affected row count.
    pub async fn execute_raw(&self, sql: &str, args: &[Value]) -> Result<u64> {
        let mut q = sqlx::query(sql);
        for a in args {
            q = bind_value(q, a);
        }
        Ok(q.execute(&self.pool).await?.rows_affected())
    }

    /// Run `f` inside a transaction, committing on success and rolling back on
    /// error.
    ///
    /// The closure receives a pooled connection that is already inside an
    /// explicit transaction, which keeps the signature free of lifetime
    /// gymnastics around `sqlx::Transaction`.
    pub async fn transaction<T, F>(&self, f: F) -> Result<T>
    where
        for<'c> F: FnOnce(
            &'c mut AnyConnection,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'c>>,
    {
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN").execute(&mut *conn).await?;
        match f(&mut conn).await {
            Ok(v) => {
                sqlx::query("COMMIT").execute(&mut *conn).await?;
                Ok(v)
            }
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(e)
            }
        }
    }
}

fn bind_value<'q>(
    q: sqlx::query::Query<'q, Any, AnyArguments<'q>>,
    v: &Value,
) -> sqlx::query::Query<'q, Any, AnyArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else if let Some(f) = n.as_f64() {
                q.bind(f)
            } else {
                q.bind(n.to_string())
            }
        }
        Value::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

/// Decodes one column of an `Any` row into a JSON value.
///
/// The `Any` driver hands back a runtime-typed value and keeps its `AnyValueKind`
/// enum crate-private, so each column is probed against the supported Rust types
/// in order instead of switching on a discriminant.
fn column_to_value(row: &sqlx::any::AnyRow, idx: usize) -> Result<Value> {
    macro_rules! probe {
        ($t:ty, $wrap:expr) => {
            if let Ok(v) = row.try_get::<$t, _>(idx) {
                return Ok($wrap(v));
            }
        };
    }

    // bool before the numeric types, and integers before floats, so a bool
    // column never decodes as 0/1 and an int column keeps integer precision.
    probe!(bool, Value::from);
    probe!(i64, Value::from);
    probe!(f64, Value::from);
    probe!(String, Value::String);
    probe!(Vec<u8>, |b: Vec<u8>| {
        Value::String(String::from_utf8_lossy(&b).into_owned())
    });

    // An undecodable column (driver-specific type) becomes null rather than
    // failing the whole query.
    Ok(Value::Null)
}

fn rows_to_maps(rows: &[sqlx::any::AnyRow]) -> Result<Vec<RowMap>> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut map = RowMap::new();
        for (idx, column) in row.columns.iter().enumerate() {
            map.insert(column.name.to_string(), column_to_value(row, idx)?);
        }
        out.push(map);
    }
    Ok(out)
}

// ─── TableClient ────────────────────────────────────────────────────────────

/// Table-scoped CRUD operations.
#[derive(Clone)]
pub struct TableClient {
    adapter: An5Adapter,
    /// Model name as written by the caller (`User`, `user`, `users`, ...).
    table_name: String,
    /// Resolved physical table, e.g. `[dbo].[Users]`.
    physical_table: String,
}

impl TableClient {
    /// The model name this client was opened with.
    pub fn model_name(&self) -> &str {
        &self.table_name
    }

    /// The resolved physical table name.
    pub fn table_name(&self) -> &str {
        &self.physical_table
    }

    fn quoted_table(&self) -> String {
        self.adapter.dialect.quote_table(&self.physical_table)
    }

    fn nolock(&self) -> &'static str {
        self.adapter.dialect.nolock()
    }

    fn ph(&self, n: usize) -> String {
        self.adapter.dialect.placeholder(n)
    }

    fn build_where(&self, where_value: &Option<Value>) -> Where {
        match where_value {
            Some(v) => build_where(v, self.adapter.dialect, &|n| self.ph(n)),
            None => Where::default(),
        }
    }

    /// Fetch rows matching the structured args.
    pub async fn find_many(&self, args: &FindManyArgs) -> Result<Vec<RowMap>> {
        let w = self.build_where(&args.r#where);
        let order = args
            .order_by
            .as_ref()
            .map(|o| build_order_by(o, self.adapter.dialect))
            .unwrap_or_default();

        let (cols, has_rel_select) = selected_fields(args.select.as_ref());
        let cols = if !cols.is_empty() && !has_rel_select {
            cols
                .iter()
                .map(|c| self.adapter.dialect.quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            "*".to_string()
        };

        let mut sql;
        let d = self.adapter.dialect;
        match (args.take > 0, args.skip > 0) {
            (true, false) if d.supports_limit_offset() => {
                sql = format!("SELECT {} FROM {}", cols, self.quoted_table());
                push_clauses(&mut sql, &w, &order, self.nolock());
                sql.push_str(&format!(" LIMIT {}", args.take));
            }
            (true, false) => {
                sql = format!(
                    "SELECT TOP ({}) {} FROM {}{}",
                    args.take,
                    cols,
                    self.quoted_table(),
                    self.nolock()
                );
                push_clauses(&mut sql, &w, &order, "");
            }
            (_, true) if d.supports_limit_offset() => {
                sql = format!("SELECT {} FROM {}", cols, self.quoted_table());
                push_clauses(&mut sql, &w, &order, "");
                if args.take > 0 {
                    sql.push_str(&format!(" LIMIT {}", args.take));
                } else {
                    sql.push_str(" LIMIT ALL");
                }
                sql.push_str(&format!(" OFFSET {}", args.skip));
            }
            (_, true) => {
                sql = format!("SELECT {} FROM {}{}", cols, self.quoted_table(), self.nolock());
                push_clauses(&mut sql, &w, &order, "");
                if order.is_empty() {
                    sql.push_str(" ORDER BY (SELECT NULL)");
                }
                sql.push_str(&format!(" OFFSET {} ROWS", args.skip));
                if args.take > 0 {
                    sql.push_str(&format!(" FETCH NEXT {} ROWS ONLY", args.take));
                }
            }
            _ => {
                sql = format!("SELECT {} FROM {}{}", cols, self.quoted_table(), self.nolock());
                push_clauses(&mut sql, &w, &order, "");
            }
        }

        let mut rows = self.adapter.query_raw(&sql, &w.args).await?;

        if let Some(sel) = &args.select {
            if has_rel_select {
                self.resolve_select_relations(&mut rows, sel).await?;
            }
            for row in rows.iter_mut() {
                project_fields(row, sel);
            }
        }
        if let Some(inc) = &args.include {
            self.resolve_includes(&mut rows, inc).await?;
        }
        Ok(rows)
    }

    /// First row matching the args, or `None`.
    pub async fn find_first(&self, args: &FindManyArgs) -> Result<Option<RowMap>> {
        let mut copied = args.clone();
        copied.take = 1;
        Ok(self.find_many(&copied).await?.into_iter().next())
    }

    /// Single row matching unique criteria.
    pub async fn find_unique(&self, args: &FindManyArgs) -> Result<Option<RowMap>> {
        self.find_first(args).await
    }

    /// Total number of matching rows.
    pub async fn count(&self, args: &CountArgs) -> Result<i64> {
        let w = self.build_where(&args.r#where);
        let mut sql = format!(
            "SELECT COUNT(*) AS cnt FROM {}{}",
            self.quoted_table(),
            self.nolock()
        );
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {}", w.clause));
        }
        let rows = self.adapter.query_raw(&sql, &w.args).await?;
        Ok(rows
            .first()
            .and_then(|r| r.get("cnt"))
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0))
    }

    /// Insert one row and return it.
    ///
    /// Uses the dialect's returning clause (`OUTPUT INSERTED.*` on SQL Server,
    /// `RETURNING *` on PostgreSQL/SQLite) so database-generated columns such
    /// as an auto-increment id come back populated. Falls back to the submitted
    /// values when the engine does not support it.
    pub async fn create(&self, data: &RowMap) -> Result<RowMap> {
        if data.is_empty() {
            return Err("create requires at least one field".into());
        }
        let mut data = data.clone();
        apply_generated_primary_key(&self.table_name, &mut data);
        let data = &data;
        let (scalars, _relations) = split_relation_writes(&self.table_name, data);

        let mut cols: Vec<String> = Vec::new();
        let mut placeholders: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();
        for (k, v) in &scalars {
            cols.push(self.adapter.dialect.quote_identifier(k));
            placeholders.push(self.ph(args.len() + 1));
            args.push(v.clone());
        }

        let returning = match self.adapter.dialect {
            Dialect::Mssql => " OUTPUT INSERTED.*",
            Dialect::Postgres | Dialect::Sqlite => " RETURNING *",
        };
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({}){}",
            self.quoted_table(),
            cols.join(", "),
            placeholders.join(", "),
            returning
        );

        match self.adapter.query_raw(&sql, &args).await {
            Ok(rows) if !rows.is_empty() => Ok(rows.into_iter().next().unwrap()),
            // The engine rejected the returning clause; insert without it.
            _ => {
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    self.quoted_table(),
                    cols.join(", "),
                    placeholders.join(", ")
                );
                self.adapter.execute_raw(&sql, &args).await?;
                Ok(scalars)
            }
        }
    }

    /// Insert many rows, returning the number inserted.
    pub async fn create_many(&self, data: &[RowMap]) -> Result<u64> {
        let mut count = 0;
        for row in data {
            self.create(row).await?;
            count += 1;
        }
        Ok(count)
    }

    /// Update rows matching `where` with `data`.
    pub async fn update(&self, args: &UpdateArgs) -> Result<u64> {
        let w = self.build_where(&args.r#where);
        let (sets, bind) = build_set_clause(&args.data, &|n| self.ph(n))?;
        if sets.is_empty() {
            return Ok(0);
        }
        let mut sql = format!("UPDATE {} SET {}", self.quoted_table(), sets);
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {}", w.clause));
        }
        let mut all = bind;
        all.extend(w.args);
        self.adapter.execute_raw(&sql, &all).await
    }

    /// Alias of `update` kept for API parity with the other adapters.
    pub async fn update_many(&self, args: &UpdateManyArgs) -> Result<u64> {
        self.update(&UpdateArgs {
            r#where: args.r#where.clone(),
            data: args.data.clone(),
        })
        .await
    }

    /// Delete rows matching `where`.
    pub async fn delete_many(&self, args: &DeleteManyArgs) -> Result<u64> {
        let w = self.build_where(&args.r#where);
        let mut sql = format!("DELETE FROM {}", self.quoted_table());
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {}", w.clause));
        }
        self.adapter.execute_raw(&sql, &w.args).await
    }

    /// Update when a match exists, otherwise insert.
    pub async fn upsert(&self, args: &UpsertArgs) -> Result<RowMap> {
        let existing = self.find_first(&FindManyArgs {
            r#where: args.r#where.clone(),
            take: 1,
            ..Default::default()
        })
        .await?;
        if existing.is_some() {
            self.update(&UpdateArgs {
                r#where: args.r#where.clone(),
                data: args.update.clone(),
            })
            .await?;
            Ok(existing.unwrap())
        } else {
            self.create(&args.create).await
        }
    }

    /// Aggregations over matching rows.
    pub async fn aggregate(&self, args: &AggregateArgs) -> Result<RowMap> {
        let w = self.build_where(&args.r#where);
        let mut select = String::from("COUNT(*) AS _count");
        if let Some(Value::Array(cols)) = &args.sum {
            for c in cols {
                if let Some(name) = c.as_str() {
                    select.push_str(&format!(
                        ", SUM({}) AS _sum_{}",
                        self.adapter.dialect.quote_identifier(name),
                        name
                    ));
                }
            }
        }
        if let Some(Value::Array(cols)) = &args.avg {
            for c in cols {
                if let Some(name) = c.as_str() {
                    select.push_str(&format!(
                        ", AVG({}) AS _avg_{}",
                        self.adapter.dialect.quote_identifier(name),
                        name
                    ));
                }
            }
        }
        if let Some(Value::Array(cols)) = &args.min {
            for c in cols {
                if let Some(name) = c.as_str() {
                    select.push_str(&format!(
                        ", MIN({}) AS _min_{}",
                        self.adapter.dialect.quote_identifier(name),
                        name
                    ));
                }
            }
        }
        if let Some(Value::Array(cols)) = &args.max {
            for c in cols {
                if let Some(name) = c.as_str() {
                    select.push_str(&format!(
                        ", MAX({}) AS _max_{}",
                        self.adapter.dialect.quote_identifier(name),
                        name
                    ));
                }
            }
        }

        let mut sql = format!(
            "SELECT {} FROM {}{}",
            select,
            self.quoted_table(),
            self.nolock()
        );
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {}", w.clause));
        }
        let rows = self.adapter.query_raw(&sql, &w.args).await?;
        Ok(rows.into_iter().next().unwrap_or_default())
    }

    /// Group rows by one or more columns.
    pub async fn group_by(&self, args: &GroupByArgs) -> Result<Vec<RowMap>> {
        let cols: Vec<String> = match &args.by {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            Some(Value::String(s)) => vec![s.clone()],
            _ => Vec::new(),
        };
        if cols.is_empty() {
            return Err("group_by requires at least one column".into());
        }

        let mut select: Vec<String> = cols
            .iter()
            .map(|c| self.adapter.dialect.quote_identifier(c))
            .collect();
        for (agg, values) in [
            ("SUM", &args.sum),
            ("AVG", &args.avg),
            ("MIN", &args.min),
            ("MAX", &args.max),
        ] {
            if let Some(Value::Array(items)) = values {
                for item in items {
                    if let Some(name) = item.as_str() {
                        select.push(format!(
                            "{}({}) AS {}_{}",
                            agg,
                            self.adapter.dialect.quote_identifier(name),
                            agg.to_lowercase(),
                            name
                        ));
                    }
                }
            }
        }

        let w = self.build_where(&args.r#where);
        let mut sql = format!(
            "SELECT {} FROM {}{}",
            select.join(", "),
            self.quoted_table(),
            self.nolock()
        );
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {}", w.clause));
        }
        sql.push_str(&format!(
            " GROUP BY {}",
            cols
                .iter()
                .map(|c| self.adapter.dialect.quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        if let Some(ob) = &args.order_by {
            let order = build_order_by(ob, self.adapter.dialect);
            if !order.is_empty() {
                sql.push(' ');
                sql.push_str(&order);
            }
        }
        if self.adapter.dialect.supports_limit_offset() {
            if args.take > 0 {
                sql.push_str(&format!(" LIMIT {}", args.take));
            }
            if args.skip > 0 {
                sql.push_str(&format!(" OFFSET {}", args.skip));
            }
        }

        self.adapter.query_raw(&sql, &w.args).await
    }

    /// Vector similarity search.
    ///
    /// Tries the database's native distance function first and falls back to
    /// in-memory scoring when the engine does not provide one, mirroring the
    /// behaviour of the Go and TypeScript adapters.
    pub async fn vector_search(&self, args: &VectorSearchArgs) -> Result<Vec<RowMap>> {
        let take = if args.take > 0 { args.take } else { 10 };
        let field = if args.vector_field.is_empty() {
            "embedding"
        } else {
            &args.vector_field
        };
        let metric = if args.distance_metric.is_empty() {
            "cosine"
        } else {
            &args.distance_metric
        };
        let quoted_field = self.adapter.dialect.quote_identifier(field);
        let w = self.build_where(&args.r#where);

        // Native path: MSSQL VECTOR_DISTANCE / Postgres pgvector operators.
        let native_sql = match self.adapter.dialect {
            Dialect::Postgres => {
                let op = match metric.to_lowercase().as_str() {
                    "euclidean" => "<->",
                    "dot" => "<#>",
                    _ => "<=>",
                };
                Some(format!(
                    "SELECT *, ({quoted_field} {op} $1::vector) AS distance FROM {}{} WHERE {quoted_field} IS NOT NULL",
                    self.quoted_table(),
                    suffix_where(self.nolock(), &w)
                ))
            }
            Dialect::Mssql => {
                let dim = args.vector.len();
                Some(format!(
                    "SELECT TOP ({take}) *, VECTOR_DISTANCE('{metric}', CAST({quoted_field} AS VECTOR({dim}, float32)), CAST(? AS VECTOR({dim}, float32))) AS distance FROM {}{} WHERE {quoted_field} IS NOT NULL",
                    self.quoted_table(),
                    self.nolock()
                ))
            }
            Dialect::Sqlite => None,
        };

        if let Some(sql) = native_sql {
            let mut bind: Vec<Value> = Vec::new();
            if !w.is_empty() {
                bind.extend(w.args.clone());
            }
            match self.adapter.query_raw(&sql, &bind).await {
                Ok(mut rows) if !rows.is_empty() => {
                    let mut ordered = score_rows(&mut rows, &args.vector, metric);
                    ordered.truncate(take as usize);
                    return Ok(ordered);
                }
                Ok(_) => {}
                Err(e) => {
                    // Fall through to the in-memory path on driver errors.
                    let _ = e;
                }
            }
        }

        // Fallback: in-memory similarity over the filtered rows.
        let rows = self
            .find_many(&FindManyArgs {
                r#where: args.r#where.clone(),
                ..Default::default()
            })
            .await?;

        let mut scored: Vec<(RowMap, f64)> = Vec::new();
        for mut row in rows {
            let raw = row.get(field).cloned();
            let row_vec = match raw {
                Some(Value::String(s)) => parse_vector(&s),
                Some(Value::Array(items)) => Some(
                    items
                        .iter()
                        .filter_map(|v| v.as_f64())
                        .collect::<Vec<f64>>(),
                ),
                _ => None,
            };
            if let Some(rv) = row_vec {
                if rv.len() == args.vector.len() {
                    let d = vector_distance(&args.vector, &rv, metric);
                    row.insert("distance".to_string(), Value::from(d));
                    scored.push((row, d));
                }
            }
        }
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(take as usize);
        Ok(scored.into_iter().map(|(r, _)| r).collect())
    }

    async fn resolve_includes(&self, rows: &mut [RowMap], include: &Value) -> Result<()> {
        let requested = match include {
            Value::Array(items) => items.clone(),
            Value::Object(m) => m
                .iter()
                .filter(|(_, v)| matches!(v, Value::Bool(true)))
                .map(|(k, _)| Value::String(k.clone()))
                .collect(),
            _ => Vec::new(),
        };
        for key in requested {
            let key = match key.as_str() {
                Some(k) => k.to_string(),
                None => continue,
            };
            self.resolve_select_relations(rows, &Value::Array(vec![Value::String(key)]))
                .await?;
        }
        Ok(())
    }

    /// Eager-loads the requested relations onto each row.
    ///
    /// Boxed because eager loading re-enters `find_many` on the related table,
    /// which would otherwise make this future infinitely sized.
    pub fn resolve_select_relations<'a>(
        &'a self,
        rows: &'a mut [RowMap],
        select: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
        let requested: Vec<String> = match select {
            Value::Array(items) => items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            Value::Object(m) => m
                .iter()
                .filter(|(_, v)| matches!(v, Value::Bool(true)))
                .map(|(k, _)| k.clone())
                .collect(),
            _ => Vec::new(),
        };

        let relations: HashMap<String, RelationDef> =
            crate::base::get_relations_for_model(&self.table_name);

        for key in requested {
            if key == "_count" {
                continue;
            }
            let def = match relations.get(&key) {
                Some(d) => d.clone(),
                None => continue,
            };
            let target = self.adapter.table(&def.model_name);
            let fk = if def.foreign_key.is_empty() {
                "id".to_string()
            } else {
                def.foreign_key.clone()
            };
            let lk = if def.local_key.is_empty() {
                "id".to_string()
            } else {
                def.local_key.clone()
            };

            for row in rows.iter_mut() {
                let parent_value = match row.get(&lk) {
                    Some(v) if !v.is_null() => v.clone(),
                    _ => continue,
                };
                let child_rows = target
                    .find_many(&FindManyArgs {
                        r#where: Some(serde_json::json!({ fk.clone(): parent_value })),
                        ..Default::default()
                    })
                    .await?;
                if def.relation_type == "many" {
                    row.insert(
                        key.clone(),
                        Value::Array(child_rows.into_iter().map(Value::Object).collect()),
                    );
                } else {
                    row.insert(
                        key.clone(),
                        child_rows
                            .into_iter()
                            .next()
                            .map(Value::Object)
                            .unwrap_or(Value::Null),
                    );
                }
            }
        }
        Ok(())
        })
    }
}

// ─── ViewClient ─────────────────────────────────────────────────────────────

/// Read-only operations over a database view.
#[derive(Clone)]
pub struct ViewClient {
    table: TableClient,
}

impl ViewClient {
    pub async fn find_many(&self, args: &FindManyArgs) -> Result<Vec<RowMap>> {
        self.table.find_many(args).await
    }
    pub async fn find_first(&self, args: &FindManyArgs) -> Result<Option<RowMap>> {
        self.table.find_first(args).await
    }
    pub async fn find_unique(&self, args: &FindManyArgs) -> Result<Option<RowMap>> {
        self.table.find_unique(args).await
    }
    pub async fn count(&self, args: &CountArgs) -> Result<i64> {
        self.table.count(args).await
    }
    pub async fn aggregate(&self, args: &AggregateArgs) -> Result<RowMap> {
        self.table.aggregate(args).await
    }
    pub async fn group_by(&self, args: &GroupByArgs) -> Result<Vec<RowMap>> {
        self.table.group_by(args).await
    }
    pub async fn vector_search(&self, args: &VectorSearchArgs) -> Result<Vec<RowMap>> {
        self.table.vector_search(args).await
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn push_clauses(sql: &mut String, w: &Where, order: &str, extra: &str) {
    if !w.is_empty() {
        sql.push_str(&format!(" WHERE {}", w.clause));
    }
    if !order.is_empty() {
        sql.push(' ');
        sql.push_str(order);
    }
    if !extra.is_empty() {
        sql.push(' ');
        sql.push_str(extra);
    }
}

fn suffix_where(nolock: &str, w: &Where) -> String {
    let mut s = String::new();
    if !nolock.is_empty() {
        s.push(' ');
        s.push_str(nolock);
    }
    if !w.is_empty() {
        s.push_str(&format!(" AND {}", w.clause));
    }
    s
}

/// Extracts scalar column names from a select value, reporting whether any
/// relation key was requested.
fn selected_fields(select: Option<&Value>) -> (Vec<String>, bool) {
    match select {
        Some(Value::Array(items)) => (
            items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            false,
        ),
        Some(Value::Object(m)) => {
            let mut cols = Vec::new();
            let mut has_rel = false;
            for (k, v) in m {
                if matches!(v, Value::Bool(true)) {
                    if k == "_count" || k.contains('_') {
                        has_rel = true;
                    }
                    cols.push(k.clone());
                }
            }
            (cols, has_rel)
        }
        _ => (Vec::new(), false),
    }
}

/// Keeps only the selected keys on a row, mirroring `projectFields` in Go/TS.
fn project_fields(row: &mut RowMap, select: &Value) {
    let keys: Vec<String> = match select {
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Value::Object(m) => m
            .iter()
            .filter(|(_, v)| matches!(v, Value::Bool(true)))
            .map(|(k, _)| k.clone())
            .collect(),
        _ => return,
    };
    let count = row.get("_count").cloned();
    let projected: RowMap = keys
        .iter()
        .filter_map(|k| row.get(k).map(|v| (k.clone(), v.clone())))
        .collect();
    *row = projected;
    if let Some(c) = count {
        row.insert("_count".to_string(), c);
    }
}

/// Separates relation writes from scalar columns using the model metadata.
fn split_relation_writes(model: &str, data: &RowMap) -> (RowMap, RowMap) {
    let relations = crate::base::get_relations_for_model(model);
    let mut scalars = RowMap::new();
    let mut rels = RowMap::new();
    for (k, v) in data {
        if relations.contains_key(k) {
            rels.insert(k.clone(), v.clone());
        } else {
            scalars.insert(k.clone(), v.clone());
        }
    }
    (scalars, rels)
}

/// Builds `col = ph` pairs, expanding field operations such as `increment`.
fn build_set_clause(data: &Value, ph: &dyn Fn(usize) -> String) -> Result<(String, Vec<Value>)> {
    let obj = match data {
        Value::Object(m) => m,
        Value::Null => return Ok((String::new(), Vec::new())),
        _ => return Err("update data must be an object".into()),
    };

    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    for (col, val) in obj {
        let quoted = format!("[{}]", col);
        match val {
            Value::Object(op) if op.contains_key("set") => {
                args.push(op["set"].clone());
                sets.push(format!("{} = {}", quoted, ph(args.len())));
            }
            Value::Object(op) if op.contains_key("increment") => {
                args.push(op["increment"].clone());
                sets.push(format!("{} = {} + {}", quoted, quoted, ph(args.len())));
            }
            Value::Object(op) if op.contains_key("decrement") => {
                args.push(op["decrement"].clone());
                sets.push(format!("{} = {} - {}", quoted, quoted, ph(args.len())));
            }
            Value::Object(op) if op.contains_key("multiply") => {
                args.push(op["multiply"].clone());
                sets.push(format!("{} = {} * {}", quoted, quoted, ph(args.len())));
            }
            Value::Object(op) if op.contains_key("divide") => {
                args.push(op["divide"].clone());
                sets.push(format!("{} = {} / {}", quoted, quoted, ph(args.len())));
            }
            other => {
                args.push(other.clone());
                sets.push(format!("{} = {}", quoted, ph(args.len())));
            }
        }
    }

    Ok((sets.join(", "), args))
}

/// Parses a JSON array string into a vector.
fn parse_vector(raw: &str) -> Option<Vec<f64>> {
    let trimmed = raw.trim().trim_start_matches('[').trim_end_matches(']');
    if trimmed.trim().is_empty() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    for part in trimmed.split(',') {
        match part.trim().parse::<f64>() {
            Ok(v) => out.push(v),
            Err(_) => return None,
        }
    }
    Some(out)
}

/// Sorts rows by their `distance` field, falling back to in-memory similarity.
fn score_rows(rows: &mut [RowMap], query: &[f64], metric: &str) -> Vec<RowMap> {
    for row in rows.iter_mut() {
        if let Some(d) = row.get("distance").and_then(|v| v.as_f64()) {
            row.insert("distance".to_string(), Value::from(d));
            continue;
        }
        if let Some(Value::String(s)) = row.get("embedding").cloned() {
            if let Some(v) = parse_vector(&s) {
                if v.len() == query.len() {
                    let d = vector_distance(query, &v, metric);
                    row.insert("distance".to_string(), Value::from(d));
                }
            }
        }
    }
    rows.sort_by(|a, b| {
        let av = a.get("distance").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
        let bv = b.get("distance").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
        av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn client() -> TableClient {
        // No queries are issued here: these tests only exercise SQL construction
        // helpers, but a pool still needs a Tokio runtime to be created.
        let pool = AnyPool::connect_lazy("sqlite::memory:").expect("lazy pool");
        An5Adapter::from_pool(pool, "sqlite::memory:").table("User")
    }

    #[tokio::test]
    async fn resolves_physical_table() {
        crate::base::set_adapter_metadata(AdapterMetadata {
            model_to_table: HashMap::from([("User".to_string(), "[dbo].[Users]".to_string())]),
            ..Default::default()
        });
        let c = client().await;
        assert_eq!(c.table_name(), "[dbo].[Users]");
    }

    #[test]
    fn build_set_clause_expands_operations() {
        // serde_json orders object keys, so the clause is deterministic
        // regardless of how the caller built the update payload.
        let (sets, args) = build_set_clause(
            &json!({ "total": { "increment": 5 }, "name": { "set": "x" } }),
            &|n| format!("?{}", n),
        )
        .expect("set clause");
        assert_eq!(sets, "[name] = ?1, [total] = [total] + ?2");
        assert_eq!(args, vec![json!("x"), json!(5)]);
    }

    #[test]
    fn selected_fields_detects_relations() {
        let (cols, has_rel) = selected_fields(Some(&json!({ "id": true, "user_email": true })));
        assert_eq!(cols, vec!["id".to_string(), "user_email".to_string()]);
        assert!(has_rel);
    }

    #[test]
    fn project_fields_keeps_selection() {
        let mut row = json!({ "id": 1, "name": "a", "email": "b" })
            .as_object()
            .unwrap()
            .clone();
        project_fields(&mut row, &json!({ "id": true }));
        assert_eq!(row.len(), 1);
        assert!(row.contains_key("id"));
    }

    #[test]
    fn parses_vector_strings() {
        assert_eq!(parse_vector("[1.0, 2.5]"), Some(vec![1.0, 2.5]));
        assert_eq!(parse_vector("[]"), Some(vec![]));
    }

    #[test]
    fn split_relations_uses_metadata() {
        crate::base::set_adapter_metadata(AdapterMetadata {
            relation_map: HashMap::from([(
                "Order".to_string(),
                HashMap::from([(
                    "user".to_string(),
                    RelationDef {
                        model_name: "User".to_string(),
                        relation_type: "one".to_string(),
                        foreign_key: "user_id".to_string(),
                        local_key: "id".to_string(),
                    },
                )]),
            )]),
            ..Default::default()
        });
        let (scalars, rels) = split_relation_writes(
            "Order",
            json!({ "total": 10, "user": { "connect": 1 } })
                .as_object()
                .unwrap(),
        );
        assert!(scalars.contains_key("total"));
        assert!(rels.contains_key("user"));
    }
}
