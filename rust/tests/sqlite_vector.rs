//! SQLite vector search, end to end against a real database.
//!
//! `sqlx` connects through a pooled `AnyPool` and offers no way to register a SQL
//! function or load an extension, so this exercises the two strategies a stock
//! Rust adapter can reach: `json_each` in plain SQL for a JSON text column, and
//! scoring in Rust for a float32 BLOB column. The module docstring in
//! `src/base/vectors.rs` is the shared specification every runtime implements;
//! test/sqlite-vector.test.js (TypeScript) is the mirror of this coverage.

use an5_adapters::{
    blob_value, AdapterMetadata, An5Adapter, FindManyArgs, RowMap, UpdateArgs, VectorSearchArgs,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Once;

static DRIVER: Once = Once::new();

struct TempDb(PathBuf);

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.0.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}

fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::SeqCst)
}

/// Opens a `documents` table whose `VECTOR(n)` column is declared `declared` and
/// filled by `store`.
async fn documents(declared: &str, store: &str) -> (An5Adapter, TempDb) {
    DRIVER.call_once(|| {
        sqlx::any::install_drivers(&[sqlx::sqlite::any::DRIVER]).expect("install sqlite driver");
    });

    let path = std::env::temp_dir().join(format!(
        "an5-rust-vector-{}-{}.sqlite",
        std::process::id(),
        next_id()
    ));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite:file:{}?mode=rwc", path.display());
    let guard = TempDb(path);

    let db = An5Adapter::connect(&url).await.expect("connect");
    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([
            ("document".to_string(), "documents".to_string()),
            ("documents".to_string(), "documents".to_string()),
        ]),
        model_fields: HashMap::from([(
            "documents".to_string(),
            json!({
                "id": { "ts": "string", "sql": "TEXT", "isId": true },
                "title": { "ts": "string", "sql": "TEXT" },
                "embedding": { "ts": "number[] | string", "sql": "VECTOR(3)" },
            }),
        )]),
        ..Default::default()
    });
    db.set_metadata(AdapterMetadata {
        model_to_table: HashMap::from([
            ("document".to_string(), "documents".to_string()),
            ("documents".to_string(), "documents".to_string()),
        ]),
        model_fields: HashMap::from([
            ("documents".to_string(), db_fields()),
            ("document".to_string(), db_fields()),
        ]),
        ..Default::default()
    });

    db.execute_raw(
        &format!(
            "CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding {declared})"
        ),
        &[],
    )
    .await
    .expect("create documents table");

    for (id, vector) in [
        ("d1", vec![1.0, 0.0, 0.0]),
        ("d2", vec![0.8, 0.2, 0.0]),
        ("d3", vec![0.0, 1.0, 0.0]),
    ] {
        let value = match store {
            "blob" => Value::from(encode_blob(&vector)),
            _ => Value::from(
                serde_json::to_string(&vector).expect("serialise the vector as JSON text"),
            ),
        };
        db.execute_raw(
            "INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)",
            &[
                Value::from(id),
                Value::from(format!("doc {id}")),
                value,
            ],
        )
        .await
        .expect("insert document");
    }
    // A row with another dimension must never rank against a 3-dimension query,
    // and one with no vector at all must not win by default.
    db.execute_raw(
        "INSERT INTO documents (id, title, embedding) VALUES ('d4', 'wrong size', ?)",
        &[if store == "blob" { encode_blob(&[1.0, 0.0, 0.0, 1.0]) } else { Value::from("[1,0,0,1]") }],
    )
    .await
    .expect("insert the wrong-size row");
    db.execute_raw(
        "INSERT INTO documents (id, title, embedding) VALUES ('d5', 'no vector', NULL)",
        &[],
    )
    .await
    .expect("insert the empty row");

    (db, guard)
}

fn db_fields() -> Value {
    json!({
        "id": { "ts": "string", "sql": "TEXT", "isId": true },
        "title": { "ts": "string", "sql": "TEXT" },
        "embedding": { "ts": "number[] | string", "sql": "VECTOR(3)" },
    })
}

/// The row-model value that writes a vector as a real float32 BLOB.
fn encode_blob(values: &[f64]) -> serde_json::Value {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&(*value as f32).to_le_bytes());
    }
    blob_value(&bytes)
}

fn ids(rows: &[RowMap]) -> String {
    rows.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(",")
}

async fn search(db: &An5Adapter, take: i64) -> Vec<RowMap> {
    db.table("documents")
        .vector_search(&VectorSearchArgs {
            vector: vec![1.0, 0.0, 0.0],
            take,
            vector_field: "embedding".to_string(),
            distance_metric: "cosine".to_string(),
            ..Default::default()
        })
        .await
        .expect("vector_search")
}

