from typing import Any, Dict, List, Optional
from .dialects import DIALECT_MSSQL, DIALECT_POSTGRES
from .metadata import model_to_table, model_fields

# ─── Quoting ───────────────────────────────────────────────────────────────────────

def _quote(name: str, dialect: str) -> str:
    if dialect == DIALECT_POSTGRES:
        if name.startswith("[") and name.endswith("]"):
            return f'"{name[1:-1]}"'
        return f'"{name}"'
    return name if name.startswith("[") else f"[{name}]"


# ─── Connection helpers live in provider modules ────────────────────────────────

# ─── Where clause builder ──────────────────────────────────────────────────────────

def _parse_where(model_name: str, where: Optional[Dict], params: Dict, dialect: str, prefix: str = "") -> str:
    if not where:
        return ""
    conditions: List[str] = []

    for key, value in where.items():
        if key == "OR" and isinstance(value, list):
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}or{i}_") for i, v in enumerate(value)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"({' OR '.join(sub)})")
        elif key == "AND" and isinstance(value, list):
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}and{i}_") for i, v in enumerate(value)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"({' AND '.join(sub)})")
        else:
            col = _quote(key, dialect)
            pname = f"{prefix}{key}"
            placeholder = "%s" if dialect == DIALECT_POSTGRES else "?"
            if value is None:
                conditions.append(f"{col} IS NULL")
            elif isinstance(value, dict):
                if "not" in value:
                    if value["not"] is None:
                        conditions.append(f"{col} IS NOT NULL")
                    else:
                        params[f"{pname}_not"] = value["not"]
                        conditions.append(f"{col} <> {placeholder}")
                if "equals" in value:
                    params[f"{pname}_eq"] = value["equals"]
                    conditions.append(f"{col} = {placeholder}")
                if "contains" in value:
                    params[f"{pname}_co"] = f"%{value['contains']}%"
                    conditions.append(f"{col} LIKE {placeholder}")
                if "startsWith" in value:
                    params[f"{pname}_sw"] = f"{value['startsWith']}%"
                    conditions.append(f"{col} LIKE {placeholder}")
                if "endsWith" in value:
                    params[f"{pname}_ew"] = f"%{value['endsWith']}"
                    conditions.append(f"{col} LIKE {placeholder}")
                if "gte" in value:
                    params[f"{pname}_gte"] = value["gte"]
                    conditions.append(f"{col} >= {placeholder}")
                if "lte" in value:
                    params[f"{pname}_lte"] = value["lte"]
                    conditions.append(f"{col} <= {placeholder}")
                if "gt" in value:
                    params[f"{pname}_gt"] = value["gt"]
                    conditions.append(f"{col} > {placeholder}")
                if "lt" in value:
                    params[f"{pname}_lt"] = value["lt"]
                    conditions.append(f"{col} < {placeholder}")
                if "in" in value:
                    vals = value["in"]
                    if vals:
                        placeholders = ", ".join([placeholder] * len(vals))
                        for i, v in enumerate(vals):
                            params[f"{pname}_in{i}"] = v
                        conditions.append(f"{col} IN ({placeholders})")
                    else:
                        conditions.append("1=0")
            else:
                params[pname] = value
                conditions.append(f"{col} = {placeholder}")

    return " AND ".join(conditions)


def _build_order_by(order_by: Any, dialect: str) -> str:
    if not order_by:
        return ""
    entries = order_by if isinstance(order_by, list) else [order_by]
    parts: List[str] = []
    for entry in entries:
        for col, direction in entry.items():
            parts.append(f"{_quote(col, dialect)} {str(direction).upper()}")
    return f"ORDER BY {', '.join(parts)}" if parts else ""


# ─── Table name resolution ─────────────────────────────────────────────────────────

def _resolve_table(model_name: str) -> str:
    if model_name in model_to_table:
        return model_to_table[model_name]
    camel = model_name[0].lower() + model_name[1:] if model_name else model_name
    if camel in model_to_table:
        return model_to_table[camel]
    lower = model_name.lower()
    if lower in model_to_table:
        return model_to_table[lower]
    return model_name


def _quote_table(t: str, dialect: str) -> str:
    q = lambda s: f'"{s}"' if dialect == DIALECT_POSTGRES else f"[{s}]"
    if t.startswith("[") or t.startswith('"'):
        return t
    if "." in t:
        return ".".join(q(p) for p in t.split("."))
    return q(t)


