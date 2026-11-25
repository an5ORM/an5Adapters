//! Adapter metadata injected by the generated `an5Client` crate.
//!
//! Mirrors the Go `an5adapters/base` metadata store.

#[cfg(test)]
pub(crate) static TEST_METADATA_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// Describes a model relation, used for eager-loading (`include`) support.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelationDef {
    pub model_name: String,
    /// `many` or `one`.
    pub relation_type: String,
    pub foreign_key: String,
    pub local_key: String,
}

/// Metadata bundle provided by the generated client.
#[derive(Debug, Clone, Default)]
pub struct AdapterMetadata {
    pub model_to_table: HashMap<String, String>,
    pub model_fields: HashMap<String, serde_json::Value>,
    pub relation_map: HashMap<String, HashMap<String, RelationDef>>,
}

static MODEL_TO_TABLE: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
static MODEL_FIELDS: OnceLock<RwLock<HashMap<String, serde_json::Value>>> = OnceLock::new();
static RELATION_MAP: OnceLock<RwLock<HashMap<String, HashMap<String, RelationDef>>>> = OnceLock::new();
static TABLE_OVERRIDES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

fn table_overrides_store() -> &'static RwLock<HashMap<String, String>> {
    TABLE_OVERRIDES.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Point a model alias at a different physical table.
pub fn add_table_override(model: &str, table: &str) {
    if let Ok(mut store) = table_overrides_store().write() {
        store.insert(model.to_string(), table.to_string());
    }
}

fn model_to_table_store() -> &'static RwLock<HashMap<String, String>> {
    MODEL_TO_TABLE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn model_fields_store() -> &'static RwLock<HashMap<String, serde_json::Value>> {
    MODEL_FIELDS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn relation_map_store() -> &'static RwLock<HashMap<String, HashMap<String, RelationDef>>> {
    RELATION_MAP.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Store metadata provided by the generated client. Call once at startup.
pub fn set_adapter_metadata(meta: AdapterMetadata) {
    if let Ok(mut store) = model_to_table_store().write() {
        *store = meta.model_to_table;
    }
    if let Ok(mut store) = model_fields_store().write() {
        *store = meta.model_fields;
    }
    if let Ok(mut store) = relation_map_store().write() {
        *store = meta.relation_map;
    }
}

/// Read-only snapshot of the model-to-table mapping.
pub fn get_model_to_table() -> HashMap<String, String> {
    model_to_table_store()
        .read()
        .map(|s| s.clone())
        .unwrap_or_default()
}