#[tokio::test]
async fn json_each_ranks_a_text_column() {
    let (db, _guard) = documents("TEXT", "json").await;

    for metric in ["cosine", "euclidean", "dot"] {
        let rows = db
            .table("documents")
            .vector_search(&VectorSearchArgs {
                vector: vec![1.0, 0.0, 0.0],
                take: 9,
                vector_field: "embedding".to_string(),
                distance_metric: metric.to_string(),
                ..Default::default()
            })
            .await
            .expect("vector_search");
        assert_eq!(ids(&rows), "d1,d2,d3", "metric {metric}");
        assert!(rows.iter().all(|row| row.get("distance").is_some()));
    }
}

#[tokio::test]
async fn in_memory_ranking_reads_a_blob_column() {
    let (db, _guard) = documents("BLOB", "blob").await;
    let rows = search(&db, 9).await;
    assert_eq!(ids(&rows), "d1,d2,d3");
    assert_eq!(
        rows[0].get("distance").and_then(Value::as_f64),
        Some(0.0)
    );
}

#[tokio::test]
async fn a_pinned_strategy_is_honoured() {
    let (mut db, _guard) = documents("TEXT", "json").await;
    // The same rows, ranked in Rust instead of by json_each.
    db.vector_strategy = Some("memory".to_string());
    let rows = search(&db, 9).await;
    assert_eq!(ids(&rows), "d1,d2,d3");
}

#[tokio::test]
async fn a_where_filter_applies() {
    let (db, _guard) = documents("TEXT", "json").await;
    let rows = db
        .table("documents")
        .vector_search(&VectorSearchArgs {
            vector: vec![1.0, 0.0, 0.0],
            take: 9,
            r#where: Some(json!({ "id": { "in": ["d1", "d3"] } })),
            vector_field: "embedding".to_string(),
            distance_metric: "cosine".to_string(),
            ..Default::default()
        })
        .await
        .expect("vector_search");
    let mut got = ids(&rows);
    got = got.split(',').map(str::to_string).collect::<Vec<_>>().join(",");
    let mut want = vec!["d1", "d3"];
    want.sort();
    assert_eq!(got, want.join(","));
}

#[tokio::test]
async fn a_vector_column_round_trips() {
    let (db, _guard) = documents("BLOB", "blob").await;
    let client = db.table("documents");

    let mut data = RowMap::new();
    data.insert("id".to_string(), Value::from("d9"));
    data.insert("title".to_string(), Value::from("written"));
    data.insert("embedding".to_string(), json!([0.25, 0.5, 1.0]));
    let inserted = client.create(&data).await.expect("create");

    // The inserted row has to come back decoded, not as the blob envelope the
    // database stores: a generated model typed `Option<Vec<f32>>` fails to
    // deserialize a map.
    let returned = inserted
        .get("embedding")
        .and_then(Value::as_array)
        .expect("the created row returns the vector as an array of numbers");
    assert_eq!(returned.len(), 3);
    assert!((returned[0].as_f64().unwrap() - 0.25).abs() < 1e-6);

    // A float64 array is written as a BLOB, so the column stays compact.
    let stored: Vec<RowMap> = db
        .query_raw(
            "SELECT typeof(embedding) AS stored_type FROM documents WHERE id = 'd9'",
            &[],
        )
        .await
        .expect("read back the column type");
    assert_eq!(
        stored[0].get("stored_type").and_then(Value::as_str),
        Some("blob")
    );

    let rows = client
        .find_many(&FindManyArgs::default())
        .await
        .expect("find_many");
    let written = rows
        .iter()
        .find(|row| row.get("id").and_then(Value::as_str) == Some("d9"))
        .expect("the written row");
    let vector = written
        .get("embedding")
        .and_then(Value::as_array)
        .expect("the vector reads back as an array of numbers");
    assert_eq!(vector.len(), 3);
    assert!((vector[0].as_f64().unwrap() - 0.25).abs() < 1e-6);

    client
        .update(&UpdateArgs {
            r#where: Some(json!({ "id": "d1" })),
            data: json!({ "embedding": [0.5, 0.5, 0.0] }),
        })
        .await
        .expect("update");
    let updated = client
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "id": "d1" })),
            ..Default::default()
        })
        .await
        .expect("find_many");
    assert_eq!(
        updated[0].get("embedding").and_then(Value::as_array).map(Vec::len),
        Some(3)
    );

    // A row written as JSON text by an older version still reads as numbers.
    let (text_db, _text_guard) = documents("TEXT", "json").await;
    let rows = text_db
        .table("documents")
        .find_many(&FindManyArgs {
            r#where: Some(json!({ "id": "d1" })),
            ..Default::default()
        })
        .await
        .expect("find_many");
    let vector = rows[0]
        .get("embedding")
        .and_then(Value::as_array)
        .expect("legacy JSON text decodes to an array");
    assert_eq!(vector.len(), 3);
}
