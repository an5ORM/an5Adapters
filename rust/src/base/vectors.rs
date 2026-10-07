//! SQLite vector codec, distance and strategy plan.
//!
//! SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of little-endian
//! float32 values. The ranking itself is built in [`crate::adapter`] from these
//! helpers.
//!
//! The strategies, in the order every runtime tries them:
//!
//! 1. `sqlite-vec` — the extension, when it loads.
//! 2. `udf` — `an5_vec_cosine` / `an5_vec_l2` / `an5_vec_ip` registered with the driver.
//! 3. `sql` — `json_each` brute force in plain SQL.
//! 4. `memory` — the column is loaded and scored in Rust.
//!
//! `sqlx` connects through a pooled `AnyPool` and offers no way to register a SQL
//! function or load an extension, so a stock Rust adapter reaches `sql` and
//! `memory`. That is enough to rank in the database; the first two need a driver
//! built for it.

use std::collections::HashMap;

use serde_json::Value;

/// The size of one stored value; a column's byte length is its dimension times this.
pub const BYTES_PER_VECTOR_FLOAT: usize = 4;

pub const STRATEGY_SQLITE_VEC: &str = "sqlite-vec";
pub const STRATEGY_UDF: &str = "udf";
pub const STRATEGY_SQL: &str = "sql";
pub const STRATEGY_MEMORY: &str = "memory";

/// Scalar functions the adapter registers itself, when the driver allows it.
pub const AN5_VECTOR_FUNCTIONS: [(&str, &str); 3] = [
    ("cosine", "an5_vec_cosine"),
    ("euclidean", "an5_vec_l2"),
    ("dot", "an5_vec_ip"),
];

/// Scalar functions the sqlite-vec extension provides.
pub const SQLITE_VEC_FUNCTIONS: [(&str, &str); 3] = [
    ("cosine", "vec_distance_cosine"),
    ("euclidean", "vec_distance_l2"),
    ("dot", "vec_distance_ip"),
];

/// Returns a known metric name, defaulting to cosine.
pub fn normalize_metric(metric: &str) -> &str {
    match metric.to_lowercase().as_str() {
        "euclidean" | "dot" => metric,
        _ => "cosine",
    }
}

/// Returns the function name a strategy uses for a metric.
pub fn distance_function(strategy: &str, metric: &str) -> Option<&'static str> {
    let table = match strategy {
        STRATEGY_SQLITE_VEC => &SQLITE_VEC_FUNCTIONS,
        STRATEGY_UDF => &AN5_VECTOR_FUNCTIONS,
        _ => return None,
    };
    let metric = normalize_metric(metric);
    table
        .iter()
        .find(|(name, _)| *name == metric)
        .map(|(_, function)| *function)
}

/// Encodes a vector as the little-endian float32 BLOB the column stores.
pub fn encode_vector(values: &[f64]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * BYTES_PER_VECTOR_FLOAT);
    for value in values {
        bytes.extend_from_slice(&(*value as f32).to_le_bytes());
    }
    bytes
}

/// Reads a numeric sequence, or JSON text holding one.
pub fn parse_vector(value: &Value) -> Option<Vec<f64>> {
    match value {
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(item.as_f64()?);
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Value::String(text) => parse_vector_text(text),
        _ => None,
    }
}

/// Parses the JSON text a legacy `VECTOR(n)` column holds.
pub fn parse_vector_text(raw: &str) -> Option<Vec<f64>> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    match serde_json::from_str::<Vec<f64>>(trimmed) {
        Ok(values) if !values.is_empty() => Some(values),
        _ => None,
    }
}

/// Decodes a stored vector: a float32 BLOB, a legacy JSON text column, or an
/// array the driver already decoded.
pub fn decode_vector(value: &Value) -> Option<Vec<f64>> {
    if let Some(bytes) = crate::adapter::blob_bytes(value) {
        return decode_vector_bytes(&bytes);
    }
    if let Some(text) = value.as_str() {
        return parse_vector_text(text);
    }
    parse_vector(value)
}

/// Decodes the float32 BLOB a `VECTOR(n)` column stores.
///
/// A column written by an older version holds JSON text instead, which is not a
/// multiple of four bytes once encoded, so the length check tells them apart.
pub fn decode_vector_bytes(bytes: &[u8]) -> Option<Vec<f64>> {
    if bytes.is_empty() || bytes.len() % BYTES_PER_VECTOR_FLOAT != 0 || bytes[0] == b'[' {
        return parse_vector_text(&String::from_utf8_lossy(bytes));
    }
    Some(
        bytes
            .chunks_exact(BYTES_PER_VECTOR_FLOAT)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64)
            .collect(),
    )
}

/// True when the value still has to become bytes on its way into a column.
pub fn needs_vector_encoding(value: &Value) -> bool {
    value.is_array() || value.is_string()
}

/// True when generated metadata describes a `VECTOR(n)` column.
///
/// The metadata value is either the declared SQL type as a string or a record with
/// `sql` / `ts` / `kind` members, so both shapes are accepted.
pub fn is_vector_field(definition: &Value) -> bool {
    match definition {
        Value::String(text) => {
            text.contains("[]") || text.trim().to_uppercase().starts_with("VECTOR")
        }
        Value::Object(map) => {
            if map.get("kind").and_then(Value::as_str) == Some("vector") {
                return true;
            }
            for key in ["sql", "type"] {
                if let Some(sql) = map.get(key).and_then(Value::as_str) {
                    if sql_looks_vector(sql) {
                        return true;
                    }
                }
            }
            map.get("ts")
                .and_then(Value::as_str)
                .map(|ts| ts.contains("[]"))
                .unwrap_or(false)
        }
        _ => false,
    }
}

