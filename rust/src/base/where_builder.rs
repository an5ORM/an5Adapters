//! WHERE and ORDER BY builders for the AN5 Rust adapter.
//!
//! Accepts the same ORM-style `serde_json::Value` payloads as the Go and
//! TypeScript adapters, so `{"name": {"contains": "Jo"}}` behaves the same
//! everywhere.

use serde_json::{Map, Value};

use super::dialect::Dialect;
use super::metadata::{
    model_has_field, model_has_fields_metadata, resolve_relation_for_model, resolve_relation_keys,
    resolve_table, RelationDef,
};

/// Comparison operators understood inside a filter object.
const OPERATOR_KEYS: [&str; 12] = [
    "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt",
    "lt", "mode",
];
const RELATION_MANY_KEYS: [&str; 3] = ["some", "none", "every"];
const RELATION_ONE_KEYS: [&str; 3] = ["is", "isNot", "is_not"];

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

fn is_relation_operator_map(v: &Value) -> bool {
    match v.as_object() {
        Some(m) => RELATION_MANY_KEYS
            .iter()
            .chain(RELATION_ONE_KEYS.iter())
            .any(|k| m.contains_key(*k)),
        None => false,
    }
}

fn as_object(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(m) => Some(m),
        _ => None,
    }
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

fn sanitize_alias(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
    {
        cleaned
    } else {
        format!("p_{}", cleaned)
    }
}

