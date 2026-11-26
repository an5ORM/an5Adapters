from dataclasses import fields as dc_fields, is_dataclass
from typing import Any, Dict, List, Optional
from .dialects import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE
from .metadata import (
    model_to_table,
    model_fields,
    resolve_model_key,
    get_relations_for_model,
    get_field_map_for_model,
    resolve_field_name,
    resolve_relation_key,
)

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


def _bind_param(params: Dict[str, Any], name: str, value: Any) -> str:
    """Allocate a unique parameter key in insertion order without overwriting siblings."""
    candidate = name
    suffix = 1
    while candidate in params:
        candidate = f"{name}_{suffix}"
        suffix += 1
    params[candidate] = value
    return candidate


def _format_pattern_condition(expr: str, placeholder: str, dialect: str, insensitive: bool) -> str:
    if not insensitive:
        return f"{expr} LIKE {placeholder}"
    if dialect == DIALECT_POSTGRES:
        return f"{expr} ILIKE {placeholder}"
    return f"LOWER({expr}) LIKE LOWER({placeholder})"


def _normalize_sort_direction(direction: Any) -> str:
    return "DESC" if isinstance(direction, str) and direction.upper() == "DESC" else "ASC"


# ─── Connection helpers live in provider modules ────────────────────────────────

# ─── Where clause builder ──────────────────────────────────────────────────────────

_OPERATOR_KEYS = {"equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt", "mode"}
_HAVING_AGGREGATES = {
    "_count": "COUNT",
    "_sum": "SUM",
    "_avg": "AVG",
    "_min": "MIN",
    "_max": "MAX",
}
_OPERATOR_ALIASES = {
    "not_": "not",
    "in_": "in",
    "not_in": "notIn",
    "starts_with": "startsWith",
    "ends_with": "endsWith",
}
_RELATION_MANY_KEYS = {"some", "none", "every"}
_RELATION_ONE_KEYS = {"is", "isNot"}
_RELATION_OPERATOR_ALIASES = {"is_not": "isNot", "is_": "is"}


def _is_dataclass_instance(value: Any) -> bool:
    return is_dataclass(value) and not isinstance(value, type)


def _normalize_dataclass_dict(value: Any) -> Any:
    """Convert generated filter/input dataclasses into plain dictionaries recursively.

    Unset (`None`) attributes on dataclasses and empty all-`None` nested filter
    dataclasses (e.g. `StringFilter()`) are omitted, while explicit `None` entries
    inside plain dicts are preserved for IS NULL / IS NOT NULL semantics.
    """
    if is_dataclass(value) and not isinstance(value, type):
        out: Dict[str, Any] = {}
        for f in dc_fields(value):
            raw_val = getattr(value, f.name)
            if raw_val is None:
                continue
            val = _normalize_dataclass_dict(raw_val)
            if is_dataclass(raw_val) and isinstance(val, dict) and not val:
                continue
            out[f.name] = val
        return out
    if isinstance(value, list):
        return [_normalize_dataclass_dict(item) for item in value]
    if isinstance(value, dict):
        return {k: _normalize_dataclass_dict(v) for k, v in value.items()}
    return value


def _is_operator_value(value: Any) -> bool:
    return isinstance(value, dict) and any(_OPERATOR_ALIASES.get(op, op) in _OPERATOR_KEYS for op in value)


def _is_relation_operator_value(value: Any) -> bool:
    return isinstance(value, dict) and any(
        _RELATION_OPERATOR_ALIASES.get(op, op) in (_RELATION_MANY_KEYS | _RELATION_ONE_KEYS)
        for op in value
    )


def _normalize_operator_dict(raw: Dict[str, Any], field_name: str) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for k, v in raw.items():
        canonical = _OPERATOR_ALIASES.get(k, k)
        normalized[canonical] = v
    unknown = [k for k in normalized if k not in _OPERATOR_KEYS]
    if unknown:
        raise ValueError(
            f"Unsupported filter operator(s) for '{field_name}': {', '.join(unknown)}"
        )
    return normalized