/// True when a declared SQL type names a vector column.
fn sql_looks_vector(sql: &str) -> bool {
    let trimmed = sql.trim().to_uppercase();
    match trimmed.strip_prefix("VECTOR") {
        None => false,
        Some(rest) => rest.is_empty() || rest.starts_with('(') || rest.starts_with(' '),
    }
}

/// The ordered strategies to try for this connection.
///
/// `declared_type` is the column's DDL type: the JSON strategy only reaches rows
/// stored as text, so a `BLOB` column drops it from the order. `preference` pins a
/// strategy instead of probing.
pub fn plan_vector_strategies(
    capabilities: &HashMap<&str, bool>,
    declared_type: Option<&str>,
    preference: Option<&str>,
) -> Vec<&'static str> {
    if let Some(preference) = preference.filter(|p| !p.is_empty() && *p != "auto") {
        // `memory` is the caller's own path, not a query, so it yields no plan.
        return match preference {
            STRATEGY_MEMORY => Vec::new(),
            STRATEGY_SQLITE_VEC => vec![STRATEGY_SQLITE_VEC],
            STRATEGY_UDF => vec![STRATEGY_UDF],
            _ => vec![STRATEGY_SQL],
        };
    }

    let mut available: Vec<&'static str> = Vec::new();
    if capabilities.get("vec").copied().unwrap_or(false) {
        available.push(STRATEGY_SQLITE_VEC);
    }
    if capabilities.get("udf").copied().unwrap_or(false) {
        available.push(STRATEGY_UDF);
    }
    if capabilities.get("json1").copied().unwrap_or(false) {
        available.push(STRATEGY_SQL);
    }

    let declared = declared_type.unwrap_or_default().trim().to_uppercase();
    if !declared.is_empty()
        && !["TEXT", "CHAR", "CLOB", "STRING", "JSON"]
            .iter()
            .any(|token| declared.contains(token))
    {
        // A BLOB column has no JSON to read, so json_each could only produce NULLs.
        available.retain(|strategy| *strategy != STRATEGY_SQL);
    }
    available
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_little_endian_float32() {
        let bytes = encode_vector(&[1.0, -2.0, 0.5]);
        assert_eq!(bytes.len(), 12);
        assert_eq!(&bytes[0..4], &[0x00, 0x00, 0x80, 0x3f]);
        assert_eq!(&bytes[4..8], &[0x00, 0x00, 0x00, 0xc0]);
    }

    #[test]
    fn round_trips_a_blob() {
        assert_eq!(decode_vector_bytes(&encode_vector(&[0.25, -0.5, 3.0])), Some(vec![0.25, -0.5, 3.0]));
    }

    #[test]
    fn reads_the_legacy_json_text_column() {
        assert_eq!(decode_vector(&Value::from("[1, 0, 0]")), Some(vec![1.0, 0.0, 0.0]));
        assert_eq!(decode_vector_bytes(b"[1, 0, 0]"), Some(vec![1.0, 0.0, 0.0]));
        assert_eq!(decode_vector(&Value::from("[1, 2]")), Some(vec![1.0, 2.0]));
    }

    #[test]
    fn rejects_values_it_cannot_read() {
        assert!(decode_vector(&Value::Null).is_none());
        assert!(decode_vector(&Value::from("not json")).is_none());
        assert!(decode_vector_bytes(&[1, 2, 3]).is_none());
        assert!(decode_vector_bytes(&[]).is_none());
    }

    #[test]
    fn recognises_vector_columns() {
        assert!(is_vector_field(&serde_json::json!({ "ts": "number[] | string", "sql": "VECTOR(3)" })));
        assert!(is_vector_field(&serde_json::json!({ "ts": "number[] | string" })));
        assert!(is_vector_field(&serde_json::json!({ "kind": "vector" })));
        assert!(is_vector_field(&Value::from("number[] | string")));
        assert!(!is_vector_field(&serde_json::json!({ "ts": "string", "sql": "TEXT" })));
        assert!(!is_vector_field(&Value::Null));
    }

    #[test]
    fn plans_the_strategies_in_order() {
        let all = HashMap::from([("vec", true), ("udf", true), ("json1", true)]);
        assert_eq!(
            plan_vector_strategies(&all, Some("BLOB"), None),
            vec![STRATEGY_SQLITE_VEC, STRATEGY_UDF]
        );
        let json_only = HashMap::from([("json1", true)]);
        assert_eq!(plan_vector_strategies(&json_only, Some("TEXT"), None), vec![STRATEGY_SQL]);
        // A BLOB column has no JSON to read.
        assert!(plan_vector_strategies(&json_only, Some("BLOB"), None).is_empty());
        assert!(plan_vector_strategies(&HashMap::new(), Some("TEXT"), None).is_empty());
        assert_eq!(plan_vector_strategies(&all, Some("BLOB"), Some("udf")), vec![STRATEGY_UDF]);
        assert!(plan_vector_strategies(&all, Some("BLOB"), Some("memory")).is_empty());
    }

    #[test]
    fn maps_each_metric_to_its_function() {
        assert_eq!(distance_function(STRATEGY_UDF, "cosine"), Some("an5_vec_cosine"));
        assert_eq!(distance_function(STRATEGY_UDF, "euclidean"), Some("an5_vec_l2"));
        assert_eq!(distance_function(STRATEGY_UDF, "dot"), Some("an5_vec_ip"));
        assert_eq!(
            distance_function(STRATEGY_SQLITE_VEC, "cosine"),
            Some("vec_distance_cosine")
        );
        assert_eq!(distance_function(STRATEGY_SQL, "cosine"), None);
    }
}
