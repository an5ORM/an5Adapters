import json
import uuid
from typing import Dict, List, Optional
from .base import DIALECT_MSSQL, DIALECT_POSTGRES, model_fields, _build_order_by, _parse_where, _quote, _quote_table, _resolve_table

# ─── Table Client ───────────────────────────────────────────────────────────────────

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

    def _pagination(self, take: Optional[int], skip: int, order_sql: str) -> str:
        if take is None:
            return ""
        if self._dialect == DIALECT_POSTGRES:
            return f" LIMIT {take} OFFSET {skip}"
        o = order_sql or " ORDER BY (SELECT NULL)"
        return f"{o} OFFSET {skip} ROWS FETCH NEXT {take} ROWS ONLY"

    def find_many(self, where=None, order_by=None, skip: int = 0, take: Optional[int] = None, select=None) -> List[Dict]:
        params: Dict = {}
        where_sql = _parse_where(self._model, where, params, self._dialect)
        order_sql = _build_order_by(order_by, self._dialect)

        query = f"SELECT * FROM {self._table_sql}{self._nolock}"
        if where_sql:
            query += f" WHERE {where_sql}"
        if take is not None and self._dialect == DIALECT_POSTGRES:
            query += self._pagination(take, skip, order_sql)
        else:
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
        fields = model_fields.get(self._model, [])
        id_field = next((f for f in fields if f.get("isId")), None)
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
        placeholder = "?" if self._dialect == DIALECT_MSSQL else "%s"
        for col, val in data.items():
            if val is not None:
                set_parts.append(f"{_quote(col, self._dialect)} = {placeholder}")
                set_values.append(val)

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
        placeholder = "?" if self._dialect == DIALECT_MSSQL else "%s"
        for col, val in data.items():
            set_parts.append(f"{_quote(col, self._dialect)} = {placeholder}")
            set_values.append(val)
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
            for f in (_sum if isinstance(_sum, list) else [_sum]):
                aggs.append(f"SUM({_quote(f, self._dialect)}) AS _sum_{f}")
        if _avg:
            for f in (_avg if isinstance(_avg, list) else [_avg]):
                aggs.append(f"AVG({_quote(f, self._dialect)}) AS _avg_{f}")
        if _min:
            for f in (_min if isinstance(_min, list) else [_min]):
                aggs.append(f"MIN({_quote(f, self._dialect)}) AS _min_{f}")
        if _max:
            for f in (_max if isinstance(_max, list) else [_max]):
                aggs.append(f"MAX({_quote(f, self._dialect)}) AS _max_{f}")
        if not aggs:
            aggs = ["COUNT(*) AS _count"]

        query = f"SELECT {', '.join(aggs)} FROM {self._table_sql}"
        if where_sql:
            query += f" WHERE {where_sql}"
        rows = self._adapter.exec(query, list(params.values()))
        return rows[0] if rows else {}

    def vector_search(self, vector: List[float], take: int = 10, where=None, vector_field: str = "embedding", distance_metric: str = "cosine") -> List[Dict]:
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


