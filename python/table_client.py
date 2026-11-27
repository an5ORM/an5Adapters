from __future__ import annotations

from dataclasses import fields as dc_fields, is_dataclass
import json
import uuid
from typing import Any, Dict, Generic, List, Optional, TypeVar
try:
    from .base import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE, get_fields_for_model, _build_having, _build_order_by, _parse_where, _quote, _quote_table, _resolve_table, get_relations_for_model, resolve_field_name, resolve_relation_key, resolve_relation_keys
    from .base.sql import _normalize_dataclass_dict
    from .base.vectors import decode_vector, encode_vector, is_vector_field, needs_vector_encoding, run_sqlite_vector_search, vector_distance
    from .base.vector_providers import VectorProviderError
except ImportError:
    from base import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE, get_fields_for_model, _build_having, _build_order_by, _parse_where, _quote, _quote_table, _resolve_table, get_relations_for_model, resolve_field_name, resolve_relation_key, resolve_relation_keys
    from base.sql import _normalize_dataclass_dict
    from base.vectors import decode_vector, encode_vector, is_vector_field, needs_vector_encoding, run_sqlite_vector_search, vector_distance
    from base.vector_providers import VectorProviderError

# ─── Select / Include helpers ────────────────────────────────────────────────────────

def _selected_fields(select: Any) -> List[str]:
    """Extract scalar column names from a select object (list or dict with truthy values)."""
    if not select:
        return []
    if isinstance(select, str):
        return [select] if select else []
    if isinstance(select, list):
        return [f for f in select if isinstance(f, str) and f]
    if isinstance(select, dict):
        return [str(k) for k, v in select.items() if v]
    return []


def _has_relation_select(select: Any, relations: Dict) -> bool:
    for key in _selected_fields(select):
        if key == "_count" or key in relations:
            return True
    return False


def _collect_include_keys(include: Any) -> List[str]:
    if not isinstance(include, dict):
        return []
    return [str(k) for k, v in include.items() if v]


def _project_fields(row: Dict, select: Any, extra_keys: Optional[List[str]] = None) -> Dict:
    """Keep only selected fields on a row (mirrors TypeScript projectFields)."""
    if not row or not select:
        return row
    projected = {}
    for key in _selected_fields(select):
        if key in row:
            projected[key] = row[key]
    if extra_keys:
        for extra in extra_keys:
            if extra in row and extra not in projected:
                projected[extra] = row[extra]
    if "_count" in row and "_count" not in projected:
        projected["_count"] = row["_count"]
    return projected


def _to_list(value: Any) -> List:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _is_find_args_dataclass(obj: Any) -> bool:
    if not is_dataclass(obj) or isinstance(obj, type):
        return False
    names = {f.name for f in dc_fields(obj)}
    return "where" in names and names.issubset({"where", "order_by", "take", "skip", "select", "include"})


def _is_group_by_args_dataclass(obj: Any) -> bool:
    if not is_dataclass(obj) or isinstance(obj, type):
        return False
    names = {f.name for f in dc_fields(obj)}
    return "by" in names and names.issubset(
        {"by", "where", "having", "order_by", "skip", "take", "_count", "_sum", "_avg", "_min", "_max"}
    )


def _resolve_select(model_name: str, select: Any) -> Any:
    if not select:
        return select
    if isinstance(select, str):
        if select == "_count":
            return select
        rel_key = resolve_relation_key(model_name, select)
        return rel_key if rel_key is not None else resolve_field_name(model_name, select, strict=True)
    if isinstance(select, list):
        resolved_list: List[Any] = []
        for item in select:
            if isinstance(item, str) and item:
                if item == "_count":
                    resolved_list.append(item)
                else:
                    rel_key = resolve_relation_key(model_name, item)
                    resolved_list.append(rel_key if rel_key is not None else resolve_field_name(model_name, item, strict=True))
            else:
                resolved_list.append(item)
        return resolved_list
    if isinstance(select, dict):
        resolved_dict: Dict[str, Any] = {}
        for k, v in select.items():
            key_str = str(k)
            if key_str == "_count":
                resolved_dict[key_str] = v
                continue
            rel_key = resolve_relation_key(model_name, key_str)
            if rel_key is not None:
                resolved_dict[rel_key] = v
            else:
                resolved_dict[resolve_field_name(model_name, key_str, strict=True)] = v
        return resolved_dict
    return select


def _resolve_include_entry(rel_model_name: str, val: Any) -> Any:
    if val is None or isinstance(val, bool):
        return val
    if getattr(val, "_an5_include", False):
        return {"include": _resolve_include(rel_model_name, val)}
    if is_dataclass(val) and not isinstance(val, type):
        out: Dict[str, Any] = {}
        for f in dc_fields(val):
            raw_v = getattr(val, f.name)
            if raw_v is None:
                continue
            if f.name == "include":
                out["include"] = _resolve_include(rel_model_name, raw_v)
            else:
                normalized = _normalize_dataclass_dict(raw_v) if is_dataclass(raw_v) and not isinstance(raw_v, type) else raw_v
                if is_dataclass(raw_v) and isinstance(normalized, dict) and not normalized:
                    continue
                out[f.name] = normalized
        return out
    if isinstance(val, dict):
        out = dict(val)
        if "include" in out and out["include"] is not None:
            out["include"] = _resolve_include(rel_model_name, out["include"])
        return out
    return val


