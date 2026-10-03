//! End-to-end CRUD test against an in-memory SQLite database.
//!
//! Exercises the real query path (`find_many`, `count`, `create`, `update`,
//! `delete_many`) rather than only the SQL builders, so regressions in binding,
//! row decoding and dialect handling are caught.

use an5_adapters::{
    AdapterMetadata, An5Adapter, CountArgs, DeleteManyArgs, FindManyArgs, UpdateArgs,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Once;

static DRIVER: Once = Once::new();

/// Removes the temporary database when the test finishes.
struct TempDb(std::path::PathBuf);

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn adapter() -> (An5Adapter, TempDb) {
    // `install_drivers` may only be called once per process.
    DRIVER.call_once(|| {
        sqlx::any::install_drivers(&[sqlx::sqlite::any::DRIVER]).expect("install sqlite driver");
    });

    // A pooled `sqlite::memory:` database is per-connection, so each pooled
    // connection would see an empty schema. Use a temp file instead, and
    // `mode=rwc` because the `Any` driver cannot pass `create_if_missing(true)`.
    let path = std::env::temp_dir().join(format!(
        "an5-rust-test-{}-{}.sqlite",
        std::process::id(),
        unique_id()
    ));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite:file:{}?mode=rwc", path.display());
    let guard = TempDb(path);

    let db = An5Adapter::connect(&url)
        .await
        .expect("connect to temp sqlite");

    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([("User".to_string(), "users".to_string())]),
        ..Default::default()
    });

    db.execute_raw(
        "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, age INTEGER)",
        &[],
    )
    .await
    .expect("create users table");

    (db, guard)
}

/// Monotonic suffix so parallel tests never share a database file.
fn unique_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[tokio::test]
async fn crud_round_trip() {
    let (db, _tmp) = adapter().await;
    let users = db.table("User");

    // create
    let created = users
        .create(
            json!({ "id": "1", "email": "alice@example.com", "name": "Alice", "age": 30 })
                .as_object()
                .unwrap(),
        )
        .await
        .expect("create user");
    assert_eq!(created.get("email").and_then(|v| v.as_str()), Some("alice@example.com"));

    users
        .create(
            json!({ "id": "2", "email": "bob@example.com", "name": "Bob", "age": 25 })
                .as_object()
                .unwrap(),
        )
        .await
        .expect("create second user");

    // find_many
    let all = users
        .find_many(&FindManyArgs::new())
        .await
        .expect("find many");
    assert_eq!(all.len(), 2);

    // find_many with a contains filter
    let filtered = users
        .find_many(
            &FindManyArgs::new().where_value(json!({ "email": { "contains": "alice" } })),
        )
        .await
        .expect("find filtered");
    assert_eq!(filtered.len(), 1);
    assert_eq!(
        filtered[0].get("name").and_then(|v| v.as_str()),
        Some("Alice")
    );

    // integer columns round-trip as integers, not floats
    let age = all
        .iter()
        .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("2"))
        .and_then(|r| r.get("age"))
        .and_then(|v| v.as_i64());
    assert_eq!(age, Some(25));

    // find_first
    let first = users
        .find_first(
            &FindManyArgs::new().where_value(json!({ "id": "1" })),
        )
        .await
        .expect("find first");
    assert!(first.is_some());

    // order_by + take
    let page = users
        .find_many(&FindManyArgs {
            order_by: Some(json!({ "age": "desc" })),
            take: 1,
            ..Default::default()
        })
        .await
        .expect("find paged");
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].get("age").and_then(|v| v.as_i64()), Some(30));

    // count
    let total = users.count(&CountArgs::default()).await.expect("count");
    assert_eq!(total, 2);

    let filtered_count = users
        .count(&CountArgs {
            r#where: Some(json!({ "name": { "equals": "Bob" } })),
        })
        .await
        .expect("filtered count");
    assert_eq!(filtered_count, 1);

    // update with a plain value
    let affected = users
        .update(&UpdateArgs {
            r#where: Some(json!({ "id": "1" })),
            data: json!({ "name": { "set": "Alicia" } }),
        })
        .await
        .expect("update user");
    assert_eq!(affected, 1);

    let renamed = users
        .find_first(&FindManyArgs::new().where_value(json!({ "id": "1" })))
        .await
        .expect("refetch")
        .expect("row present");
    assert_eq!(renamed.get("name").and_then(|v| v.as_str()), Some("Alicia"));

    // update with a field operation
    users
        .update(&UpdateArgs {
            r#where: Some(json!({ "id": "1" })),
            data: json!({ "age": { "increment": 5 } }),
        })
        .await
        .expect("increment age");
    let bumped = users
        .find_first(&FindManyArgs::new().where_value(json!({ "id": "1" })))
        .await
        .expect("refetch")
        .expect("row present");
    assert_eq!(bumped.get("age").and_then(|v| v.as_i64()), Some(35));

    // select projection
    let projected = users
        .find_many(&FindManyArgs {
            select: Some(json!({ "id": true })),
            r#where: Some(json!({ "id": "1" })),
            ..Default::default()
        })
        .await
        .expect("select projection");
    assert_eq!(projected[0].len(), 1);
    assert!(projected[0].contains_key("id"));

    // delete_many
    let deleted = users
        .delete_many(&DeleteManyArgs {
            r#where: Some(json!({ "id": "2" })),
        })
        .await
        .expect("delete user");
    assert_eq!(deleted, 1);
    assert_eq!(users.count(&CountArgs::default()).await.expect("count"), 1);
}

