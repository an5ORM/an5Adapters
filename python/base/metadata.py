from typing import Any, Dict, List, Optional

model_to_table: Dict[str, str] = {}
model_fields: Dict[str, Any] = {}
relation_map: Dict[str, Dict[str, Dict[str, str]]] = {}

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
    if model_name in model_to_table or model_name in model_fields:
        return model_name
    camel = model_name[0].lower() + model_name[1:]
    if camel in model_to_table or camel in model_fields:
        return camel
    lower = model_name.lower()
    if lower in model_to_table or lower in model_fields:
        return lower
    return model_name


def get_relations_for_model(model_name: str) -> Dict[str, Dict[str, str]]:
    return relation_map.get(model_name) or relation_map.get(resolve_model_key(model_name)) or {}

def get_model_to_table() -> Dict[str, str]:
    return dict(model_to_table)

def get_fields_for_model(model_name: str) -> Any:
    key = resolve_model_key(model_name)
    if key in model_fields:
        return model_fields[key]
    return model_fields.get(model_name)
