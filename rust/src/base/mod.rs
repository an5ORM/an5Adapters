//! Shared building blocks for the AN5 Rust adapter.
//!
//! Mirrors the Go `an5adapters/base` package: dialect handling, adapter
//! metadata and WHERE / ORDER BY construction.

pub mod dialect;
pub mod metadata;
pub mod vectors;
pub mod where_builder;

pub use dialect::{
    cosine_similarity, dot_product, euclidean_distance, vector_distance, Dialect,
};
pub use metadata::{
    add_table_override, get_fields_for_model, get_model_to_table, get_relations_for_model,
    resolve_table, set_adapter_metadata, AdapterMetadata, RelationDef,
};
pub use vectors::{
    decode_vector, decode_vector_bytes, distance_function, encode_vector, is_vector_field,
    needs_vector_encoding, normalize_metric, parse_vector, plan_vector_strategies,
    AN5_VECTOR_FUNCTIONS, SQLITE_VEC_FUNCTIONS, STRATEGY_MEMORY, STRATEGY_SQL, STRATEGY_SQLITE_VEC,
    STRATEGY_UDF,
};
pub use where_builder::{build_order_by, build_where, SqlArg, Where};
