//! End-to-end CRUD test against an in-memory SQLite database.
//!
//! Exercises the real query path (`find_many`, `count`, `create`, `update`,
//! `delete_many`) rather than only the SQL builders, so regressions in binding,
//! row decoding and dialect handling are caught.

use an5_adapters::{
    AdapterMetadata, An5Adapter, CountArgs, DeleteManyArgs, FindManyArgs, GroupByArgs, RelationDef,
    UpdateArgs, UpsertArgs,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Once;

static DRIVER: Once = Once::new();
static METADATA_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let _guard = METADATA_GUARD.lock().await;
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
    let _guard = METADATA_GUARD.lock().await;
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
    let _guard = METADATA_GUARD.lock().await;
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
    let _guard = METADATA_GUARD.lock().await;
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

#[tokio::test]
async fn relation_filters_and_strict_operator_rejection() {
    let _guard = METADATA_GUARD.lock().await;
    let (db, _tmp) = adapter().await;
    db.execute_raw(
        "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NULL, total INTEGER NOT NULL)",
        &[],
    )
    .await
    .expect("create orders table");

    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([
            ("User".to_string(), "users".to_string()),
            ("user".to_string(), "users".to_string()),
            ("Order".to_string(), "orders".to_string()),
            ("order".to_string(), "orders".to_string()),
        ]),
        model_fields: HashMap::from([
            ("User".to_string(), json!({ "id": {}, "email": {}, "name": {}, "age": {} })),
            ("Order".to_string(), json!({ "id": {}, "userId": {}, "total": {} })),
        ]),
        relation_map: HashMap::from([
            (
                "user".to_string(),
                HashMap::from([(
                    "orders".to_string(),
                    RelationDef {
                        model_name: "order".to_string(),
                        relation_type: "many".to_string(),
                        foreign_key: "user_id".to_string(),
                        local_key: "id".to_string(),
                    },
                )]),
            ),
            (
                "order".to_string(),
                HashMap::from([(
                    "user".to_string(),
                    RelationDef {
                        model_name: "user".to_string(),
                        relation_type: "one".to_string(),
                        foreign_key: "user_id".to_string(),
                        local_key: "id".to_string(),
                    },
                )]),
            ),
        ]),
    });

    db.execute_raw(
        "INSERT INTO users (id, email, name, age) VALUES ('u1', 'a@example.com', 'Alice', 30), ('u2', 'b@example.com', 'Bob', 25), ('u3', 'c@example.com', 'Carol', 28)",
        &[],
    )
    .await
    .unwrap();
    db.execute_raw(
        "INSERT INTO orders (id, user_id, total) VALUES ('o1', 'u1', 100), ('o2', 'u1', 250), ('o3', 'u2', 50), ('o4', NULL, 75)",
        &[],
    )
    .await
    .unwrap();

    let users = db.table("User");
    let orders = db.table("Order");

    // some / none / every and nested `not` inside relation filter
    let some_big = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "orders": { "some": { "total": { "not": { "lt": 200 } } } } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        some_big.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["u1"]
    );

    let none_big = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "orders": { "none": { "total": { "gte": 200 } } } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        none_big.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["u2", "u3"]
    );

    let every_ge_50 = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "orders": { "every": { "total": { "gte": 50 } } } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        every_ge_50.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["u1", "u2", "u3"]
    );

    // to-one is / isNot / is: null / isNot: null
    let alice_orders = orders
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "user": { "is": { "email": "a@example.com" } } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        alice_orders.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["o1", "o2"]
    );

    let orphan_orders = orders
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "user": { "is": null } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        orphan_orders.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["o4"]
    );

    let owned_orders = orders
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "user": { "isNot": null } })),
            order_by: Some(json!({ "id": "asc" })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        owned_orders.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["o1", "o2", "o3"]
    );

    // count and group_by with relation filter
    assert_eq!(
        users
            .count(&CountArgs {
                r#where: Some(json!({ "orders": { "some": { "total": { "gte": 100 } } } })),
            })
            .await
            .unwrap(),
        1
    );
    let grouped = users
        .group_by(&GroupByArgs {
            by: Some(json!(["id"])),
            r#where: Some(json!({ "orders": { "some": { "total": 50 } } })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0]["id"].as_str(), Some("u2"));

    // include for to-many and to-one
    let u1_inc = users
        .find_first(&FindManyArgs {
            r#where: Some(json!({ "id": "u1" })),
            include: Some(json!({ "orders": true })),
            ..Default::default()
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(u1_inc["orders"].as_array().unwrap().len(), 2);

    let o3_inc = orders
        .find_first(&FindManyArgs {
            r#where: Some(json!({ "id": "o3" })),
            include: Some(json!({ "user": true })),
            ..Default::default()
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(o3_inc["user"]["email"].as_str(), Some("b@example.com"));

    // unknown scalar / relation operator returns Err
    assert!(
        users
            .find_many(&FindManyArgs {
                r#where: Some(json!({ "email": { "badOp": "x" } })),
                ..Default::default()
            })
            .await
            .is_err()
    );
    assert!(
        users
            .find_many(&FindManyArgs {
                r#where: Some(json!({ "orders": { "is": { "total": 10 } } })),
                ..Default::default()
            })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn group_by_having_per_field_count_mode_insensitive_and_offset_pagination() {
    let _guard = METADATA_GUARD.lock().await;
    let (db, _tmp) = adapter().await;
    db.execute_raw(
        "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NULL, total INTEGER NOT NULL, note TEXT NULL)",
        &[],
    )
    .await
    .unwrap();

    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([
            ("User".to_string(), "users".to_string()),
            ("Order".to_string(), "orders".to_string()),
        ]),
        model_fields: HashMap::from([
            ("User".to_string(), json!({ "id": {}, "email": {}, "name": {}, "age": {} })),
            ("Order".to_string(), json!({ "id": {}, "user_id": {}, "total": {}, "note": {} })),
        ]),
        ..Default::default()
    });

    db.execute_raw(
        "INSERT INTO users (id, email, name, age) VALUES ('u1', 'Alice@Example.com', 'Alice', 30), ('u2', 'bob@example.com', 'Bob', 25), ('u3', 'carol@example.com', 'Carol', 28)",
        &[],
    )
    .await
    .unwrap();
    db.execute_raw(
        "INSERT INTO orders (id, user_id, total, note) VALUES ('o1', 'u1', 100, 'first'), ('o2', 'u1', 250, NULL), ('o3', 'u2', 50, 'small'), ('o4', 'u3', 400, 'big')",
        &[],
    )
    .await
    .unwrap();

    let users = db.table("User");
    let orders = db.table("Order");

    // mode: "insensitive" works on SQLite contains & in
    let ci_alice = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "email": { "contains": "alice", "mode": "insensitive" } })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(ci_alice.len(), 1);
    assert_eq!(ci_alice[0]["id"].as_str(), Some("u1"));

    let ci_in = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "email": { "in": ["ALICE@EXAMPLE.COM"], "mode": "insensitive" } })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(ci_in.len(), 1);

    // SQLite offset-only pagination in find_many (LIMIT -1 OFFSET 1)
    let paged_users = users
        .find_many(&FindManyArgs {
            order_by: Some(json!({ "id": "asc" })),
            skip: 1,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        paged_users.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["u2", "u3"]
    );

    // group_by with WHERE + HAVING + per-field _count + offset-only pagination
    let grouped = orders
        .group_by(&GroupByArgs {
            by: Some(json!(["user_id"])),
            r#where: Some(json!({ "total": { "gte": 50 } })),
            having: Some(json!({
                "OR": [
                    { "_count": { "_all": { "gte": 2 } }, "_sum": { "total": { "gte": 300 } } },
                    { "user_id": "u3" }
                ]
            })),
            order_by: Some(json!({ "user_id": "asc" })),
            count: Some(json!({ "_all": true, "note": true })),
            sum: Some(json!(["total"])),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(grouped.len(), 2);
    assert_eq!(grouped[0]["user_id"].as_str(), Some("u1"));
    assert_eq!(grouped[0]["_count"].as_i64(), Some(2));
    assert_eq!(grouped[0]["_count_note"].as_i64(), Some(1));
    assert_eq!(grouped[0]["sum_total"].as_i64(), Some(350));
    assert_eq!(grouped[1]["user_id"].as_str(), Some("u3"));

    // group_by offset-only pagination on SQLite
    let paged_groups = orders
        .group_by(&GroupByArgs {
            by: Some(json!(["user_id"])),
            order_by: Some(json!({ "user_id": "asc" })),
            skip: 1,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        paged_groups.iter().map(|r| r["user_id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["u2", "u3"]
    );

    // Invalid having rejects before query
    assert!(
        orders
            .group_by(&GroupByArgs {
                by: Some(json!(["user_id"])),
                having: Some(json!({ "total": { "gt": 10 } })),
                ..Default::default()
            })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn upsert_returns_updated_row_and_include_supports_nested_options_and_count() {
    let _guard = METADATA_GUARD.lock().await;
    let (db, _tmp) = adapter().await;
    db.execute_raw(
        "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NULL, total INTEGER NOT NULL)",
        &[],
    )
    .await
    .unwrap();

    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([
            ("User".to_string(), "users".to_string()),
            ("Order".to_string(), "orders".to_string()),
        ]),
        model_fields: HashMap::from([
            ("User".to_string(), json!({ "id": {}, "email": {}, "name": {}, "age": {} })),
            ("Order".to_string(), json!({ "id": {}, "user_id": {}, "total": {} })),
        ]),
        relation_map: HashMap::from([
            (
                "User".to_string(),
                HashMap::from([(
                    "orders".to_string(),
                    RelationDef {
                        model_name: "Order".to_string(),
                        relation_type: "many".to_string(),
                        foreign_key: "user_id".to_string(),
                        local_key: "id".to_string(),
                    },
                )]),
            ),
            (
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
            ),
        ]),
    });

    let users = db.table("User");
    let orders = db.table("Order");

    // Upsert insert path
    let inserted = users
        .upsert(&UpsertArgs {
            r#where: Some(json!({ "id": "u1" })),
            create: json!({ "id": "u1", "email": "alice@example.com", "name": "Alice", "age": 30 })
                .as_object()
                .unwrap()
                .clone(),
            update: json!({ "age": 31 }),
        })
        .await
        .unwrap();
    assert_eq!(inserted["age"].as_i64(), Some(30));

    // Upsert update path must return the updated row, not stale pre-update values
    let updated = users
        .upsert(&UpsertArgs {
            r#where: Some(json!({ "id": "u1" })),
            create: json!({ "id": "u1", "email": "alice@example.com", "name": "Alice", "age": 30 })
                .as_object()
                .unwrap()
                .clone(),
            update: json!({ "age": 42, "name": "Alice Updated" }),
        })
        .await
        .unwrap();
    assert_eq!(updated["age"].as_i64(), Some(42));
    assert_eq!(updated["name"].as_str(), Some("Alice Updated"));

    db.execute_raw(
        "INSERT INTO orders (id, user_id, total) VALUES ('o1', 'u1', 50), ('o2', 'u1', 200), ('o3', 'u1', 150), ('o4', NULL, 25)",
        &[],
    )
    .await
    .unwrap();

    // Nested include options + _count
    let u1 = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "id": "u1" })),
            include: Some(json!({
                "orders": {
                    "where": { "total": { "gte": 100 } },
                    "orderBy": { "total": "desc" },
                    "take": 1
                },
                "_count": true
            })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(u1.len(), 1);
    let top_orders = u1[0]["orders"].as_array().unwrap();
    assert_eq!(top_orders.len(), 1);
    assert_eq!(top_orders[0]["id"].as_str(), Some("o2"));
    assert_eq!(u1[0]["_count"]["orders"].as_i64(), Some(3));

    // Relation select map (excluding 'orders' from scalar SQL columns and projecting id + orders + filtered _count)
    let selected = users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "id": "u1" })),
            select: Some(json!({
                "id": true,
                "orders": {
                    "orderBy": { "total": "asc" },
                    "select": { "id": true }
                },
                "_count": { "select": { "orders": { "where": { "total": { "gte": 150 } } } } }
            })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert!(selected[0].get("email").is_none());
    assert_eq!(selected[0]["orders"].as_array().unwrap().len(), 3);
    assert_eq!(selected[0]["orders"][0]["id"].as_str(), Some("o1"));
    assert_eq!(selected[0]["_count"]["orders"].as_i64(), Some(2));

    // Nullable to-one include sets null for missing foreign key
    let orphan = orders
        .find_first(&FindManyArgs {
            r#where: Some(json!({ "id": "o4" })),
            include: Some(json!({ "user": true })),
            ..Default::default()
        })
        .await
        .unwrap()
        .unwrap();
    assert!(orphan["user"].is_null());

    // _count: true only counts to-many relations (Order only has to-one `user`)
    let order_counts = orders
        .find_first(&FindManyArgs {
            r#where: Some(json!({ "id": "o1" })),
            include: Some(json!({ "_count": true })),
            ..Default::default()
        })
        .await
        .unwrap()
        .unwrap();
    assert!(order_counts.get("_count").is_none());

    // Multi-parent per-parent include skip/take, take=0, and select+include preserving orders without leaking id
    users
        .upsert(&UpsertArgs {
            r#where: Some(json!({ "id": "u2" })),
            create: json!({ "id": "u2", "email": "bob@example.com", "name": "Bob", "age": 25 })
                .as_object()
                .unwrap()
                .clone(),
            update: json!({ "name": "Bob" }),
        })
        .await
        .unwrap();
    db.execute_raw(
        "INSERT INTO orders (id, user_id, total) VALUES ('o5', 'u2', 80), ('o6', 'u2', 120)",
        &[],
    )
    .await
    .unwrap();

    let paged = users
        .find_many(&FindManyArgs {
            order_by: Some(json!({ "id": "asc" })),
            select: Some(json!({ "name": true })),
            include: Some(json!({
                "orders": {
                    "orderBy": { "total": "asc" },
                    "skip": 1,
                    "take": 1,
                    "select": { "total": true }
                },
                "_count": { "select": { "orders": { "where": { "total": { "gte": 100 } } } } }
            })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(paged.len(), 2);
    assert!(paged[0].get("id").is_none());
    assert_eq!(paged[0]["name"].as_str(), Some("Alice Updated"));
    assert_eq!(paged[0]["orders"].as_array().unwrap().len(), 1);
    assert_eq!(paged[0]["orders"][0]["total"].as_i64(), Some(150));
    assert_eq!(paged[0]["_count"]["orders"].as_i64(), Some(2));
    assert!(paged[1].get("id").is_none());
    assert_eq!(paged[1]["name"].as_str(), Some("Bob"));
    assert_eq!(paged[1]["orders"].as_array().unwrap().len(), 1);
    assert_eq!(paged[1]["orders"][0]["total"].as_i64(), Some(120));
    assert_eq!(paged[1]["_count"]["orders"].as_i64(), Some(1));

    // Explicit take=0 in nested include yields an empty slice rather than unlimited rows
    let zero_take = users
        .find_many(&FindManyArgs {
            order_by: Some(json!({ "id": "asc" })),
            include: Some(json!({ "orders": { "take": 0 } })),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(zero_take[0]["orders"].as_array().unwrap().is_empty());
    assert!(zero_take[1]["orders"].as_array().unwrap().is_empty());

    // Strict validation errors (even when parent query returns 0 rows)
    assert!(users
        .find_many(&FindManyArgs {
            take: -1,
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            skip: -1,
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "id": "nonexistent" })),
            include: Some(json!({ "orders": { "take": -1 } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "orders": { "take": 1.5 } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "unknownRel": true })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "orders": { "bogus": true } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "_count": { "select": { "missing": true } } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(orders
        .find_many(&FindManyArgs {
            include: Some(json!({ "_count": { "select": { "user": true } } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "_count": { "select": { "orders": { "take": 1 } } } })),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(users
        .find_many(&FindManyArgs {
            include: Some(json!({ "_count": { "select": { "orders": true }, "extra": true } })),
            ..Default::default()
        })
        .await
        .is_err());
}
