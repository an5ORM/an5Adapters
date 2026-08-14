from typing import Any, Dict, List, Optional
from .dialects import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE
from .metadata import model_to_table, model_fields

# ─── Quoting ───────────────────────────────────────────────────────────────────────

def _strip_wrapping(name: str, left: str, right: str) -> str:
    return name[len(left):-len(right)] if name.startswith(left) and name.endswith(right) else name


def _quote(name: str, dialect: str) -> str:
    raw = str(name)
    if dialect in (DIALECT_POSTGRES, DIALECT_SQLITE):
        unwrapped = _strip_wrapping(_strip_wrapping(raw, "[", "]"), '"', '"')
        return f'"{unwrapped.replace(chr(34), chr(34) * 2)}"'
    unwrapped = _strip_wrapping(raw, "[", "]")
    return f"[{unwrapped.replace(']', ']]')}]"


def _sanitize_param_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(name))
    return cleaned if cleaned[:1].isalpha() else f"p_{cleaned}"


def _normalize_sort_direction(direction: Any) -> str:
    return "DESC" if isinstance(direction, str) and direction.upper() == "DESC" else "ASC"


# ─── Connection helpers live in provider modules ────────────────────────────────

# ─── Where clause builder ──────────────────────────────────────────────────────────

_OPERATOR_KEYS = {"equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt"}


def _is_operator_value(value: Any) -> bool:
    return isinstance(value, dict) and any(op in value for op in _OPERATOR_KEYS)


def _parse_where(model_name: str, where: Optional[Dict], params: Dict, dialect: str, prefix: str = "") -> str:
    if not where:
        return ""
    conditions: List[str] = []

    clean_where: Dict[str, Any] = {}
    for key, value in where.items():
        if "_" in key and isinstance(value, dict) and not _is_operator_value(value):
            clean_where.update(value)
        else:
            clean_where[key] = value

    for key, value in clean_where.items():
        if key == "OR" and isinstance(value, list):
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}or{i}_") for i, v in enumerate(value)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"({' OR '.join(sub)})")
        elif key == "AND":
            items = value if isinstance(value, list) else [value]
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}and{i}_") for i, v in enumerate(items)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"({' AND '.join(sub)})")
        elif key == "NOT":
            items = value if isinstance(value, list) else [value]
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}not{i}_") for i, v in enumerate(items)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"NOT ({' AND '.join(sub)})")
        else:
            col = _quote(key, dialect)
            pname = _sanitize_param_name(f"{prefix}{key}")
            placeholder = "%s" if dialect == DIALECT_POSTGRES else "?"
            if value is None:
                conditions.append(f"{col} IS NULL")
            elif isinstance(value, dict):
                if "not" in value:
                    if value["not"] is None:
                        conditions.append(f"{col} IS NOT NULL")
                    elif isinstance(value["not"], dict):
                        nested_params: Dict[str, Any] = {}
                        nested_sql = _parse_where(model_name, {key: value["not"]}, nested_params, dialect, f"{prefix}{key}_not_")
                        params.update(nested_params)
                        if nested_sql:
                            conditions.append(f"NOT ({nested_sql})")
                    else:
                        params[f"{pname}_not"] = value["not"]
                        conditions.append(f"{col} <> {placeholder}")
                if "equals" in value:
                    if value["equals"] is None:
                        conditions.append(f"{col} IS NULL")
                    else:
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
                if "notIn" in value:
                    vals = value["notIn"]
                    if vals:
                        placeholders = ", ".join([placeholder] * len(vals))
                        for i, v in enumerate(vals):
                            params[f"{pname}_notin{i}"] = v
                        conditions.append(f"{col} NOT IN ({placeholders})")
                    else:
                        conditions.append("1=1")
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
            parts.append(f"{_quote(col, dialect)} {_normalize_sort_direction(direction)}")
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
    if t.startswith("[") or t.startswith('"'):
        return t
    if "." in t:
        return ".".join(_quote(p, dialect) for p in t.split("."))
    return _quote(t, dialect)