/// Convert camelCase/PascalCase identifier to snake_case (matches RustGenerator).
pub fn to_snake_case(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 4);
    for (i, &ch) in chars.iter().enumerate() {
        if i > 0 && ch.is_ascii_uppercase() {
            let prev = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(|c| c.is_ascii_lowercase());
            if prev.is_ascii_lowercase()
                || prev.is_ascii_digit()
                || (prev.is_ascii_uppercase() && next_is_lower)
            {
                out.push('_');
            }
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

fn find_case_insensitive<'a, V: Clone>(
    map: &'a HashMap<String, V>,
    key: &str,
) -> Option<V> {
    if let Some(v) = map.get(key) {
        return Some(v.clone());
    }
    let snake = to_snake_case(key);
    if let Some(v) = map.get(&snake) {
        return Some(v.clone());
    }
    let lower = key.to_lowercase();
    for (k, v) in map {
        if k.to_lowercase() == lower {
            return Some(v.clone());
        }
    }
    None
}

/// Field metadata for a model, if present.
pub fn get_fields_for_model(model: &str) -> Option<serde_json::Value> {
    model_fields_store()
        .read()
        .ok()
        .and_then(|s| find_case_insensitive(&s, model))
}

/// Relations declared for a model.
pub fn get_relations_for_model(model: &str) -> HashMap<String, RelationDef> {
    relation_map_store()
        .read()
        .ok()
        .and_then(|s| find_case_insensitive(&s, model))
        .unwrap_or_default()
}

/// Look up a relation by exact key or its snake_case alias.
pub fn resolve_relation_for_model(model: &str, key: &str) -> Option<(String, RelationDef)> {
    let rels = get_relations_for_model(model);
    if rels.is_empty() {
        return None;
    }
    if let Some(def) = rels.get(key) {
        return Some((key.to_string(), def.clone()));
    }
    for (rel_name, def) in rels {
        if to_snake_case(&rel_name) == key {
            return Some((rel_name, def));
        }
    }
    None
}

pub fn model_has_fields_metadata(model: &str) -> bool {
    get_fields_for_model(model).is_some_and(|v| match v {
        serde_json::Value::Object(m) => !m.is_empty(),
        serde_json::Value::Array(a) => !a.is_empty(),
        _ => false,
    })
}

pub fn model_has_field(model: &str, col: &str) -> bool {
    let Some(fields) = get_fields_for_model(model) else {
        return false;
    };
    let target_snake = to_snake_case(col);
    match fields {
        serde_json::Value::Object(map) => map
            .keys()
            .any(|k| k == col || to_snake_case(k) == target_snake),
        serde_json::Value::Array(items) => items.iter().any(|item| {
            item.get("name")
                .and_then(|v| v.as_str())
                .is_some_and(|n| n == col || to_snake_case(n) == target_snake)
        }),
        _ => false,
    }
}

/// Resolve `(child_col, parent_col)` for a relation filter or eager-load.
pub fn resolve_relation_keys(parent_model: &str, rel: &RelationDef) -> (String, String) {
    let raw_fk = if rel.foreign_key.is_empty() {
        "id"
    } else {
        rel.foreign_key.as_str()
    };
    let raw_lk = if rel.local_key.is_empty() {
        "id"
    } else {
        rel.local_key.as_str()
    };
    if rel.relation_type == "many" {
        return (raw_fk.to_string(), raw_lk.to_string());
    }
    // Generated relation_map puts foreign_key on the referencing model (parent)
    // and local_key on the referenced model (child). Hand-written fixtures may
    // reverse them to match sql.ts; disambiguate via model_fields when present.
    if (model_has_field(&rel.model_name, raw_fk) && !model_has_field(&rel.model_name, raw_lk))
        || (model_has_field(parent_model, raw_lk) && !model_has_field(parent_model, raw_fk))
    {
        return (raw_fk.to_string(), raw_lk.to_string());
    }
    (raw_lk.to_string(), raw_fk.to_string())
}

/// Resolve the physical table for a model, honouring overrides, then the
/// generated mapping, then a case-insensitive match, then the input itself.
pub fn resolve_table(model: &str) -> String {
    let lower = model.to_lowercase();
    // Overrides win over the generated mapping, and both match
    // case-insensitively so `with_table("User", ..)` also covers `db.table("user")`.
    if let Ok(store) = table_overrides_store().read() {
        if let Some(t) = store.get(model) {
            return t.clone();
        }
        for (k, v) in store.iter() {
            if k.to_lowercase() == lower {
                return v.clone();
            }
        }
    }
    if let Ok(store) = model_to_table_store().read() {
        if let Some(t) = store.get(model) {
            return t.clone();
        }
        for (k, v) in store.iter() {
            if k.to_lowercase() == lower {
                return v.clone();
            }
        }
    }
    model.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_table_with_case_fallback() {
        let mut map = HashMap::new();
        map.insert("User".to_string(), "[dbo].[Users]".to_string());
        let _guard = TEST_METADATA_LOCK.lock().unwrap();
        set_adapter_metadata(AdapterMetadata {
            model_to_table: map,
            ..Default::default()
        });
        assert_eq!(resolve_table("User"), "[dbo].[Users]");
        assert_eq!(resolve_table("user"), "[dbo].[Users]");
        assert_eq!(resolve_table("Missing"), "Missing");
    }
}