def _parse_relation_filter(model_name: str, relation: Dict[str, str], value: Any, params: Dict, dialect: str, prefix: str = "", self_ref: str = "") -> Optional[str]:
    if is_dataclass(value) and not isinstance(value, type):
        value = _normalize_dataclass_dict(value)
    if not isinstance(value, dict) or not relation:
        raise ValueError(f"Relation filter on '{model_name}' must be a mapping or filter object")

    normalized: Dict[str, Any] = {
        _RELATION_OPERATOR_ALIASES.get(k, k): v for k, v in value.items()
    }
    is_many = relation.get("relationType") == "many"
    allowed = _RELATION_MANY_KEYS if is_many else _RELATION_ONE_KEYS
    unknown = [k for k in normalized if k not in allowed]
    if unknown:
        raise ValueError(
            f"Unsupported relation filter operator(s): {', '.join(unknown)}"
        )

    child_table = _quote_table(_resolve_table(relation.get("modelName", "")), dialect)
    child_alias = f"r_{_sanitize_param_name(prefix)}"

    raw_fk = relation.get("foreignKey", "id")
    raw_lk = relation.get("localKey", "id")
    if is_many:
        child_key, parent_key = raw_fk, raw_lk
    else:
        # Generated RELATION_MAP records foreignKey on the referencing model (parent)
        # and localKey on the referenced model (child), matching _resolve_includes.
        # Hand-written fixtures may reverse them to match sql.ts; disambiguate via model_fields.
        parent_key, child_key = raw_fk, raw_lk
        parent_fields = get_field_map_for_model(model_name)
        child_fields = get_field_map_for_model(relation.get("modelName", ""))
        if (
            (child_fields and raw_fk in child_fields and raw_lk not in child_fields)
            or (parent_fields and raw_lk in parent_fields and raw_fk not in parent_fields)
        ):
            child_key, parent_key = raw_fk, raw_lk

    fk = _quote(child_key, dialect)
    lk = _quote(parent_key, dialect)

    parent_ref = f"{self_ref}." if self_ref else f"{_quote_table(_resolve_table(model_name), dialect)}."
    correlation = f"{child_alias}.{fk} = {parent_ref}{lk}"

    def build_exists(inner_where: str) -> str:
        inner = f" AND ({inner_where})" if inner_where else ""
        return f"EXISTS (SELECT 1 FROM {child_table} AS {child_alias} WHERE {correlation}{inner})"

    parts: List[str] = []

    if is_many:
        if "some" in normalized and normalized["some"] is not None:
            inner = _parse_where(relation.get("modelName", ""), normalized["some"], params, dialect, f"{prefix}some_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            parts.append(build_exists(inner))
        if "none" in normalized and normalized["none"] is not None:
            inner = _parse_where(relation.get("modelName", ""), normalized["none"], params, dialect, f"{prefix}none_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            parts.append(f"NOT {build_exists(inner)}")
        if "every" in normalized and normalized["every"] is not None:
            inner = _parse_where(relation.get("modelName", ""), normalized["every"], params, dialect, f"{prefix}every_", self_ref=child_alias, col_prefix=f"{child_alias}.")
            negated = f"NOT ({inner})" if inner else ""
            violated = f"EXISTS (SELECT 1 FROM {child_table} AS {child_alias} WHERE {correlation}{f' AND {negated}' if negated else ' AND 1=0'})"
            parts.append(f"NOT {violated}")
    else:
        if "is" in normalized:
            if normalized["is"] is None:
                parts.append(f"NOT {build_exists('')}")
            else:
                inner = _parse_where(relation.get("modelName", ""), normalized["is"], params, dialect, f"{prefix}is_", self_ref=child_alias, col_prefix=f"{child_alias}.")
                parts.append(build_exists(inner))
        if "isNot" in normalized:
            if normalized["isNot"] is None:
                parts.append(build_exists(''))
            else:
                inner = _parse_where(relation.get("modelName", ""), normalized["isNot"], params, dialect, f"{prefix}isNot_", self_ref=child_alias, col_prefix=f"{child_alias}.")
                parts.append(f"NOT {build_exists(inner)}")

    return " AND ".join(parts) if parts else None


def _build_expr_conditions(
    expr: str,
    field_label: str,
    value: Any,
    params: Dict[str, Any],
    dialect: str,
    param_base: str,
    nested_prefix: str = "",
) -> List[str]:
    if _is_dataclass_instance(value):
        value = _normalize_dataclass_dict(value)
    if isinstance(value, (list, tuple, set)):
        raise ValueError(f"Invalid collection filter value for field '{field_label}'; use {{'in': [...]}} instead")

    conditions: List[str] = []
    placeholder = "%s" if dialect == DIALECT_POSTGRES else "?"

    if value is None:
        conditions.append(f"{expr} IS NULL")
        return conditions

    if isinstance(value, dict):
        value = _normalize_operator_dict(value, field_label)
        if "mode" in value and value["mode"] is not None and value["mode"] not in ("default", "insensitive"):
            raise ValueError(
                f"Invalid filter mode '{value['mode']}' on field '{field_label}'; expected 'default' or 'insensitive'"
            )
        insensitive = value.get("mode") == "insensitive"

        if "not" in value:
            not_val = value["not"]
            if not_val is None:
                conditions.append(f"{expr} IS NOT NULL")
            elif isinstance(not_val, (list, tuple, set)):
                raise ValueError(f"Filter operator 'not' on field '{field_label}' cannot be a collection; use 'notIn' instead")
            elif isinstance(not_val, dict) or _is_dataclass_instance(not_val):
                next_prefix = nested_prefix or _sanitize_param_name(f"{param_base}_not")
                nested = _build_expr_conditions(
                    expr,
                    field_label,
                    not_val,
                    params,
                    dialect,
                    next_prefix,
                    _sanitize_param_name(f"{next_prefix}_not"),
                )
                if nested:
                    conditions.append(f"NOT ({' AND '.join(nested)})")
            else:
                _bind_param(params, f"{param_base}_not", not_val)
                if insensitive and isinstance(not_val, str):
                    conditions.append(f"LOWER({expr}) <> LOWER({placeholder})")
                else:
                    conditions.append(f"{expr} <> {placeholder}")

        if "equals" in value:
            if value["equals"] is None:
                conditions.append(f"{expr} IS NULL")
            elif isinstance(value["equals"], (list, tuple, set, dict)) or _is_dataclass_instance(value["equals"]):
                raise ValueError(f"Filter operator 'equals' on field '{field_label}' must be a scalar value or None")
            else:
                eq_val = value["equals"]
                _bind_param(params, f"{param_base}_eq", eq_val)
                if insensitive and isinstance(eq_val, str):
                    conditions.append(f"LOWER({expr}) = LOWER({placeholder})")
                else:
                    conditions.append(f"{expr} = {placeholder}")

        if "contains" in value:
            if not isinstance(value["contains"], str):
                raise ValueError(f"Filter operator 'contains' on field '{field_label}' must be a string")
            _bind_param(params, f"{param_base}_co", f"%{value['contains']}%")
            conditions.append(_format_pattern_condition(expr, placeholder, dialect, insensitive))

        if "startsWith" in value:
            if not isinstance(value["startsWith"], str):
                raise ValueError(f"Filter operator 'startsWith' on field '{field_label}' must be a string")
            _bind_param(params, f"{param_base}_sw", f"{value['startsWith']}%")
            conditions.append(_format_pattern_condition(expr, placeholder, dialect, insensitive))

        if "endsWith" in value:
            if not isinstance(value["endsWith"], str):
                raise ValueError(f"Filter operator 'endsWith' on field '{field_label}' must be a string")
            _bind_param(params, f"{param_base}_ew", f"%{value['endsWith']}")
            conditions.append(_format_pattern_condition(expr, placeholder, dialect, insensitive))

        for op, sql_op, suffix in (("gte", ">=", "gte"), ("lte", "<=", "lte"), ("gt", ">", "gt"), ("lt", "<", "lt")):
            if op in value:
                operand = value[op]
                if operand is None or isinstance(operand, (list, tuple, set, dict)) or _is_dataclass_instance(operand):
                    raise ValueError(f"Filter operator '{op}' on field '{field_label}' must be a scalar comparison value")
                _bind_param(params, f"{param_base}_{suffix}", operand)
                conditions.append(f"{expr} {sql_op} {placeholder}")

        if "in" in value:
            vals = value["in"]
            if not isinstance(vals, (list, tuple)):
                raise ValueError(f"Filter operator 'in' on field '{field_label}' must be a list or tuple")
            if vals:
                lower = insensitive and any(isinstance(x, str) for x in vals)
                in_placeholders: List[str] = []
                for i, v in enumerate(vals):
                    _bind_param(params, f"{param_base}_in{i}", v)
                    in_placeholders.append(f"LOWER({placeholder})" if lower and isinstance(v, str) else placeholder)
                lhs = f"LOWER({expr})" if lower else expr
                conditions.append(f"{lhs} IN ({', '.join(in_placeholders)})")
            else:
                conditions.append("1=0")

        if "notIn" in value:
            vals = value["notIn"]
            if not isinstance(vals, (list, tuple)):
                raise ValueError(f"Filter operator 'notIn' on field '{field_label}' must be a list or tuple")
            if vals:
                lower = insensitive and any(isinstance(x, str) for x in vals)
                notin_placeholders: List[str] = []
                for i, v in enumerate(vals):
                    _bind_param(params, f"{param_base}_notin{i}", v)
                    notin_placeholders.append(f"LOWER({placeholder})" if lower and isinstance(v, str) else placeholder)
                lhs = f"LOWER({expr})" if lower else expr
                conditions.append(f"{lhs} NOT IN ({', '.join(notin_placeholders)})")
            else:
                conditions.append("1=1")

        return conditions

    _bind_param(params, param_base, value)
    conditions.append(f"{expr} = {placeholder}")
    return conditions


def _parse_logical_group(key: str, value: Any, recurse_fn: Any, prefix: str) -> Optional[str]:
    if key == "OR":
        if not isinstance(value, (list, tuple)):
            raise ValueError("OR filter must be a list of filter mappings or dataclasses")
        sub = []
        for i, v in enumerate(value):
            if not (isinstance(v, dict) or _is_dataclass_instance(v)):
                raise ValueError("OR filter entries must be mappings or filter dataclasses")
            sub.append(recurse_fn(v, f"{prefix}or{i}_") or "1=1")
        return f"({' OR '.join(sub)})" if sub else "1=0"

    if not (isinstance(value, (list, tuple, dict)) or _is_dataclass_instance(value)):
        raise ValueError(f"{key} filter must be a mapping, filter dataclass, or list thereof")
    items = value if isinstance(value, (list, tuple)) else [value]
    sub = []
    for i, v in enumerate(items):
        if not (isinstance(v, dict) or _is_dataclass_instance(v)):
            raise ValueError(f"{key} filter entries must be mappings or filter dataclasses")
        part = recurse_fn(v, f"{prefix}{key.lower()}{i}_")
        if key == "NOT":
            sub.append(part or "1=1")
        elif part:
            sub.append(part)
    if not sub:
        return None
    if key == "NOT":
        return f"NOT ({' OR '.join(sub)})"
    return f"({' AND '.join(sub)})"


def _parse_where(model_name: str, where: Optional[Any], params: Dict, dialect: str, prefix: str = "", self_ref: str = "", col_prefix: str = "") -> str:
    if where is None:
        return ""
    if _is_dataclass_instance(where):
        where = _normalize_dataclass_dict(where)
    if not isinstance(where, dict):
        raise ValueError("Where clause must be a mapping or filter dataclass")
    if not where:
        return ""
    conditions: List[str] = []

    field_map = get_field_map_for_model(model_name)
    model_relations = get_relations_for_model(model_name)

    clean_where: Dict[str, Any] = {}
    for key, raw_value in where.items():
        val = _normalize_dataclass_dict(raw_value) if _is_dataclass_instance(raw_value) else raw_value
        if (
            "_" in key
            and key not in field_map
            and resolve_relation_key(model_name, key) is None
            and isinstance(val, dict)
            and len(val) > 0
            and not _is_operator_value(val)
            and not _is_relation_operator_value(val)
            and (not field_map or all(sub_k in field_map for sub_k in val))
        ):
            clean_where.update(val)
        else:
            clean_where[key] = val

    for key, value in clean_where.items():
        if key == "OR" or key == "AND" or key == "NOT":
            logical_sql = _parse_logical_group(
                key,
                value,
                lambda sub_val, sub_prefix: _parse_where(model_name, sub_val, params, dialect, sub_prefix, self_ref=self_ref, col_prefix=col_prefix),
                prefix,
            )
            if logical_sql is not None:
                conditions.append(logical_sql)
        else:
            rel_key = resolve_relation_key(model_name, key)
            if rel_key is not None:
                if not isinstance(value, dict):
                    raise ValueError(f"Relation filter for '{rel_key}' must be a mapping or filter object")
                rel_sql = _parse_relation_filter(model_name, model_relations[rel_key], value, params, dialect, f"{prefix}{rel_key}_", self_ref=self_ref)
                if rel_sql:
                    conditions.append(rel_sql)
                continue

            resolved_key = resolve_field_name(model_name, key, strict=True)
            col = f"{col_prefix}{_quote(resolved_key, dialect)}"
            pname = _sanitize_param_name(f"{prefix}{resolved_key}")
            conditions.extend(_build_expr_conditions(col, resolved_key, value, params, dialect, pname))

    return " AND ".join(conditions)


def _build_having(
    having: Any,
    params: Dict[str, Any],
    dialect: str,
    by_fields: Optional[List[str]] = None,
    model_name: str = "",
    prefix: str = "having_",
) -> str:
    """Build a SQL HAVING clause from group_by(having=...) filters."""
    if having is None:
        return ""
    if _is_dataclass_instance(having):
        having = _normalize_dataclass_dict(having)
    if not isinstance(having, dict):
        raise ValueError("Having clause must be a mapping or filter dataclass")
    if not having:
        return ""

    conditions: List[str] = []
    by_field_set = {
        (resolve_field_name(model_name, f, strict=False) if model_name else str(f)).lower()
        for f in (by_fields or [])
    }

    for key, raw_value in having.items():
        value = _normalize_dataclass_dict(raw_value) if _is_dataclass_instance(raw_value) else raw_value
        if key == "OR" or key == "AND" or key == "NOT":
            logical_sql = _parse_logical_group(
                key,
                value,
                lambda sub_val, sub_prefix: _build_having(
                    sub_val, params, dialect, by_fields=by_fields, model_name=model_name, prefix=sub_prefix
                ),
                prefix,
            )
            if logical_sql is not None:
                conditions.append(logical_sql)
        elif key in _HAVING_AGGREGATES:
            sql_fn = _HAVING_AGGREGATES[key]
            if not isinstance(value, dict):
                raise ValueError(f"Having '{key}' filter must be a mapping or filter dataclass")
            for field, agg_filter in value.items():
                if field == "_all":
                    if key != "_count":
                        raise ValueError(f"Having '{key}' does not support '_all'; specify a field name")
                    expr = "COUNT(*)"
                    resolved_field = "_all"
                else:
                    resolved_field = resolve_field_name(model_name, field, strict=True) if model_name else field
                    expr = f"{sql_fn}({_quote(resolved_field, dialect)})"
                param_base = _sanitize_param_name(f"{prefix}{key}_{resolved_field}")
                conditions.extend(
                    _build_expr_conditions(expr, f"{key}.{resolved_field}", agg_filter, params, dialect, param_base)
                )
        elif str(key).startswith("_"):
            raise ValueError(f"Unknown having aggregate key '{key}'")
        else:
            resolved_key = resolve_field_name(model_name, key, strict=True) if model_name else key
            if by_field_set and resolved_key.lower() not in by_field_set:
                raise ValueError(
                    f"Field '{resolved_key}' in having must be included in group_by 'by' fields or wrapped in an aggregate (_count, _sum, _avg, _min, _max)"
                )
            param_base = _sanitize_param_name(f"{prefix}{resolved_key}")
            conditions.extend(
                _build_expr_conditions(_quote(resolved_key, dialect), resolved_key, value, params, dialect, param_base)
            )

    return " AND ".join(conditions)


def _build_order_by(order_by: Any, dialect: str, model_name: Optional[str] = None) -> str:
    if not order_by:
        return ""
    if is_dataclass(order_by) and not isinstance(order_by, type):
        order_by = _normalize_dataclass_dict(order_by)
    if not order_by:
        return ""
    entries = order_by if isinstance(order_by, list) else [order_by]
    parts: List[str] = []
    for entry in entries:
        if is_dataclass(entry) and not isinstance(entry, type):
            entry = _normalize_dataclass_dict(entry)
        if not entry:
            continue
        for col, direction in entry.items():
            resolved_col = resolve_field_name(model_name, col, strict=True) if model_name else col
            parts.append(f"{_quote(resolved_col, dialect)} {_normalize_sort_direction(direction)}")
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

