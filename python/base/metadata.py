import re
from typing import Any, Dict, List, Optional

model_to_table: Dict[str, str] = {}
model_fields: Dict[str, Any] = {}
relation_map: Dict[str, Dict[str, Dict[str, str]]] = {}


def to_snake_case(name: str) -> str:
    """Convert camelCase/PascalCase identifier to snake_case (matches PythonGenerator)."""
    if not name:
        return ""
    s1 = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s1).lower()


def _model_key_candidates(model_name: str) -> List[str]:
    if not model_name:
        return []
    candidates = [
        model_name,
        model_name[0].lower() + model_name[1:],
        to_snake_case(model_name),
        model_name.lower(),
    ]
    seen: List[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.append(c)
    return seen


def set_adapter_metadata(metadata: Dict[str, Any]) -> None:
    model_to_table.clear()
    model_to_table.update(metadata.get("model_to_table") or metadata.get("modelToTable") or {})
    model_fields.clear()
    model_fields.update(metadata.get("model_fields") or metadata.get("modelFields") or {})
    relation_map.clear()
    rels = metadata.get("relation_map") or metadata.get("relationMap") or metadata.get("RELATION_MAP") or {}
    if isinstance(rels, dict):
        for model, relations in rels.items():
            if not isinstance(relations, dict):
                continue
            relation_map[model] = {}
            for key, defn in relations.items():
                if isinstance(defn, dict):
                    relation_map[model][key] = {
                        "modelName": defn.get("modelName") or defn.get("model_name") or "",
                        "relationType": defn.get("relationType") or defn.get("relation_type") or "many",
                        "foreignKey": defn.get("foreignKey") or defn.get("foreign_key") or "",
                        "localKey": defn.get("localKey") or defn.get("local_key") or "",
                    }

def resolve_model_key(model_name: str) -> str:
    """The model name in the metadata, accepting a different capitalisation.

    The generated client registers tables under their PascalCase name
    (`CatalogType`) while the metadata keys them camelCase/snake_case
    (`catalogType`, `catalog_type`). A plain lookup would find no columns at all
    and silently skip `isId` — that is, never generate the primary key.
    """
    if not model_name:
        return model_name
    for candidate in _model_key_candidates(model_name):
        if candidate in model_to_table or candidate in model_fields or candidate in relation_map:
            return candidate
    return model_name


def get_relations_for_model(model_name: str) -> Dict[str, Dict[str, str]]:
    for candidate in _model_key_candidates(model_name):
        if candidate in relation_map:
            return relation_map[candidate]
    return {}

def get_model_to_table() -> Dict[str, str]:
    return dict(model_to_table)

def get_fields_for_model(model_name: str) -> Any:
    for candidate in _model_key_candidates(model_name):
        if candidate in model_fields:
            return model_fields[candidate]
    return None


def get_field_map_for_model(model_name: str) -> Dict[str, str]:
    """Map schema field names and their snake_case aliases to canonical schema field names."""
    fields = get_fields_for_model(model_name)
    if not isinstance(fields, list):
        return {}
    names = [f["name"] for f in fields if isinstance(f, dict) and f.get("name")]
    mapping: Dict[str, str] = {}
    for name in names:
        mapping[to_snake_case(name)] = name
    for name in names:
        mapping[name] = name
    return mapping


def resolve_field_name(model_name: str, key: str, strict: bool = False) -> str:
    """Resolve a query/write key (schema name or snake_case alias) to the schema field name."""
    field_map = get_field_map_for_model(model_name)
    if not field_map:
        return key
    if key in field_map:
        return field_map[key]
    if strict:
        available = ", ".join(sorted(set(field_map.values())))
        raise ValueError(
            f"Unknown field '{key}' for model '{model_name}'. Available fields: {available}"
        )
    return key


def resolve_relation_key(model_name: str, key: str) -> Optional[str]:
    """Resolve a relation key (exact name or snake_case alias) to the schema relation name."""
    relations = get_relations_for_model(model_name)
    if not relations:
        return None
    if key in relations:
        return key
    for rel_name in relations:
        if to_snake_case(rel_name) == key:
            return rel_name
    return None