def _resolve_include(model_name: str, include: Any) -> Any:
    if not include:
        return include
    if is_dataclass(include) and not isinstance(include, type):
        raw_items = [
            (f.name, getattr(include, f.name))
            for f in dc_fields(include)
            if getattr(include, f.name) is not None
        ]
    elif isinstance(include, dict):
        raw_items = list(include.items())
    else:
        return include
    model_relations = get_relations_for_model(model_name)
    resolved: Dict[str, Any] = {}
    for k, v in raw_items:
        key_str = str(k)
        if key_str == "_count":
            resolved[key_str] = v
            continue
        rel_key = resolve_relation_key(model_name, key_str)
        target_key = rel_key if rel_key is not None else key_str
        relation = model_relations.get(target_key)
        if relation and relation.get("modelName"):
            resolved[target_key] = _resolve_include_entry(relation["modelName"], v)
        else:
            resolved[target_key] = v
    return resolved


def _normalize_write_data(model_name: str, data: Any) -> Dict[str, Any]:
    if not data:
        return {}
    raw = _normalize_dataclass_dict(data) if is_dataclass(data) and not isinstance(data, type) else dict(data)
    out: Dict[str, Any] = {}
    for k, v in raw.items():
        rel_key = resolve_relation_key(model_name, k)
        if rel_key is not None:
            out[rel_key] = _normalize_dataclass_dict(v) if is_dataclass(v) and not isinstance(v, type) else v
        else:
            out[resolve_field_name(model_name, k, strict=True)] = v
    return out


def _join_key_token(value: Any) -> Optional[tuple]:
    if value is None:
        return None
    if isinstance(value, bool):
        return ("b", value)
    if isinstance(value, (int, float)):
        return ("n", value)
    if isinstance(value, (bytes, bytearray)):
        return ("s", bytes(value).decode("utf-8", errors="replace"))
    return ("v", str(value))


def _parse_include_bound(value: Any, field: str, rel_key: str) -> tuple[bool, int]:
    if value is None:
        return False, 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"include.{field} for relation '{rel_key}' must be a non-negative integer")
    return True, value


def _parse_count_targets(model_name: str, model_relations: Dict, count_spec: Any) -> List[tuple[str, Dict, Any]]:
    if not count_spec:
        return []
    if count_spec is True:
        return [
            (rk, rel, None)
            for rk, rel in sorted(model_relations.items())
            if rel.get("relationType") == "many"
        ]
    if is_dataclass(count_spec) and not isinstance(count_spec, type):
        count_spec = _normalize_dataclass_dict(count_spec)
    if not isinstance(count_spec, dict):
        raise ValueError(f"Invalid _count payload for model '{model_name}'")
    selection = count_spec["select"] if "select" in count_spec else count_spec
    if not selection:
        return []
    if not isinstance(selection, dict):
        raise ValueError(f"_count.select for model '{model_name}' must be a dict")
    targets: List[tuple[str, Dict, Any]] = []
    for raw_key, rel_spec in selection.items():
        if not rel_spec:
            continue
        canon_key = resolve_relation_key(model_name, str(raw_key)) or str(raw_key)
        relation = model_relations.get(canon_key)
        if not relation or relation.get("relationType") != "many":
            raise ValueError(f"Unknown or non-list relation '{raw_key}' in _count for model '{model_name}'")
        rel_where = None
        if isinstance(rel_spec, dict):
            unknown = [k for k in rel_spec if k != "where"]
            if unknown:
                raise ValueError(f"Unsupported option(s) in _count.{canon_key}: {', '.join(unknown)}")
            rel_where = rel_spec.get("where")
        elif rel_spec is not True:
            raise ValueError(f"Unsupported _count option for relation '{canon_key}'")
        targets.append((canon_key, relation, rel_where))
    return targets