#[tokio::test]
async fn raw_sql_and_transaction() {
    let (db, _tmp) = adapter().await;

    db.execute_raw(
        "INSERT INTO users (id, email, name, age) VALUES ('9', 'z@example.com', 'Zed', 40)",
        &[],
    )
    .await
    .expect("insert via execute_raw");

    let rows = db
        .query_raw("SELECT id, name FROM users WHERE id = ?1", &[json!("9")])
        .await
        .expect("query_raw");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get("name").and_then(|v| v.as_str()), Some("Zed"));

    // transaction commits on success
    let inserted = db
        .transaction(|conn| {
            Box::pin(async move {
                sqlx::query("INSERT INTO users (id, email, name, age) VALUES ('10', 'y@example.com', 'Yan', 22)")
                    .execute(&mut *conn)
                    .await?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
            })
        })
        .await
        .expect("transaction commit");
    assert_eq!(inserted, ());
    assert_eq!(db.table("User").count(&CountArgs::default()).await.unwrap(), 2);

    // transaction rolls back on error
    let failed = db
        .transaction(|conn| {
            Box::pin(async move {
                sqlx::query("INSERT INTO users (id, email, name, age) VALUES ('11', 'x@example.com', 'X', 1)")
                    .execute(&mut *conn)
                    .await?;
                Err::<(), _>("boom".into())
            })
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(db.table("User").count(&CountArgs::default()).await.unwrap(), 2);
}

#[tokio::test]
async fn aggregate_and_group_by() {
    let (db, _tmp) = adapter().await;
    let users = db.table("User");
    for (id, name, age) in [("1", "Alice", 30), ("2", "Bob", 25), ("3", "Cara", 35)] {
        users
            .create(
                json!({ "id": id, "email": format!("{}@example.com", name.to_lowercase()), "name": name, "age": age })
                    .as_object()
                    .unwrap(),
            )
            .await
            .expect("create");
    }

    let agg = users
        .aggregate(&an5_adapters::AggregateArgs {
            sum: Some(json!(["age"])),
            ..Default::default()
        })
        .await
        .expect("aggregate");
    assert_eq!(agg.get("_count").and_then(|v| v.as_i64()), Some(3));
    assert_eq!(agg.get("_sum_age").and_then(|v| v.as_i64()), Some(90));

    let groups = users
        .group_by(&an5_adapters::GroupByArgs {
            by: Some(json!(["name"])),
            ..Default::default()
        })
        .await
        .expect("group by");
    assert_eq!(groups.len(), 3);
}

#[tokio::test]
async fn shared_query_contract() {
    let (db, _tmp) = adapter().await;
    db.execute_raw("ALTER TABLE users ADD COLUMN score INTEGER", &[]).await.unwrap();
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../test/fixtures/query-semantics.json")).unwrap();
    for row in contract["rows"].as_array().unwrap() {
        db.execute_raw("INSERT INTO users (id, score) VALUES (?, ?)", &[json!(row["id"].as_i64().unwrap().to_string()), row["score"].clone()]).await.unwrap();
    }
    for case in contract["cases"].as_array().unwrap() {
        let rows = db.table("User").find_many(&FindManyArgs {
            r#where: Some(case["where"].clone()),
            order_by: Some(json!({"id": "asc"})),
            ..Default::default()
        }).await.unwrap_or_else(|err| panic!("{}: {err}", case["name"]));
        let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_str().unwrap().parse().unwrap()).collect();
        let expected: Vec<i64> = case["ids"].as_array().unwrap().iter().map(|id| id.as_i64().unwrap()).collect();
        assert_eq!(ids, expected, "{}", case["name"]);
    }
}
