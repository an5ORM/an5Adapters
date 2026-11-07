from typing import Any, Dict, List, Optional
from .dialects import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE
from .metadata import model_to_table, model_fields, resolve_model_key, get_relations_for_model

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


def _parse_relation_filter(model_name: str, relation: Dict[str, str], value: Any, params: Dict, dialect: str, prefix: str = "", self_ref: str = "") -> Optional[str]:
    if not isinstance(value, dict) or not relation:
        return None
    child_table = _quote_table(_resolve_table(relation.get("modelName", "")), dialect)
    child_alias = f"r_{_sanitize_param_name(prefix)}"
    fk = _quote(relation.get("foreignKey", "id"), dialect)
    lk = _quote(relation.get("localKey", "id"), dialect)

    parent_ref = f"{self_ref}." if self_ref else f"{_quote_table(_resolve_table(model_name), dialect)}."
    correlation = f"{child_alias}.{fk} = {parent_ref}{lk}"

    def build_exists(inner_where: str) -> str:
        inner = f" AND ({inner_where})" if inner_where else ""
        return f"EXISTS (SELECT 1 FROM {child_table} AS {child_alias} WHERE {correlation}{inner})"

    parts: List[str] = []
    is_many = relation.get("relationType") == "many"

    if is_many:
        if "some" in value and value["some"] is not None:
            inner = _parse_where(relation.get("modelName", ""), value["some"], params, dialect, f"{prefix}some_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            parts.append(build_exists(inner))
        if "none" in value and value["none"] is not None:
            inner = _parse_where(relation.get("modelName", ""), value["none"], params, dialect, f"{prefix}none_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            parts.append(f"NOT {build_exists(inner)}")
        if "every" in value and value["every"] is not None:
            inner = _parse_where(relation.get("modelName", ""), value["every"], params, dialect, f"{prefix}every_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            negated = f"NOT ({inner})" if inner else ""
            violated = f"EXISTS (SELECT 1 FROM {child_table} AS {child_alias} WHERE {correlation}{f' AND {negated}' if negated else ' AND 1=0'})"
            parts.append(f"NOT {violated}")
    else:
        if "is" in value:
            if value["is"] is None:
                parts.append(f"NOT {build_exists('')}")
            else:
                inner = _parse_where(relation.get("modelName", ""), value["is"], params, dialect, f"{prefix}is_", self_ref=child_alias, col_prefix=f"{child_alias}.")
                parts.append(build_exists(inner))
        if "isNot" in value:
            if value["isNot"] is None:
                parts.append(build_exists(''))
            else:
                inner = _parse_where(relation.get("modelName", ""), value["isNot"], params, dialect, f"{prefix}isNot_", self_ref=child_alias, col_prefix=f"{child_alias}.")
                parts.append(f"NOT {build_exists(inner)}")

    return " AND ".join(parts) if parts else None


def _parse_where(model_name: str, where: Optional[Dict], params: Dict, dialect: str, prefix: str = "", self_ref: str = "", col_prefix: str = "") -> str:
    if not where:
        return ""
    conditions: List[str] = []

    clean_where: Dict[str, Any] = {}
    for key, value in where.items():
        if "_" in key and isinstance(value, dict) and not _is_operator_value(value):
            clean_where.update(value)
        else:
            clean_where[key] = value

    model_relations = get_relations_for_model(model_name)

    for key, value in clean_where.items():
        if key == "OR" and isinstance(value, list):
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}or{i}_", self_ref=self_ref, col_prefix=col_prefix) or "1=1" for i, v in enumerate(value)]
            conditions.append(f"({' OR '.join(sub)})" if sub else "1=0")
        elif key == "AND":
            items = value if isinstance(value, list) else [value]
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}and{i}_", self_ref=self_ref, col_prefix=col_prefix) for i, v in enumerate(items)]
            sub = [s for s in sub if s]
            if sub:
                conditions.append(f"({' AND '.join(sub)})")
        elif key == "NOT":
            items = value if isinstance(value, list) else [value]
            sub = [_parse_where(model_name, v, params, dialect, f"{prefix}not{i}_", self_ref=self_ref, col_prefix=col_prefix) or "1=1" for i, v in enumerate(items)]
            if sub:
                conditions.append(f"NOT ({' OR '.join(sub)})")
        elif key in model_relations and isinstance(value, dict) and any(k in value for k in ("some", "none", "every", "is", "isNot")):
            rel_sql = _parse_relation_filter(model_name, model_relations[key], value, params, dialect, f"{prefix}{key}_", self_ref=self_ref)
            if rel_sql:
                conditions.append(rel_sql)
        else:
            col = f"{col_prefix}{_quote(key, dialect)}"
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
    key = resolve_model_key(model_name)
    if key in model_to_table:
        return model_to_table[key]
    return model_name


def _split_qualified(t: str) -> List[str]:
    """Splits `schema.table` without cutting a dot that sits inside brackets.

    The generated metadata is always MSSQL-shaped: `[dbo].[users]`. A plain
    `split(".")` yields `['[dbo]', '[users]']` — right for MSSQL, but moving to
    PostgreSQL/SQLite means stripping the old brackets and re-quoting for the
    target dialect, otherwise `[dbo].[users]` stays as-is and the table name
    comes out wrong.
    """
    parts: List[str] = []
    buf: List[str] = []
    open_ch = ""
    close_ch = ""
    for ch in t:
        if open_ch:
            buf.append(ch)
            if ch == close_ch:
                open_ch = ""
                close_ch = ""
            continue
        if ch in ("[", '"'):
            open_ch, close_ch = ch, ("]" if ch == "[" else '"')
            buf.append(ch)
            continue
        if ch == ".":
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return [p for p in parts if p]


def _quote_table(t: str, dialect: str) -> str:
    # Never return an already bracketed `[...]` name as-is: that quoting is only
    # correct on MSSQL. Other dialects have to strip it and re-quote, or the
    # previous dialect's brackets follow the name into the new dialect.
    parts = _split_qualified(str(t))
    if dialect == DIALECT_SQLITE and len(parts) == 2 and _strip_wrapping(_strip_wrapping(parts[0], "[", "]"), '"', '"').lower() == "dbo":
        parts = parts[1:]
    if not parts:
        parts = [str(t)]
    return ".".join(_quote(p, dialect) for p in parts)

