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

/// Field metadata for a model, if present.
pub fn get_fields_for_model(model: &str) -> Option<serde_json::Value> {
    model_fields_store().read().ok().and_then(|s| s.get(model).cloned())
}

/// Relations declared for a model.
pub fn get_relations_for_model(model: &str) -> HashMap<String, RelationDef> {
    relation_map_store()
        .read()
        .ok()
        .and_then(|s| s.get(model).cloned())
        .unwrap_or_default()
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
