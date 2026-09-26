//! WHERE and ORDER BY builders for the AN5 Rust adapter.
//!
//! Accepts the same ORM-style `serde_json::Value` payloads as the Go and
//! TypeScript adapters, so `{"name": {"contains": "Jo"}}` behaves the same
//! everywhere.

use serde_json::{Map, Value};

use super::dialect::Dialect;

/// Comparison operators understood inside a filter object.
const OPERATOR_KEYS: [&str; 12] = [
    "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt",
    "lt", "mode",
];

/// A bound SQL argument.
pub type SqlArg = serde_json::Value;

/// Accumulated SQL fragment plus its ordered bind arguments.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Where {
    pub clause: String,
    pub args: Vec<SqlArg>,
}

impl Where {
    pub fn is_empty(&self) -> bool {
        self.clause.is_empty()
    }
}

fn is_operator_map(v: &Value) -> bool {
    match v.as_object() {
        Some(m) => OPERATOR_KEYS.iter().any(|k| m.contains_key(*k)),
        None => false,
    }
}

fn as_object(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn is_list(v: &Value) -> bool {
    v.is_array()
}

fn to_list(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

fn to_string_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Flattens relation-style nested where objects (`user` -> `{email: ...}`).
fn clean_where(where_obj: &Map<String, Value>) -> Map<String, Value> {
    let mut clean = Map::new();
    for (k, v) in where_obj {
        if k.contains('_') {
            match as_object(v) {
                Some(inner) if !is_operator_map(v) => {
                    for (nk, nv) in inner {
                        clean.insert(nk.clone(), nv.clone());
                    }
                }
                _ => {
                    clean.insert(k.clone(), v.clone());
                }
            }
        } else {
            clean.insert(k.clone(), v.clone());
        }
    }
    clean
}

/// Build a WHERE clause with 1-based placeholders from `ph`.
pub fn build_where(where_obj: &Value, dialect: Dialect, ph: &dyn Fn(usize) -> String) -> Where {
    let mut out = Where::default();
    if let Some(obj) = as_object(where_obj) {
        let cleaned = clean_where(obj);
        out.clause = build_where_rec(&cleaned, dialect, &mut out.args, ph);
    }
    out
}

fn build_where_rec(
    where_obj: &Map<String, Value>,
    dialect: Dialect,
    args: &mut Vec<SqlArg>,
    ph: &dyn Fn(usize) -> String,
) -> String {
    if where_obj.is_empty() {
        return String::new();
    }
    let mut conditions: Vec<String> = Vec::new();

    // Deterministic key order so the generated SQL is stable.
    let mut keys: Vec<&String> = where_obj.keys().collect();
    keys.sort();

    for key in keys {
        let value = &where_obj[key];

        match key.as_str() {
            "AND" | "OR" if is_list(value) => {
                let joiner = if key == "AND" { " AND " } else { " OR " };
                let mut subs: Vec<String> = Vec::new();
                for item in to_list(value) {
                    if let Some(m) = as_object(&item) {
                        let s = build_where_rec(m, dialect, args, ph);
                        if !s.is_empty() {
                            subs.push(s);
                        }
                    }
                }
                if !subs.is_empty() {
                    conditions.push(format!("({})", subs.join(joiner)));
                }
                continue;
            }
            "NOT" => {
                let mut subs: Vec<String> = Vec::new();
                for item in to_list(value) {
                    if let Some(m) = as_object(&item) {
                        let s = build_where_rec(m, dialect, args, ph);
                        if !s.is_empty() {
                            subs.push(s);
                        }
                    }
                }
                if !subs.is_empty() {
                    conditions.push(format!("NOT ({})", subs.join(" AND ")));
                }
                continue;
            }
            "AND" | "OR" => continue,
            _ => {}
        }

        conditions.extend(build_field_condition(key, value, dialect, args, ph));
    }

    conditions.join(" AND ")
}

fn build_field_condition(
    key: &str,
    value: &Value,
    dialect: Dialect,
    args: &mut Vec<SqlArg>,
    ph: &dyn Fn(usize) -> String,
) -> Vec<String> {
    let col = dialect.quote_identifier(key);

    if value.is_null() {
        return vec![format!("{} IS NULL", col)];
    }

    let map = match as_object(value) {
        Some(m) => m,
        None => {
            let p = push_arg(args, value.clone(), ph);
            return vec![format!("{} = {}", col, p)];
        }
    };

    let mut parts: Vec<String> = Vec::new();
    let mut op_keys: Vec<&String> = map.keys().collect();
    op_keys.sort();

    for op in op_keys {
        let val = &map[op];
        let p = |args: &mut Vec<SqlArg>| push_arg(args, val.clone(), ph);
        match op.as_str() {
            "not" => {
                if val.is_null() {
                    parts.push(format!("{} IS NOT NULL", col));
                } else if is_operator_map(val) {
                    let mut nested = Map::new();
                    nested.insert(key.to_string(), val.clone());
                    let cond = build_where_rec(&nested, dialect, args, ph);
                    if !cond.is_empty() {
                        parts.push(format!("NOT ({})", cond));
                    }
                } else {
                    let phs = p(args);
                    parts.push(format!("{} <> {}", col, phs));
                }
            }
            "equals" => {
                if val.is_null() {
                    parts.push(format!("{} IS NULL", col));
                } else {
                    let phs = p(args);
                    parts.push(format!("{} = {}", col, phs));
                }
            }
            "contains" => {
                let phs = p(args);
                parts.push(format!("{} LIKE {}", col, phs));
                wrap_last_arg(args, |a| format!("%{}%", to_string_value(a)));
            }
            "startsWith" => {
                let phs = p(args);
                parts.push(format!("{} LIKE {}", col, phs));
                wrap_last_arg(args, |a| format!("{}%", to_string_value(a)));
            }
            "endsWith" => {
                let phs = p(args);
                parts.push(format!("{} LIKE {}", col, phs));
                wrap_last_arg(args, |a| format!("%{}", to_string_value(a)));
            }
            "gte" => {
                let phs = p(args);
                parts.push(format!("{} >= {}", col, phs));
            }
            "lte" => {
                let phs = p(args);
                parts.push(format!("{} <= {}", col, phs));
            }
            "gt" => {
                let phs = p(args);
                parts.push(format!("{} > {}", col, phs));
            }
            "lt" => {
                let phs = p(args);
                parts.push(format!("{} < {}", col, phs));
            }
            "in" => {
                let items = to_list(val);
                if items.is_empty() {
                    parts.push("1=0".to_string());
                } else {
                    let phs: Vec<String> = items
                        .iter()
                        .map(|it| push_arg(args, it.clone(), ph))
                        .collect();
                    parts.push(format!("{} IN ({})", col, phs.join(", ")));
                }
            }
            "notIn" => {
                let items = to_list(val);
                if items.is_empty() {
                    parts.push("1=1".to_string());
                } else {
                    let phs: Vec<String> = items
                        .iter()
                        .map(|it| push_arg(args, it.clone(), ph))
                        .collect();
                    parts.push(format!("{} NOT IN ({})", col, phs.join(", ")));
                }
            }
            // `mode: "insensitive"` is accepted and ignored: collation is a
            // database concern, matching the Go adapter's tolerance.
            _ => {}
        }
    }

    parts
}

fn push_arg(args: &mut Vec<SqlArg>, value: SqlArg, ph: &dyn Fn(usize) -> String) -> String {
    let n = args.len() + 1;
    args.push(value);
    ph(n)
}

/// Rewrites the most recently pushed arg, used by the LIKE operators which need
/// to wrap the value in wildcards after the placeholder has been allocated.
fn wrap_last_arg(args: &mut Vec<SqlArg>, f: impl Fn(&SqlArg) -> String) {
    if let Some(last) = args.last_mut() {
        let wrapped = f(last);
        *last = Value::String(wrapped);
    }
}

fn normalize_sort_direction(dir: &Value) -> &'static str {
    match dir.as_str() {
        Some(s) if s.eq_ignore_ascii_case("desc") => "DESC",
        _ => "ASC",
    }
}

/// Build an ORDER BY clause from a map, list of maps, or raw string.
pub fn build_order_by(order_by: &Value, dialect: Dialect) -> String {
    let mut entries: Vec<&Map<String, Value>> = Vec::new();

    match order_by {
        Value::String(s) => {
            if s.trim().is_empty() {
                return String::new();
            }
            return format!("ORDER BY {}", s);
        }
        Value::Array(items) => {
            for item in items {
                if let Some(m) = as_object(item) {
                    entries.push(m);
                }
            }
        }
        Value::Object(m) => entries.push(m),
        _ => return String::new(),
    }

    let mut parts: Vec<String> = Vec::new();
    for entry in entries {
        let mut keys: Vec<&String> = entry.keys().collect();
        keys.sort();
        for key in keys {
            parts.push(format!(
                "{} {}",
                dialect.quote_identifier(key),
                normalize_sort_direction(&entry[key])
            ));
        }
    }

    if parts.is_empty() {
        return String::new();
    }
    format!("ORDER BY {}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn q(n: usize) -> String {
        format!("?{}", n)
    }

    #[test]
    fn equality_produces_placeholder() {
        let w = build_where(&json!({ "id": "abc" }), Dialect::Mssql, &q);
        assert_eq!(w.clause, "[id] = ?1");
        assert_eq!(w.args, vec![json!("abc")]);
    }

    #[test]
    fn null_uses_is_null() {
        let w = build_where(&json!({ "name": null }), Dialect::Mssql, &q);
        assert_eq!(w.clause, "[name] IS NULL");
        assert!(w.args.is_empty());
    }

    #[test]
    fn contains_wraps_wildcards() {
        let w = build_where(
            &json!({ "email": { "contains": "@example.com" } }),
            Dialect::Mssql,
            &q,
        );
        assert_eq!(w.clause, "[email] LIKE ?1");
        assert_eq!(w.args, vec![json!("%@example.com%")]);
    }

    #[test]
    fn in_expands_each_item() {
        let w = build_where(
            &json!({ "status": { "in": ["a", "b"] } }),
            Dialect::Mssql,
            &q,
        );
        assert_eq!(w.clause, "[status] IN (?1, ?2)");
        assert_eq!(w.args, vec![json!("a"), json!("b")]);
    }

    #[test]
    fn postgres_placeholders_are_numbered() {
        let ph = |n: usize| format!("${}", n);
        let w = build_where(&json!({ "id": "x" }), Dialect::Postgres, &ph);
        assert_eq!(w.clause, "\"id\" = $1");
    }

    #[test]
    fn or_blocks_are_grouped() {
        let w = build_where(
            &json!({ "OR": [{ "a": 1 }, { "b": 2 }] }),
            Dialect::Mssql,
            &q,
        );
        assert_eq!(w.clause, "([a] = ?1 OR [b] = ?2)");
    }

    #[test]
    fn order_by_defaults_to_asc() {
        let sql = build_order_by(&json!({ "name": "desc" }), Dialect::Mssql);
        assert_eq!(sql, "ORDER BY [name] DESC");
        let sql = build_order_by(&json!({ "name": "anything" }), Dialect::Mssql);
        assert_eq!(sql, "ORDER BY [name] ASC");
    }
}