def _resolve_includes(model_name: str, rows: List[Dict], include: Any, adapter: Any) -> None:
    """Eager-load relation rows and attach them onto each row (mirrors TypeScript resolveIncludes)."""
    if not rows or not include:
        return
    include = _resolve_include(model_name, include)
    if not isinstance(include, dict):
        return
    model_relations = get_relations_for_model(model_name)

    for key, value in include.items():
        if not value:
            continue

        if key == "_count":
            for row in rows:
                if "_count" not in row or row["_count"] is None:
                    row["_count"] = {}
            for rel_key, relation, count_where in _parse_count_targets(model_name, model_relations, value):
                match_key, join_key = resolve_relation_keys(model_name, relation)
                unique_keys: List[Any] = []
                seen_tokens = set()
                for row in rows:
                    rv = row.get(join_key)
                    tok = _join_key_token(rv)
                    if tok is not None and tok not in seen_tokens:
                        seen_tokens.add(tok)
                        unique_keys.append(rv)
                if unique_keys:
                    base_where: Dict[str, Any] = {match_key: {"in": unique_keys}}
                    if is_dataclass(count_where) and not isinstance(count_where, type):
                        count_where = _normalize_dataclass_dict(count_where)
                    if isinstance(count_where, dict) and count_where:
                        sub_where: Dict[str, Any] = {"AND": [base_where, count_where]}
                    else:
                        sub_where = base_where
                    rel_client = adapter.table(relation["modelName"])
                    related = rel_client.find_many(where=sub_where)
                    count_map: Dict[tuple, int] = {}
                    for r in related:
                        tok = _join_key_token(r.get(match_key))
                        if tok is not None:
                            count_map[tok] = count_map.get(tok, 0) + 1
                    for row in rows:
                        tok = _join_key_token(row.get(join_key))
                        row["_count"][rel_key] = count_map.get(tok, 0) if tok is not None else 0
                else:
                    for row in rows:
                        row["_count"][rel_key] = 0
            continue

        relation = model_relations.get(key)
        if not relation:
            continue

        is_many = relation.get("relationType") == "many"
        match_key, join_key = resolve_relation_keys(model_name, relation)
        normalized_value = _resolve_include_entry(relation["modelName"], value)
        sub_args = dict(normalized_value) if isinstance(normalized_value, dict) else {}
        has_take, take_val = _parse_include_bound(sub_args.get("take"), "take", key)
        _, skip_val = _parse_include_bound(sub_args.get("skip"), "skip", key)

        unique_keys: List[Any] = []
        seen_tokens = set()
        for row in rows:
            rv = row.get(join_key)
            tok = _join_key_token(rv)
            if tok is not None and tok not in seen_tokens:
                seen_tokens.add(tok)
                unique_keys.append(rv)

        if not unique_keys or (is_many and has_take and take_val == 0):
            for row in rows:
                row[key] = [] if is_many else None
            continue

        base_where = {match_key: {"in": unique_keys}}
        extra_where = sub_args.get("where")
        if extra_where:
            if is_dataclass(extra_where) and not isinstance(extra_where, type):
                extra_where = _normalize_dataclass_dict(extra_where)
            if isinstance(extra_where, dict) and extra_where:
                sub_where: Dict[str, Any] = {"AND": [base_where, extra_where]}
            else:
                sub_where = base_where
        else:
            sub_where = base_where

        rel_client = adapter.table(relation["modelName"])
        related = rel_client.find_many(
            where=sub_where,
            order_by=sub_args.get("orderBy") or sub_args.get("order_by"),
        )

        group_map: Dict[tuple, List[Dict]] = {}
        for r in related:
            tok = _join_key_token(r.get(match_key))
            if tok is not None:
                group_map.setdefault(tok, []).append(r)

        sliced_map: Dict[tuple, List[Dict]] = {}
        surviving: List[Dict] = []
        seen_ids = set()
        for tok, bucket in group_map.items():
            if is_many:
                end = skip_val + take_val if has_take else None
                picked = bucket[skip_val:end]
            else:
                picked = bucket[:1]
            sliced_map[tok] = picked
            for item in picked:
                obj_id = id(item)
                if obj_id not in seen_ids:
                    seen_ids.add(obj_id)
                    surviving.append(item)

        nested_include = sub_args.get("include")
        if nested_include and surviving:
            _resolve_includes(relation["modelName"], surviving, nested_include, adapter)

        nested_select_raw = sub_args.get("select")
        nested_select = _resolve_select(relation["modelName"], nested_select_raw) if nested_select_raw else None
        if nested_select and surviving:
            child_rels = get_relations_for_model(relation["modelName"])
            if _has_relation_select(nested_select, child_rels):
                _resolve_includes(relation["modelName"], surviving, nested_select, adapter)

        preserve_keys = _collect_include_keys(_resolve_include(relation["modelName"], nested_include))
        projected_by_id: Dict[int, Dict] = {}
        if nested_select:
            for item in surviving:
                projected_by_id[id(item)] = _project_fields(item, nested_select, preserve_keys)

        for row in rows:
            tok = _join_key_token(row.get(join_key))
            raw_matches = sliced_map.get(tok, []) if tok is not None else []
            if nested_select:
                final_matches = [projected_by_id[id(item)] for item in raw_matches]
            else:
                final_matches = raw_matches
            row[key] = final_matches if is_many else (final_matches[0] if final_matches else None)


def _split_relation_writes(model_name: str, data: Dict) -> (Dict, Dict):
    """Separate relation-write objects from scalar data using model metadata."""
    relations = get_relations_for_model(model_name)
    scalars = {}
    rel_writes = {}
    for k, v in data.items():
        if k in relations and isinstance(v, dict) and v is not None:
            rel_writes[k] = v
        else:
            scalars[k] = v
    return scalars, rel_writes

# ─── Table Client ───────────────────────────────────────────────────────────────────

def _selected_aggregate_fields(fields: Any) -> List[str]:
    if not fields:
        return []
    if isinstance(fields, str):
        return [fields]
    if isinstance(fields, list):
        return [f for f in fields if isinstance(f, str) and f]
    if isinstance(fields, dict):
        return [str(f) for f, enabled in fields.items() if enabled]
    return []


def _normalize_by_fields(by: Any) -> List[str]:
    if isinstance(by, str):
        return [by]
    if isinstance(by, list):
        return [f for f in by if isinstance(f, str) and f]
    return []


def _to_non_negative_int(value: Any, fallback: int = 0) -> int:
    try:
        n = int(value)
        return n if n >= 0 else fallback
    except Exception:
        return fallback


def _append_update_set(set_parts: List[str], values: List[Any], col: str, val: Any, dialect: str) -> None:
    quoted = _quote(col, dialect)
    # Only PostgreSQL uses `%s`; MSSQL and SQLite both use `?`. The condition is
    # written as "is it Postgres" rather than "is it MSSQL" so a new dialect cannot
    # fall into the `%s` branch by default — which once made SQLite generate SQL it
    # could not parse.
    placeholder = "%s" if dialect == DIALECT_POSTGRES else "?"
    if isinstance(val, dict):
        if "increment" in val:
            set_parts.append(f"{quoted} = {quoted} + {placeholder}")
            values.append(val["increment"])
            return
        if "decrement" in val:
            set_parts.append(f"{quoted} = {quoted} - {placeholder}")
            values.append(val["decrement"])
            return
        if "multiply" in val:
            set_parts.append(f"{quoted} = {quoted} * {placeholder}")
            values.append(val["multiply"])
            return
        if "divide" in val:
            set_parts.append(f"{quoted} = {quoted} / {placeholder}")
            values.append(val["divide"])
            return
        if "set" in val:
            set_parts.append(f"{quoted} = {placeholder}")
            values.append(val["set"])
            return

    set_parts.append(f"{quoted} = {placeholder}")
    values.append(val)


T = TypeVar("T")


