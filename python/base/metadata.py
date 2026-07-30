from typing import Any, Dict

model_to_table: Dict[str, str] = {}
model_fields: Dict[str, Any] = {}

def set_adapter_metadata(metadata: Dict[str, Any]) -> None:
    model_to_table.clear()
    model_to_table.update(metadata.get("model_to_table") or metadata.get("modelToTable") or {})
    model_fields.clear()
    model_fields.update(metadata.get("model_fields") or metadata.get("modelFields") or {})
