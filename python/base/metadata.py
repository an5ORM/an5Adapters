from typing import Any, Dict

model_to_table: Dict[str, str] = {}
model_fields: Dict[str, Any] = {}

def set_adapter_metadata(metadata: Dict[str, Any]) -> None:
    global model_to_table, model_fields
    model_to_table = dict(metadata.get("model_to_table") or metadata.get("modelToTable") or {})
    model_fields = dict(metadata.get("model_fields") or metadata.get("modelFields") or {})