class AdapterTableClient(Generic[T]):
    """Typed table client.

    Bind a row type for ORM-standard autocomplete, e.g.
    ``AdapterTableClient[UserRow]`` where ``UserRow`` is the generated
    ``TypedDict`` describing the model's row shape (the runtime returns
    plain dicts). Unparameterized ``AdapterTableClient`` behaves as before.
    """
    def __init__(self, adapter: An5Adapter, model_name: str):
        self._adapter = adapter
        self._model = model_name
        self._dialect = adapter._dialect

    @property
    def _table(self) -> str:
        return _resolve_table(self._model)

    @property
    def _table_sql(self) -> str:
        return _quote_table(self._table, self._dialect)

    @property
    def _nolock(self) -> str:
        # `WITH (NOLOCK)` is an MSSQL table hint. PostgreSQL has none and SQLite
        # has no equivalent concept at all — leaving it in makes every generated
        # SELECT invalid SQL, failing on the first one.
        return "" if self._dialect in (DIALECT_POSTGRES, DIALECT_SQLITE) else " WITH (NOLOCK)"

    @property
    def _fields(self) -> List[Dict]:
        # Uses the metadata resolver instead of a plain lookup: the generated
        # client names tables in PascalCase while the metadata keys them in
        # camelCase, so a plain lookup yields an empty list and silently skips
        # `isId` (never generating the primary key).
        fields = get_fields_for_model(self._model)
        if isinstance(fields, dict):
            raise TypeError(
                "AN5 Python metadata is out of date. Regenerate with @an5/orm >= 1.0.4 "
                "so MODEL_FIELDS uses a list of field objects."
            )
        return fields or []

    @property
    def _vector_fields(self) -> List[str]:
        """The `VECTOR(n)` columns of this model, from the generated metadata."""
        return [f["name"] for f in self._fields if is_vector_field(f)]

    def _encode_vector_fields(self, data: Dict) -> Dict:
        """Encodes every `VECTOR(n)` value on its way into SQLite.

        The column holds a float32 BLOB, which is a third of the size of the JSON
        text it replaces and is what the in-database distance functions read.
        Values that already arrived as text or bytes are left alone, so rows
        written by an older version stay readable.
        """
        if self._dialect != DIALECT_SQLITE:
            return data
        out = dict(data)
        for name in self._vector_fields:
            value = out.get(name)
            if needs_vector_encoding(value):
                parsed = [float(v) for v in value]
                if parsed:
                    out[name] = encode_vector(parsed)
        return out

    def _decode_vector_fields(self, rows: List[Dict]) -> List[Dict]:
        """Decodes `VECTOR(n)` columns back into lists of numbers after a read."""
        if self._dialect != DIALECT_SQLITE or not rows:
            return rows
        names = self._vector_fields
        if not names:
            return rows
        decoded = []
        for row in rows:
            changed = False
            out = dict(row)
            for name in names:
                if name in out:
                    values = decode_vector(out[name])
                    if values:
                        out[name] = values
                        changed = True
            decoded.append(out if changed else row)
        return decoded

    def _pagination(self, take: Optional[int], skip: int, order_sql: str) -> str:
        if take is None:
            return ""
        if self._dialect in (DIALECT_POSTGRES, DIALECT_SQLITE):
            # SQLite has `LIMIT ... OFFSET` like PostgreSQL. Taking the
            # `OFFSET ... FETCH NEXT` branch produces SQL SQLite does not understand.
            return f" LIMIT {take} OFFSET {skip}"
        order_prefix = "" if order_sql else " ORDER BY (SELECT NULL)"
        return f"{order_prefix} OFFSET {skip} ROWS FETCH NEXT {take} ROWS ONLY"

    def _primary_key(self) -> str:
        fields = get_fields_for_model(self._model)
        if isinstance(fields, list) and fields:
            id_field = next((f for f in fields if isinstance(f, dict) and f.get("isId")), None)
            if id_field and id_field.get("name"):
                return id_field["name"]
            if any(isinstance(f, dict) and f.get("name") == "id" for f in fields):
                return "id"
            first_name = fields[0].get("name") if isinstance(fields[0], dict) else None
            if first_name:
                return first_name
        elif isinstance(fields, dict) and fields and "id" not in fields:
            return next(iter(fields.keys()))
        return "id"

    def _resolve_agg_fields(self, fields: Any, allow_all: bool = False) -> Any:
        if not fields:
            return fields
        if isinstance(fields, str):
            if allow_all and fields == "_all":
                return fields
            return resolve_field_name(self._model, fields, strict=True)
        if isinstance(fields, list):
            return [
                f if (allow_all and f == "_all") else resolve_field_name(self._model, f, strict=True)
                if isinstance(f, str) and f else f
                for f in fields
            ]
        if isinstance(fields, dict):
            return {
                (str(k) if (allow_all and str(k) == "_all") else resolve_field_name(self._model, str(k), strict=True)): v
                for k, v in fields.items()
            }
        return fields

    def find_many(self, where=None, order_by=None, skip: int = 0, take: Optional[int] = None, select=None, include=None) -> List[T]:
        if _is_find_args_dataclass(where):
            args = where
            where = args.where
            if order_by is None:
                order_by = getattr(args, "order_by", None)
            if skip == 0 and getattr(args, "skip", 0):
                skip = args.skip
            if take is None:
                take = getattr(args, "take", None)
            if select is None:
                select = getattr(args, "select", None)
            if include is None:
                include = getattr(args, "include", None)

        select = _resolve_select(self._model, select)
        include = _resolve_include(self._model, include)

        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        order_sql = _build_order_by(order_by, self._dialect, model_name=self._model)

        relations = get_relations_for_model(self._model)
        has_include = bool(include and isinstance(include, dict) and any(include.values()))
        cols = "SELECT *"
        if select and len(_selected_fields(select)) > 0 and not _has_relation_select(select, relations) and not has_include:
            cols = "SELECT " + ", ".join(_quote(c, self._dialect) for c in _selected_fields(select))

        query = f"{cols} FROM {self._table_sql}{self._nolock}"
        if where_sql:
            query += f" WHERE {where_sql}"
        if order_sql:
            query += f" {order_sql}"
        query += self._pagination(take, skip, order_sql)

        rows = self._decode_vector_fields(self._adapter.exec(query, list(params.values())))

        if include:
            _resolve_includes(self._model, rows, include, self._adapter)
        if select:
            if _has_relation_select(select, relations):
                _resolve_includes(self._model, rows, select, self._adapter)
            rows = [_project_fields(r, select, _collect_include_keys(include)) for r in rows]
        return rows

    def find_first(self, where=None, order_by=None, select=None, include=None) -> Optional[T]:
        if _is_find_args_dataclass(where):
            args = where
            where = args.where
            if order_by is None:
                order_by = getattr(args, "order_by", None)
            if select is None:
                select = getattr(args, "select", None)
            if include is None:
                include = getattr(args, "include", None)
        rows = self.find_many(where=where, order_by=order_by, take=1, select=select, include=include)
        return rows[0] if rows else None

    def find_unique(self, where: Any, select=None, include=None) -> Optional[T]:
        return self.find_first(where=where, select=select, include=include)

    def count(self, where=None) -> int:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        query = f"SELECT COUNT(*) AS cnt FROM {self._table_sql}{self._nolock}"
        if where_sql:
            query += f" WHERE {where_sql}"
        rows = self._adapter.exec(query, list(params.values()))
        return int(rows[0]["cnt"]) if rows else 0

    def create(self, data: Any, include=None, select=None) -> T:
        id_field = next((f for f in self._fields if f.get("isId")), None)
        data = _normalize_write_data(self._model, data)
        if id_field and id_field["name"] not in data:
            data = {**data, id_field["name"]: str(uuid.uuid4())}

        select = _resolve_select(self._model, select)
        include = _resolve_include(self._model, include)
        data, relation_writes = _split_relation_writes(self._model, data)
        data = self._encode_vector_fields(data)

        cols = [k for k, v in data.items() if v is not None]
        values = [data[c] for c in cols]
        placeholders = ", ".join(["%s" if self._dialect == DIALECT_POSTGRES else "?"] * len(cols))
        col_list = ", ".join(_quote(c, self._dialect) for c in cols)
        query = f"INSERT INTO {self._table_sql} ({col_list}) VALUES ({placeholders})"
        self._adapter.execute(query, values)

        if id_field:
            created = self.find_first(where={id_field["name"]: data[id_field["name"]]}) or data
        else:
            created = data

        # Handle nested relation writes
        relations = get_relations_for_model(self._model)
        for rel_key, rel_write in relation_writes.items():
            relation = relations.get(rel_key)
            if not relation:
                continue
            child_client = self._adapter.table(relation["modelName"])
            if "create" in rel_write:
                create_items = _to_list(rel_write["create"])
                for item in create_items:
                    item_dict = _normalize_dataclass_dict(item) if is_dataclass(item) and not isinstance(item, type) else item
                    merged = {**item_dict, relation["foreignKey"]: created.get(relation["localKey"])}
                    child_client.create(data=merged)

        if include:
            _resolve_includes(self._model, [created], include, self._adapter)
        if select:
            if _has_relation_select(select, relations):
                _resolve_includes(self._model, [created], select, self._adapter)
            return _project_fields(created, select, _collect_include_keys(include))
        return created

    def create_many(self, data: List[Any], skip_duplicates: bool = False) -> Dict:
        count = 0
        for row in data:
            try:
                self.create(row)
                count += 1
            except Exception:
                if not skip_duplicates:
                    raise
        return {"count": count}

    def update(self, where: Any, data: Any, include=None, select=None) -> Optional[T]:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect, "w_")
        data = _normalize_write_data(self._model, data)
        select = _resolve_select(self._model, select)
        include = _resolve_include(self._model, include)
        data, relation_writes = _split_relation_writes(self._model, data)
        data = self._encode_vector_fields(data)
        set_parts: List[str] = []
        set_values: List = []
        for col, val in data.items():
            if val is not None:
                _append_update_set(set_parts, set_values, col, val, self._dialect)

        if set_parts:
            all_values = set_values + list(params.values())
            query = f"UPDATE {self._table_sql} SET {', '.join(set_parts)}"
            if where_sql:
                query += f" WHERE {where_sql}"
            self._adapter.execute(query, all_values)

        updated = self.find_first(where=where)

        # Handle nested relation writes
        relations = get_relations_for_model(self._model)
        for rel_key, rel_write in relation_writes.items():
            relation = relations.get(rel_key)
            if not relation:
                continue
            child_client = self._adapter.table(relation["modelName"])
            if "create" in rel_write:
                create_items = _to_list(rel_write["create"])
                for item in create_items:
                    item_dict = _normalize_dataclass_dict(item) if is_dataclass(item) and not isinstance(item, type) else item
                    merged = {**item_dict, relation["foreignKey"]: (updated or {}).get(relation["localKey"])}
                    child_client.create(data=merged)
            if "update" in rel_write:
                update_obj = rel_write["update"]
                child_client.update(where=update_obj.get("where"), data=update_obj.get("data") or {})
            if "disconnect" in rel_write:
                child_client.update_many(where=rel_write["disconnect"], data={relation["foreignKey"]: None})

        if include and updated:
            _resolve_includes(self._model, [updated], include, self._adapter)
        if select and updated:
            if _has_relation_select(select, relations):
                _resolve_includes(self._model, [updated], select, self._adapter)
            return _project_fields(updated, select, _collect_include_keys(include))
        return updated

    def update_many(self, where: Optional[Any], data: Any) -> Dict:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect, "w_")
        data = _normalize_write_data(self._model, data)
        data = self._encode_vector_fields(data)
        set_parts: List[str] = []
        set_values: List = []
        for col, val in data.items():
            if val is not None:
                _append_update_set(set_parts, set_values, col, val, self._dialect)

        if not set_parts:
            return {"count": 0}

        all_values = set_values + list(params.values())
        query = f"UPDATE {self._table_sql} SET {', '.join(set_parts)}"
        if where_sql:
            query += f" WHERE {where_sql}"
        count = self._adapter.execute(query, all_values)
        return {"count": count}

    def delete(self, where: Dict) -> Optional[T]:
        existing = self.find_first(where=where)
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        query = f"DELETE FROM {self._table_sql} WHERE {where_sql}"
        self._adapter.execute(query, list(params.values()))
        return existing

    def delete_many(self, where: Optional[Dict] = None) -> Dict:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        query = f"DELETE FROM {self._table_sql}"
        if where_sql:
            query += f" WHERE {where_sql}"
        count = self._adapter.execute(query, list(params.values()))
        return {"count": count}

    def upsert(self, where: Dict, create: Dict, update: Dict) -> T:
        existing = self.find_first(where=where)
        if existing:
            return self.update(where=where, data=update) or existing
        return self.create(data=create)

    def aggregate(self, where=None, _count=None, _sum=None, _avg=None, _min=None, _max=None) -> Dict:
        _count = self._resolve_agg_fields(_count, allow_all=True) if isinstance(_count, (str, list, dict)) else _count
        _sum = self._resolve_agg_fields(_sum)
        _avg = self._resolve_agg_fields(_avg)
        _min = self._resolve_agg_fields(_min)
        _max = self._resolve_agg_fields(_max)
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        aggs: List[str] = []
        if _count:
            aggs.append("COUNT(*) AS _count")
            if isinstance(_count, (list, dict)):
                for f in _selected_aggregate_fields(_count):
                    if f != "_all":
                        aggs.append(f"COUNT({_quote(f, self._dialect)}) AS _count_{f}")
        if _sum:
            for f in _selected_aggregate_fields(_sum):
                aggs.append(f"SUM({_quote(f, self._dialect)}) AS _sum_{f}")
        if _avg:
            for f in _selected_aggregate_fields(_avg):
                aggs.append(f"AVG({_quote(f, self._dialect)}) AS _avg_{f}")
        if _min:
            for f in _selected_aggregate_fields(_min):
                aggs.append(f"MIN({_quote(f, self._dialect)}) AS _min_{f}")
        if _max:
            for f in _selected_aggregate_fields(_max):
                aggs.append(f"MAX({_quote(f, self._dialect)}) AS _max_{f}")
        if not aggs:
            raise ValueError("Aggregate requires at least one aggregator field")

        query = f"SELECT {', '.join(aggs)} FROM {self._table_sql}"
        if where_sql:
            query += f" WHERE {where_sql}"
        rows = self._adapter.exec(query, list(params.values()))
        row = rows[0] if rows else {}
        result: Dict = {}
        if _count:
            all_count = int(row.get("_count") or 0)
            result["_count"] = {"_all": all_count}
            if isinstance(_count, (list, dict)):
                for f in _selected_aggregate_fields(_count):
                    if f != "_all":
                        result["_count"][f] = int(row.get(f"_count_{f}", all_count))
        if _sum:
            result["_sum"] = {}
            for f in _selected_aggregate_fields(_sum):
                v = row.get(f"_sum_{f}")
                result["_sum"][f] = float(v) if v is not None else None
        if _avg:
            result["_avg"] = {}
            for f in _selected_aggregate_fields(_avg):
                v = row.get(f"_avg_{f}")
                result["_avg"][f] = float(v) if v is not None else None
        if _min:
            result["_min"] = {}
            for f in _selected_aggregate_fields(_min):
                result["_min"][f] = row.get(f"_min_{f}")
        if _max:
            result["_max"] = {}
            for f in _selected_aggregate_fields(_max):
                result["_max"][f] = row.get(f"_max_{f}")
        return result

    def group_by(self, by, where=None, order_by=None, skip: int = 0, take: Optional[int] = None,
                 _count=None, _sum=None, _avg=None, _min=None, _max=None, having=None) -> List[Dict]:
        if _is_group_by_args_dataclass(by):
            args = by
            by = args.by
            if where is None:
                where = getattr(args, "where", None)
            if having is None:
                having = getattr(args, "having", None)
            if order_by is None:
                order_by = getattr(args, "order_by", None)
            if skip == 0 and getattr(args, "skip", 0):
                skip = args.skip
            if take is None:
                take = getattr(args, "take", None)
            if _count is None:
                _count = getattr(args, "_count", None)
            if _sum is None:
                _sum = getattr(args, "_sum", None)
            if _avg is None:
                _avg = getattr(args, "_avg", None)
            if _min is None:
                _min = getattr(args, "_min", None)
            if _max is None:
                _max = getattr(args, "_max", None)

        _count = self._resolve_agg_fields(_count, allow_all=True) if isinstance(_count, (str, list, dict)) else _count
        _sum = self._resolve_agg_fields(_sum)
        _avg = self._resolve_agg_fields(_avg)
        _min = self._resolve_agg_fields(_min)
        _max = self._resolve_agg_fields(_max)
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        by_fields = [resolve_field_name(self._model, f, strict=True) for f in _normalize_by_fields(by)]
        if not by_fields:
            raise ValueError("group_by requires 'by' fields")

        by_cols = ", ".join(_quote(f, self._dialect) for f in by_fields)
        aggs = ["COUNT(*) AS _count"]
        if isinstance(_count, (list, dict)):
            for f in _selected_aggregate_fields(_count):
                if f != "_all":
                    aggs.append(f"COUNT({_quote(f, self._dialect)}) AS _count_{f}")
        for f in _selected_aggregate_fields(_sum):
            aggs.append(f"SUM({_quote(f, self._dialect)}) AS _sum_{f}")
        for f in _selected_aggregate_fields(_avg):
            aggs.append(f"AVG({_quote(f, self._dialect)}) AS _avg_{f}")
        for f in _selected_aggregate_fields(_min):
            aggs.append(f"MIN({_quote(f, self._dialect)}) AS _min_{f}")
        for f in _selected_aggregate_fields(_max):
            aggs.append(f"MAX({_quote(f, self._dialect)}) AS _max_{f}")

        having_sql = _build_having(having, params, self._dialect, by_fields=by_fields, model_name=self._model)
        query = f"SELECT {by_cols}, {', '.join(aggs)} FROM {self._table_sql}"
        if where_sql:
            query += f" WHERE {where_sql}"
        query += f" GROUP BY {by_cols}"
        if having_sql:
            query += f" HAVING {having_sql}"
        order_sql = _build_order_by(order_by, self._dialect, model_name=self._model)
        has_take = take is not None
        has_skip = skip is not None and skip > 0
        if order_sql:
            query += f" {order_sql}"
        elif has_take or has_skip:
            query += f" ORDER BY {by_cols}"
        if has_take or has_skip:
            final_skip = _to_non_negative_int(skip)
            if self._dialect in (DIALECT_POSTGRES, DIALECT_SQLITE):
                if has_take:
                    query += f" LIMIT {_to_non_negative_int(take, 1)}"
                elif self._dialect == DIALECT_SQLITE:
                    query += " LIMIT -1"
                query += f" OFFSET {final_skip}"
            else:
                query += f" OFFSET {final_skip} ROWS"
                if has_take:
                    query += f" FETCH NEXT {_to_non_negative_int(take, 1)} ROWS ONLY"

        rows = self._adapter.exec(query, list(params.values()))
        if not (_sum or _avg or _min or _max or _count):
            return rows
        reshaped = []
        for r in rows:
            item = dict(r)
            if _count:
                all_count = int(r.get("_count") or 0)
                item["_count"] = all_count if not isinstance(_count, (list, dict)) else {"_all": all_count}
                if isinstance(_count, (list, dict)):
                    for f in _selected_aggregate_fields(_count):
                        if f != "_all":
                            item["_count"][f] = int(r.get(f"_count_{f}", all_count))
            if _sum:
                item["_sum"] = {}
                for f in _selected_aggregate_fields(_sum):
                    v = r.get(f"_sum_{f}")
                    item["_sum"][f] = float(v) if v is not None else None
            if _avg:
                item["_avg"] = {}
                for f in _selected_aggregate_fields(_avg):
                    v = r.get(f"_avg_{f}")
                    item["_avg"][f] = float(v) if v is not None else None
            if _min:
                item["_min"] = {}
                for f in _selected_aggregate_fields(_min):
                    item["_min"][f] = r.get(f"_min_{f}")
            if _max:
                item["_max"] = {}
                for f in _selected_aggregate_fields(_max):
                    item["_max"][f] = r.get(f"_max_{f}")
            reshaped.append(item)
        return reshaped

    def index_vectors(
        self,
        vector_field: str = "embedding",
        where=None,
        take: Optional[int] = None,
        batch_size: int = 200,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> Dict[str, int]:
        store = self._adapter.vector_store() if hasattr(self._adapter, "vector_store") else None
        if store is None:
            raise RuntimeError("No vector store configured on this adapter.")
        if getattr(self._adapter, "vector_store_only", False):
            raise RuntimeError("index_vectors requires a relational database, but this adapter is vector-only.")
        vector_field = resolve_field_name(self._model, vector_field, strict=True)
        pk = self._primary_key()
        rows = self.find_many(where=where, take=take)
        indexed = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            vectors: List[Dict[str, Any]] = []
            for row in batch:
                raw = row.get(vector_field)
                if raw is None:
                    continue
                vec = decode_vector(raw)
                if not vec:
                    continue
                rid = str(row.get(pk, ""))
                vectors.append(
                    {
                        "id": f"{self._model}:{rid}",
                        "vector": vec,
                        "metadata": {store.id_field: rid, store.model_field: self._model},
                    }
                )
            if vectors:
                res = store.upsert(vectors, collection=collection, namespace=namespace)
                indexed += int(res.get("count", len(vectors)))
        return {"indexed": indexed}

    def vector_search(
        self,
        vector: List[float],
        take: int = 10,
        where=None,
        vector_field: str = "embedding",
        distance_metric: str = "cosine",
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict]:
        vector_field = resolve_field_name(
            self._model,
            vector_field,
            strict=not getattr(self._adapter, "vector_store_only", False),
        )
        store = self._adapter.vector_store() if hasattr(self._adapter, "vector_store") else None
        if store is not None:
            try:
                hits = store.search(
                    vector,
                    k=take,
                    distance_metric=distance_metric,
                    include_metadata=True,
                    collection=collection,
                    namespace=namespace,
                )
                if getattr(self._adapter, "vector_store_only", False):
                    return [
                        {"id": h["id"], **(h.get("metadata") or {}), "distance": h["distance"]}
                        for h in hits
                    ]
                ids: List[str] = []
                distances: Dict[str, float] = {}
                for h in hits:
                    meta = h.get("metadata") or {}
                    raw_id = meta.get(store.id_field)
                    if raw_id is None:
                        s_id = str(h["id"])
                        raw_id = s_id.split(":", 1)[1] if ":" in s_id else s_id
                    rid = str(raw_id)
                    if rid:
                        ids.append(rid)
                        distances[rid] = float(h["distance"])
                if not ids:
                    return []
                pk = self._primary_key()
                ph = "%s" if self._dialect == DIALECT_POSTGRES else "?"
                in_list = ", ".join([ph] * len(ids))
                pk_sql = _quote(pk, self._dialect)
                rows = self._adapter.exec(f"SELECT * FROM {self._table_sql} WHERE {pk_sql} IN ({in_list})", ids)
                by_key = {str(r.get(pk)): r for r in rows}
                hydrated: List[Dict] = []
                for rid in ids:
                    row = by_key.get(rid)
                    if row is not None:
                        hydrated.append({**row, "distance": distances[rid]})
                        if len(hydrated) >= take:
                            break
                return self._decode_vector_fields(hydrated)
            except VectorProviderError:
                pass

        dim = len(vector)
        vec_json = json.dumps(vector)
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        field_sql = _quote(vector_field, self._dialect)

        # 1. SQLite ranks through sqlite-vec, a driver function or json_each,
        #    whichever this connection supports, so the table never leaves the
        #    database unless it has to.
        if self._dialect == DIALECT_SQLITE:
            rows = run_sqlite_vector_search(
                exec_fn=self._adapter.exec,
                table=self._table_sql,
                raw_table=self._table.strip("[]"),
                column=field_sql,
                raw_column=vector_field,
                vector=vector,
                metric=distance_metric,
                take=take,
                tail=f" WHERE {where_sql}" if where_sql else "",
                params=list(params.values()),
                support=self._adapter.vector_support(),
                preference=getattr(self._adapter, "vector_strategy", None),
            )
            if rows is not None:
                return self._decode_vector_fields(rows)
            return self._score_vectors_in_memory(vector, take, where, vector_field, distance_metric)

        # 2. Native dialect execution (PostgreSQL pgvector / MSSQL VECTOR_DISTANCE).
        try:
            if self._dialect == DIALECT_POSTGRES:
                op = "<=>" if distance_metric == "cosine" else ("<->" if distance_metric == "euclidean" else "<#>")
                query = f"SELECT *, ({field_sql} {op} %s::vector) AS distance FROM {self._table_sql}"
                query_params = [vec_json] + list(params.values())
                if where_sql:
                    query += f" WHERE {field_sql} IS NOT NULL AND ({where_sql})"
                else:
                    query += f" WHERE {field_sql} IS NOT NULL"
                query += f" ORDER BY distance ASC LIMIT {take}"
            else:
                placeholder = "?"
                query = f"SELECT TOP ({take}) *, VECTOR_DISTANCE('{distance_metric}', CAST({field_sql} AS VECTOR({dim}, float32)), CAST({placeholder} AS VECTOR({dim}, float32))) AS distance FROM {self._table_sql}{self._nolock}"
                query_params = [vec_json] + list(params.values())
                if where_sql:
                    query += f" WHERE {field_sql} IS NOT NULL AND ({where_sql})"
                else:
                    query += f" WHERE {field_sql} IS NOT NULL"
                query += " ORDER BY distance ASC"

            return self._adapter.exec(query, query_params)
        except Exception:
            pass

        # 3. Fallback: score the column in Python.
        return self._score_vectors_in_memory(vector, take, where, vector_field, distance_metric)

    def _score_vectors_in_memory(
        self,
        vector: List[float],
        take: int,
        where,
        vector_field: str,
        distance_metric: str,
    ) -> List[Dict]:
        """Ranks the vector column in Python.

        The last resort for every provider, and the only option on a SQLite
        connection that offers neither sqlite-vec, a driver function nor JSON1.
        The whole table is loaded, so it is only reasonable for a table small
        enough to fit in memory.
        """
        scored = []
        for row in self.find_many(where=where):
            vec = decode_vector(row.get(vector_field))
            if not vec or len(vec) != len(vector):
                continue
            dist = vector_distance(vector, vec, distance_metric)
            if dist is None:
                continue
            scored.append((row, dist))

        scored.sort(key=lambda x: x[1])
        return [{**row, "distance": dist} for row, dist in scored[:take]]


class ViewClient:
    """Read-only view client for querying database views without permitting mutations."""

    def __init__(self, adapter: Any, view_name: str):
        self._client = AdapterTableClient(adapter, view_name)
        self.view_name = view_name

    def find_many(self, *args, **kwargs):
        return self._client.find_many(*args, **kwargs)

    def find_first(self, *args, **kwargs):
        return self._client.find_first(*args, **kwargs)

    def find_unique(self, *args, **kwargs):
        return self._client.find_unique(*args, **kwargs)

    def count(self, *args, **kwargs):
        return self._client.count(*args, **kwargs)

    def aggregate(self, *args, **kwargs):
        return self._client.aggregate(*args, **kwargs)

    def group_by(self, *args, **kwargs):
        return self._client.group_by(*args, **kwargs)

    def vector_search(self, *args, **kwargs):
        return self._client.vector_search(*args, **kwargs)

    def create(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (create) are not allowed.")

    def create_many(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (create_many) are not allowed.")

    def update(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (update) are not allowed.")

    def update_many(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (update_many) are not allowed.")

    def delete(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (delete) are not allowed.")

    def delete_many(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (delete_many) are not allowed.")

    def upsert(self, *args, **kwargs):
        raise PermissionError(f"View '{self.view_name}' is read-only. Mutation operations (upsert) are not allowed.")
