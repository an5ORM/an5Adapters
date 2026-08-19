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

def get_relations_for_model(model_name: str) -> Dict[str, Dict[str, str]]:
    return relation_map.get(model_name) or {}

def get_model_to_table() -> Dict[str, str]:
    return dict(model_to_table)

def get_fields_for_model(model_name: str) -> Any:
    return model_fields.get(model_name)