/// Flattens compound-key nested where objects (`id_score` -> `{id: ..., score: ...}`),
/// while leaving relation filters and scalar operator maps intact.
fn clean_where(where_obj: &Map<String, Value>, model_name: &str) -> Map<String, Value> {
    let mut clean = Map::new();
    let has_fields = !model_name.is_empty() && model_has_fields_metadata(model_name);
    for (k, v) in where_obj {
        if k.contains('_')
            && (model_name.is_empty()
                || (!model_has_field(model_name, k)
                    && resolve_relation_for_model(model_name, k).is_none()))
        {
            match as_object(v) {
                Some(inner)
                    if !inner.is_empty()
                        && !is_operator_map(v)
                        && !is_relation_operator_map(v)
                        && (!has_fields || inner.keys().all(|sk| model_has_field(model_name, sk))) =>
                {
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
    build_where_with_model(where_obj, "", dialect, ph)
}

/// Build a WHERE clause with model metadata for relation filtering.
pub fn build_where_with_model(
    where_obj: &Value,
    model_name: &str,
    dialect: Dialect,
    ph: &dyn Fn(usize) -> String,
) -> Where {
    try_build_where_with_model(where_obj, model_name, dialect, ph).unwrap_or_default()
}

/// Fallible WHERE builder that validates scalar and relation filter operators.
pub fn try_build_where_with_model(
    where_obj: &Value,
    model_name: &str,
    dialect: Dialect,
    ph: &dyn Fn(usize) -> String,
) -> std::result::Result<Where, String> {
    let mut out = Where::default();
    if let Some(obj) = as_object(where_obj) {
        let cleaned = clean_where(obj, model_name);
        out.clause = build_where_rec(&cleaned, model_name, dialect, &mut out.args, ph, "", "", "")?;
    }
    Ok(out)
}

fn parse_relation_filter(
    model_name: &str,
    rel_name: &str,
    rel: &RelationDef,
    value: &Value,
    dialect: Dialect,
    args: &mut Vec<SqlArg>,
    ph: &dyn Fn(usize) -> String,
    prefix: &str,
    self_ref: &str,
) -> std::result::Result<String, String> {
    let map = as_object(value).ok_or_else(|| {
        format!(
            "relation filter for '{}' on '{}' must be a filter object",
            rel_name, model_name
        )
    })?;

    let is_many = rel.relation_type == "many";
    let mut normalized = Map::new();
    for (k, v) in map {
        let canonical = match k.as_str() {
            "is_not" => "isNot",
            other => other,
        };
        let allowed = if is_many {
            RELATION_MANY_KEYS.contains(&canonical)
        } else {
            canonical == "is" || canonical == "isNot"
        };
        if !allowed {
            return Err(format!(
                "unsupported relation filter operator '{}' for relation '{}'",
                k, rel_name
            ));
        }
        normalized.insert(canonical.to_string(), v.clone());
    }

    let child_table = dialect.quote_table(&resolve_table(&rel.model_name));
    let child_alias = format!("r_{}", sanitize_alias(prefix));
    let (child_key, parent_key) = resolve_relation_keys(model_name, rel);
    let child_col = dialect.quote_identifier(&child_key);
    let parent_col = dialect.quote_identifier(&parent_key);
    let parent_ref = if self_ref.is_empty() {
        format!("{}.", dialect.quote_table(&resolve_table(model_name)))
    } else {
        format!("{}.", self_ref)
    };
    let correlation = format!("{}.{} = {}{}", child_alias, child_col, parent_ref, parent_col);

    let build_exists = |inner_where: &str| -> String {
        let inner = if inner_where.is_empty() {
            String::new()
        } else {
            format!(" AND ({})", inner_where)
        };
        format!(
            "EXISTS (SELECT 1 FROM {} AS {} WHERE {}{})",
            child_table, child_alias, correlation, inner
        )
    };

    let child_prefix = format!("{}.", child_alias);
    let mut parts: Vec<String> = Vec::new();

    if is_many {
        if let Some(some_val) = normalized.get("some") {
            if !some_val.is_null() {
                let inner_obj = as_object(some_val).ok_or_else(|| {
                    format!("'some' filter on relation '{}' must be an object", rel_name)
                })?;
                let inner = build_where_rec(
                    &clean_where(inner_obj, &rel.model_name),
                    &rel.model_name,
                    dialect,
                    args,
                    ph,
                    &format!("{}some_", prefix),
                    &child_alias,
                    &child_prefix,
                )?;
                parts.push(build_exists(&inner));
            }
        }
        if let Some(none_val) = normalized.get("none") {
            if !none_val.is_null() {
                let inner_obj = as_object(none_val).ok_or_else(|| {
                    format!("'none' filter on relation '{}' must be an object", rel_name)
                })?;
                let inner = build_where_rec(
                    &clean_where(inner_obj, &rel.model_name),
                    &rel.model_name,
                    dialect,
                    args,
                    ph,
                    &format!("{}none_", prefix),
                    &child_alias,
                    &child_prefix,
                )?;
                parts.push(format!("NOT {}", build_exists(&inner)));
            }
        }
        if let Some(every_val) = normalized.get("every") {
            if !every_val.is_null() {
                let inner_obj = as_object(every_val).ok_or_else(|| {
                    format!("'every' filter on relation '{}' must be an object", rel_name)
                })?;
                let inner = build_where_rec(
                    &clean_where(inner_obj, &rel.model_name),
                    &rel.model_name,
                    dialect,
                    args,
                    ph,
                    &format!("{}every_", prefix),
                    &child_alias,
                    &child_prefix,
                )?;
                let violated_where = if inner.is_empty() {
                    " AND 1=0".to_string()
                } else {
                    format!(" AND NOT ({})", inner)
                };
                let violated = format!(
                    "EXISTS (SELECT 1 FROM {} AS {} WHERE {}{})",
                    child_table, child_alias, correlation, violated_where
                );
                parts.push(format!("NOT {}", violated));
            }
        }
    } else {
        if let Some(is_val) = normalized.get("is") {
            if is_val.is_null() {
                parts.push(format!("NOT {}", build_exists("")));
            } else {
                let inner_obj = as_object(is_val).ok_or_else(|| {
                    format!("'is' filter on relation '{}' must be an object or null", rel_name)
                })?;
                let inner = build_where_rec(
                    &clean_where(inner_obj, &rel.model_name),
                    &rel.model_name,
                    dialect,
                    args,
                    ph,
                    &format!("{}is_", prefix),
                    &child_alias,
                    &child_prefix,
                )?;
                parts.push(build_exists(&inner));
            }
        }
        if let Some(is_not_val) = normalized.get("isNot") {
            if is_not_val.is_null() {
                parts.push(build_exists(""));
            } else {
                let inner_obj = as_object(is_not_val).ok_or_else(|| {
                    format!(
                        "'isNot' filter on relation '{}' must be an object or null",
                        rel_name
                    )
                })?;
                let inner = build_where_rec(
                    &clean_where(inner_obj, &rel.model_name),
                    &rel.model_name,
                    dialect,
                    args,
                    ph,
                    &format!("{}isNot_", prefix),
                    &child_alias,
                    &child_prefix,
                )?;
                parts.push(format!("NOT {}", build_exists(&inner)));
            }
        }
    }

    Ok(parts.join(" AND "))
}

fn build_where_rec(
    where_obj: &Map<String, Value>,
    model_name: &str,
    dialect: Dialect,
    args: &mut Vec<SqlArg>,
    ph: &dyn Fn(usize) -> String,
    prefix: &str,
    self_ref: &str,
    col_prefix: &str,
) -> std::result::Result<String, String> {
    if where_obj.is_empty() {
        return Ok(String::new());
    }
    let mut conditions: Vec<String> = Vec::new();

    // Deterministic key order so the generated SQL is stable.
    let mut keys: Vec<&String> = where_obj.keys().collect();
    keys.sort();

    for key in keys {
        let value = &where_obj[key];

        match key.as_str() {
            "AND" | "OR" | "NOT" => {
                let mut subs: Vec<String> = Vec::new();
                for (i, item) in to_list(value).into_iter().enumerate() {
                    if let Some(m) = as_object(&item) {
                        let sub_prefix = format!("{}{}{}_", prefix, key, i);
                        let s = build_where_rec(
                            &clean_where(m, model_name),
                            model_name,
                            dialect,
                            args,
                            ph,
                            &sub_prefix,
                            self_ref,
                            col_prefix,
                        )?;
                        subs.push(if s.is_empty() { "1=1".to_string() } else { s });
                    }
                }
                if subs.is_empty() {
                    if key == "OR" {
                        conditions.push("1=0".to_string());
                    }
                } else {
                    let joiner = if key == "AND" { " AND " } else { " OR " };
                    let negation = if key == "NOT" { "NOT " } else { "" };
                    conditions.push(format!("{}({})", negation, subs.join(joiner)));
                }
                continue;
            }
            _ => {}
        }

        if !model_name.is_empty() {
            if let Some((rel_name, rel_def)) = resolve_relation_for_model(model_name, key) {
                let rel_prefix = format!("{}{}_", prefix, rel_name);
                let rel_sql = parse_relation_filter(
                    model_name,
                    &rel_name,
                    &rel_def,
                    value,
                    dialect,
                    args,
                    ph,
                    &rel_prefix,
                    self_ref,
                )?;
                if !rel_sql.is_empty() {
                    conditions.push(rel_sql);
                }
                continue;
            }
        }

        conditions.extend(build_field_condition(
            key,
            value,
            model_name,
            dialect,
            args,
            ph,
            prefix,
            self_ref,
            col_prefix,
        )?);
    }

    Ok(conditions.join(" AND "))
}

fn build_field_condition(
    key: &str,
    value: &Value,
    model_name: &str,
    dialect: Dialect,
    args: &mut Vec<SqlArg>,
    ph: &dyn Fn(usize) -> String,
    prefix: &str,
    self_ref: &str,
    col_prefix: &str,
) -> std::result::Result<Vec<String>, String> {
    let col = format!("{}{}", col_prefix, dialect.quote_identifier(key));

    if value.is_null() {
        return Ok(vec![format!("{} IS NULL", col)]);
    }

    let map = match as_object(value) {
        Some(m) => m,
        None => {
            let p = push_arg(args, value.clone(), ph);
            return Ok(vec![format!("{} = {}", col, p)]);
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
                } else if val.is_object() {
                    let mut nested = Map::new();
                    nested.insert(key.to_string(), val.clone());
                    let cond = build_where_rec(
                        &nested,
                        model_name,
                        dialect,
                        args,
                        ph,
                        &format!("{}{}_not_", prefix, key),
                        self_ref,
                        col_prefix,
                    )?;
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
            "mode" => {}
            unknown => {
                return Err(format!(
                    "unsupported filter operator '{}' for field '{}'",
                    unknown, key
                ));
            }
        }
    }

    Ok(parts)
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

    fn setup_relation_metadata() {
        use super::super::metadata::{set_adapter_metadata, AdapterMetadata, RelationDef};
        use std::collections::HashMap;
        set_adapter_metadata(AdapterMetadata {
            model_to_table: HashMap::from([
                ("user".to_string(), "users".to_string()),
                ("order".to_string(), "orders".to_string()),
            ]),
            model_fields: HashMap::from([
                ("user".to_string(), json!({ "id": {}, "email": {} })),
                ("order".to_string(), json!({ "id": {}, "userId": {}, "total": {} })),
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
    }

    #[test]
    fn builds_relation_filters_and_validates_operators() {
        use super::super::metadata::{set_adapter_metadata, AdapterMetadata, RelationDef, TEST_METADATA_LOCK};
        use std::collections::HashMap;
        let _guard = TEST_METADATA_LOCK.lock().unwrap();
        setup_relation_metadata();

        let w = try_build_where_with_model(
            &json!({ "orders": { "some": { "total": { "not": { "lt": 50 } } } } }),
            "User",
            Dialect::Sqlite,
            &q,
        )
        .unwrap();
        assert!(w.clause.contains("EXISTS (SELECT 1 FROM \"orders\" AS r_orders_ WHERE r_orders_.\"user_id\" = \"users\".\"id\""));
        assert!(w.clause.contains("NOT (r_orders_.\"total\" < ?1)"));
        assert_eq!(w.args, vec![json!(50)]);

        let w_one = try_build_where_with_model(
            &json!({ "user": { "is": { "email": "alice@example.com" }, "is_not": null } }),
            "Order",
            Dialect::Sqlite,
            &q,
        )
        .unwrap();
        assert!(w_one.clause.contains("EXISTS (SELECT 1 FROM \"users\" AS r_user_ WHERE r_user_.\"id\" = \"orders\".\"user_id\" AND (r_user_.\"email\" = ?1))"));
        assert!(w_one.clause.contains("EXISTS (SELECT 1 FROM \"users\" AS r_user_ WHERE r_user_.\"id\" = \"orders\".\"user_id\")"));

        // Rejects unknown scalar and mismatched/unknown relation operators
        assert!(try_build_where_with_model(&json!({ "email": { "badOp": "x" } }), "User", Dialect::Sqlite, &q).is_err());
        assert!(try_build_where_with_model(&json!({ "user_id": { "badOp": "x" } }), "Order", Dialect::Sqlite, &q).is_err());
        assert!(try_build_where_with_model(&json!({ "orders": { "is": { "total": 10 } } }), "User", Dialect::Sqlite, &q).is_err());
        assert!(try_build_where_with_model(&json!({ "user": { "some": { "email": "x" } } }), "Order", Dialect::Sqlite, &q).is_err());

        // Reversed sql.ts-style to-one metadata (foreign_key="id", local_key="user_id")
        set_adapter_metadata(AdapterMetadata {
            model_to_table: HashMap::from([
                ("user".to_string(), "users".to_string()),
                ("order".to_string(), "orders".to_string()),
            ]),
            model_fields: HashMap::from([
                ("user".to_string(), json!({ "id": {}, "email": {} })),
                ("order".to_string(), json!({ "id": {}, "user_id": {}, "total": {} })),
            ]),
            relation_map: HashMap::from([(
                "order".to_string(),
                HashMap::from([(
                    "user".to_string(),
                    RelationDef {
                        model_name: "user".to_string(),
                        relation_type: "one".to_string(),
                        foreign_key: "id".to_string(),
                        local_key: "user_id".to_string(),
                    },
                )]),
            )]),
        });
        let w_rev = try_build_where_with_model(&json!({ "user": { "is": { "id": "u1" } } }), "Order", Dialect::Sqlite, &q).unwrap();
        assert!(w_rev.clause.contains("r_user_.\"id\" = \"orders\".\"user_id\""));

        set_adapter_metadata(AdapterMetadata::default());
    }
}
