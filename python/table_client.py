import json
import uuid
from typing import Any, Dict, List, Optional
try:
    from .base import DIALECT_MSSQL, DIALECT_POSTGRES, model_fields, _build_order_by, _parse_where, _quote, _quote_table, _resolve_table
except ImportError:
    from base import DIALECT_MSSQL, DIALECT_POSTGRES, model_fields, _build_order_by, _parse_where, _quote, _quote_table, _resolve_table

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
    placeholder = "?" if dialect == DIALECT_MSSQL else "%s"
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


class AdapterTableClient:
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
        return "" if self._dialect == DIALECT_POSTGRES else " WITH (NOLOCK)"

    @property
    def _fields(self) -> List[Dict]:
        fields = model_fields.get(self._model, [])
        if isinstance(fields, dict):
            raise TypeError(
                "AN5 Python metadata is out of date. Regenerate with @an5/orm >= 1.0.4 "
                "so MODEL_FIELDS uses a list of field objects."
            )
        return fields

    def _pagination(self, take: Optional[int], skip: int, order_sql: str) -> str:
        if take is None:
            return ""
        if self._dialect == DIALECT_POSTGRES:
            return f" LIMIT {take} OFFSET {skip}"
        order_prefix = "" if order_sql else " ORDER BY (SELECT NULL)"
        return f"{order_prefix} OFFSET {skip} ROWS FETCH NEXT {take} ROWS ONLY"

    def find_many(self, where=None, order_by=None, skip: int = 0, take: Optional[int] = None, select=None) -> List[Dict]:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        order_sql = _build_order_by(order_by, self._dialect)

        query = f"SELECT * FROM {self._table_sql}{self._nolock}"
        if where_sql:
            query += f" WHERE {where_sql}"
        if order_sql:
            query += f" {order_sql}"
        query += self._pagination(take, skip, order_sql)
        return self._adapter.exec(query, list(params.values()))

    def find_first(self, where=None, order_by=None, select=None) -> Optional[Dict]:
        rows = self.find_many(where=where, order_by=order_by, take=1, select=select)
        return rows[0] if rows else None

    def find_unique(self, where: Dict) -> Optional[Dict]:
        return self.find_first(where=where)

    def count(self, where=None) -> int:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        query = f"SELECT COUNT(*) AS cnt FROM {self._table_sql}{self._nolock}"
        if where_sql:
            query += f" WHERE {where_sql}"
        rows = self._adapter.exec(query, list(params.values()))
        return int(rows[0]["cnt"]) if rows else 0

    def create(self, data: Dict) -> Dict:
        id_field = next((f for f in self._fields if f.get("isId")), None)
        if id_field and id_field["name"] not in data:
            data = {**data, id_field["name"]: str(uuid.uuid4())}

        cols = [k for k, v in data.items() if v is not None]
        values = [data[c] for c in cols]
        placeholders = ", ".join(["?" if self._dialect == DIALECT_MSSQL else "%s"] * len(cols))
        col_list = ", ".join(_quote(c, self._dialect) for c in cols)
        query = f"INSERT INTO {self._table_sql} ({col_list}) VALUES ({placeholders})"
        self._adapter.execute(query, values)

        if id_field:
            return self.find_first(where={id_field["name"]: data[id_field["name"]]}) or data
        return data

    def create_many(self, data: List[Dict], skip_duplicates: bool = False) -> Dict:
        count = 0
        for row in data:
            try:
                self.create(row)
                count += 1
            except Exception:
                if not skip_duplicates:
                    raise
        return {"count": count}

    def update(self, where: Dict, data: Dict) -> Optional[Dict]:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect, "w_")
        set_parts: List[str] = []
        set_values: List = []
        for col, val in data.items():
            if val is not None:
                _append_update_set(set_parts, set_values, col, val, self._dialect)

        if not set_parts:
            return self.find_first(where=where)

        all_values = set_values + list(params.values())
        query = f"UPDATE {self._table_sql} SET {', '.join(set_parts)}"
        if where_sql:
            query += f" WHERE {where_sql}"
        self._adapter.execute(query, all_values)
        return self.find_first(where=where)

    def update_many(self, where: Optional[Dict], data: Dict) -> Dict:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect, "w_")
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

    def delete(self, where: Dict) -> Optional[Dict]:
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

    def upsert(self, where: Dict, create: Dict, update: Dict) -> Dict:
        existing = self.find_first(where=where)
        if existing:
            return self.update(where=where, data=update) or existing
        return self.create(data=create)

    def aggregate(self, where=None, _count=None, _sum=None, _avg=None, _min=None, _max=None) -> Dict:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        aggs: List[str] = []
        if _count:
            aggs.append("COUNT(*) AS _count")
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
        return rows[0] if rows else {}

    def group_by(self, by, where=None, order_by=None, skip: int = 0, take: Optional[int] = None,
                 _sum=None, _avg=None, _min=None, _max=None) -> List[Dict]:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        by_fields = _normalize_by_fields(by)
        if not by_fields:
            raise ValueError("group_by requires 'by' fields")

        by_cols = ", ".join(_quote(f, self._dialect) for f in by_fields)
        aggs = ["COUNT(*) AS _count"]
        for f in _selected_aggregate_fields(_sum):
            aggs.append(f"SUM({_quote(f, self._dialect)}) AS _sum_{f}")
        for f in _selected_aggregate_fields(_avg):
            aggs.append(f"AVG({_quote(f, self._dialect)}) AS _avg_{f}")
        for f in _selected_aggregate_fields(_min):
            aggs.append(f"MIN({_quote(f, self._dialect)}) AS _min_{f}")
        for f in _selected_aggregate_fields(_max):
            aggs.append(f"MAX({_quote(f, self._dialect)}) AS _max_{f}")

        query = f"SELECT {by_cols}, {', '.join(aggs)} FROM {self._table_sql}"
        if where_sql:
            query += f" WHERE {where_sql}"
        query += f" GROUP BY {by_cols}"
        order_sql = _build_order_by(order_by, self._dialect)
        has_take = take is not None
        has_skip = skip is not None and skip > 0
        if order_sql:
            query += f" {order_sql}"
        elif has_take or has_skip:
            query += f" ORDER BY {by_cols}"
        if has_take or has_skip:
            final_skip = _to_non_negative_int(skip)
            if self._dialect == DIALECT_POSTGRES:
                if has_take:
                    query += f" LIMIT {_to_non_negative_int(take, 1)}"
                query += f" OFFSET {final_skip}"
            else:
                query += f" OFFSET {final_skip} ROWS"
                if has_take:
                    query += f" FETCH NEXT {_to_non_negative_int(take, 1)} ROWS ONLY"

        return self._adapter.exec(query, list(params.values()))

    def vector_search(self, vector: List[float], take: int = 10, where=None, vector_field: str = "embedding", distance_metric: str = "cosine") -> List[Dict]:
        dim = len(vector)
        vec_json = json.dumps(vector)
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)

        # 1. Primary path: Native database SQL vector query execution (MSSQL VECTOR_DISTANCE / Postgres pgvector)
        try:
            field_sql = _quote(vector_field, self._dialect)
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

            native_rows = self._adapter.exec(query, query_params)


            if native_rows is not None:
                return native_rows
        except Exception:
            pass

        # 2. Secondary fallback: In-memory similarity computation if DB engine lacks native vector extension
        rows = self.find_many(where=where)
        scored = []
        for row in rows:
            raw = row.get(vector_field)
            if raw is None:
                continue
            try:
                vec = json.loads(raw) if isinstance(raw, str) else list(raw)
            except Exception:
                continue
            if not vec or len(vec) != len(vector):
                continue

            dot = sum(a * b for a, b in zip(vector, vec))
            m1 = sum(a ** 2 for a in vector) ** 0.5
            m2 = sum(b ** 2 for b in vec) ** 0.5
            cosine = dot / (m1 * m2) if m1 and m2 else 0.0

            if distance_metric == "cosine":
                dist = 1.0 - cosine
            elif distance_metric == "dot":
                dist = -dot
            else:
                dist = sum((a - b) ** 2 for a, b in zip(vector, vec)) ** 0.5

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
