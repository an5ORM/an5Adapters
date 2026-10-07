"""SQLite vector search — codec, distance functions and the strategy plan.

SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of little-endian
float32 values (see `encode_vector`) and is ranked in one of four ways, in this
order:

   1. ``sqlite-vec``  native scalar distance functions, when the extension loads.
   2. ``udf``         ``an5_vec_cosine`` / ``an5_vec_l2`` / ``an5_vec_ip``
      registered with the driver. Reads the BLOB and the legacy JSON text.
   3. ``sql``         ``json_each`` brute force in plain SQL. Needs no user
      function, but only reaches rows stored as JSON text.
   4. ``memory``      the column is loaded and scored in Python.

Strategies 1-3 rank inside the database and transfer only the matching rows,
which is why they are preferred over the in-memory path.
"""

import json
import math
import struct
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

METRIC_COSINE = "cosine"
METRIC_EUCLIDEAN = "euclidean"
METRIC_DOT = "dot"

# Scalar functions the adapter registers itself.
AN5_VECTOR_FUNCTIONS: Dict[str, str] = {
    METRIC_COSINE: "an5_vec_cosine",
    METRIC_EUCLIDEAN: "an5_vec_l2",
    METRIC_DOT: "an5_vec_ip",
}

# Scalar functions shipped by the sqlite-vec extension.
SQLITE_VEC_FUNCTIONS: Dict[str, str] = {
    METRIC_COSINE: "vec_distance_cosine",
    METRIC_EUCLIDEAN: "vec_distance_l2",
    METRIC_DOT: "vec_distance_ip",
}

STRATEGY_SQLITE_VEC = "sqlite-vec"
STRATEGY_UDF = "udf"
STRATEGY_SQL = "sql"
STRATEGY_MEMORY = "memory"

_BYTES_PER_FLOAT = 4
_FLOAT32 = struct.Struct("<f")


def normalize_metric(metric: Optional[str]) -> str:
    return metric if metric in (METRIC_EUCLIDEAN, METRIC_DOT) else METRIC_COSINE


# ─── Codec ───────────────────────────────────────────────────────────────────────


def parse_vector(value: Any) -> Optional[List[float]]:
    """Reads a numeric sequence, or JSON text holding one."""
    if value is None or isinstance(value, (str, bytes, bytearray, memoryview)):
        if isinstance(value, (bytes, bytearray, memoryview)):
            return None
        text = str(value).strip()
        if not text.startswith("["):
            return None
        try:
            return parse_vector(json.loads(text))
        except Exception:
            return None
    if isinstance(value, dict):
        return None
    try:
        values = [float(v) for v in value]
    except (TypeError, ValueError):
        return None
    if not values or any(math.isnan(v) or math.isinf(v) for v in values):
        return None
    return values


def decode_vector(value: Any) -> Optional[List[float]]:
    """Decodes a stored vector: float32 BLOB, legacy JSON text, or a sequence."""
    direct = parse_vector(value)
    if direct:
        return direct
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        if not raw or len(raw) % _BYTES_PER_FLOAT != 0:
            return None
        count = len(raw) // _BYTES_PER_FLOAT
        return list(_FLOAT32.unpack_from(raw, i * _BYTES_PER_FLOAT)[0] for i in range(count))
    return None


def encode_vector(values: Sequence[float]) -> bytes:
    """Encodes a vector as the little-endian float32 BLOB the column stores."""
    return b"".join(_FLOAT32.pack(float(v)) for v in values)


def needs_vector_encoding(value: Any) -> bool:
    """True when the value still has to become bytes on its way into a column."""
    if isinstance(value, (bytes, bytearray, memoryview, str)):
        return False
    if value is None:
        return False
    return isinstance(value, (list, tuple)) or (
        hasattr(value, "__iter__") and not isinstance(value, (dict, int, float, bool))
    )


def is_vector_field(definition: Any) -> bool:
    """True when generated metadata describes a `VECTOR(n)` column."""
    if not definition:
        return False
    if isinstance(definition, str):
        return "[]" in definition or definition.strip().upper().startswith("VECTOR")
    if not isinstance(definition, dict):
        return False
    if definition.get("kind") == "vector":
        return True
    sql = str(definition.get("sql") or definition.get("type") or "")
    if sql.strip().upper().startswith("VECTOR") and sql.strip()[6:7] in ("", "("):
        return True
    return "[]" in str(definition.get("ts") or "")


# ─── Distance ─────────────────────────────────────────────────────────────────────


def vector_distance(a: Sequence[float], b: Sequence[float], metric: str) -> Optional[float]:
    """Distance between two equal-length vectors, lower is closer.

    Mirrors the SQL functions so a search ranks the same way whichever strategy
    ran.
    """
    if a is None or b is None or len(a) != len(b) or len(a) == 0:
        return None
    resolved = normalize_metric(metric)
    if resolved == METRIC_EUCLIDEAN:
        return math.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b)))
    dot = sum(float(x) * float(y) for x, y in zip(a, b))
    if resolved == METRIC_DOT:
        return -dot
    m1 = math.sqrt(sum(float(x) ** 2 for x in a))
    m2 = math.sqrt(sum(float(y) ** 2 for y in b))
    if not m1 or not m2:
        return 1.0
    return 1.0 - dot / (m1 * m2)


def make_distance_function(metric: str) -> Callable[[Any, Any], Optional[float]]:
    """The scalar function registered with the driver for one metric."""

    def distance(left: Any, right: Any) -> Optional[float]:
        a = decode_vector(left)
        b = decode_vector(right)
        if not a or not b:
            return None
        return vector_distance(a, b, metric)

    return distance


# ─── Query building ───────────────────────────────────────────────────────────────


def _json_text(column: str) -> str:
    """`json_valid` fails on a float32 BLOB, so the JSON path needs this guard."""
    return f"CASE WHEN json_valid({column}) THEN {column} ELSE '[]' END"


def _json_distance_expr(metric: str, column: str) -> str:
    row = _json_text(column)
    same_length = f"(SELECT COUNT(*) FROM json_each({row})) = (SELECT COUNT(*) FROM q)"
    terms = {
        METRIC_COSINE: (
            f"1.0 - (SELECT SUM(je.value * q.v) FROM json_each({row}) je JOIN q ON q.k = je.key)"
            f" / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q))"
            f" * sqrt((SELECT SUM(je.value * je.value) FROM json_each({row}) je)), 0)"
        ),
        METRIC_EUCLIDEAN: (
            f"sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v))"
            f" FROM json_each({row}) je JOIN q ON q.k = je.key))"
        ),
        METRIC_DOT: f"-(SELECT SUM(je.value * q.v) FROM json_each({row}) je JOIN q ON q.k = je.key)",
    }
    return f"CASE WHEN {same_length} THEN {terms[metric]} END"


def build_sqlite_vector_query(
    strategy: str,
    metric: str,
    table: str,
    column: str,
    vector: Sequence[float],
    take: int,
    tail: str = "",
    params: Optional[List] = None,
) -> Tuple[str, List]:
    """Ranking SQL for one strategy, with the query vector appended to `params`.

    `sqlite-vec` and `udf` bind the query vector as a float32 BLOB; `sql` binds
    it as JSON text because `json_each` reads text.
    """
    bound = []
    metric = normalize_metric(metric)

    def rank(inner: str) -> str:
        # A row whose stored vector cannot be scored (a NULL, a text column,
        # another dimension) yields a NULL distance; those rows are dropped
        # rather than reported, so a caller never has to sort them out.
        return (f"SELECT * FROM ({inner}) AS an5_ranked"
                f" WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT {int(take)}")


    if strategy == STRATEGY_SQLITE_VEC:
        bound.append(encode_vector(vector))
        distance = f"CASE WHEN vec_length(vec_f32({column})) = {len(vector)} THEN {SQLITE_VEC_FUNCTIONS[metric]}(vec_f32({column}), ?) END"
        # vec_f32 accepts both JSON text and float32 BLOBs.
        query = rank(
            f"SELECT *, {distance} AS distance FROM {table}"
            + (tail + " AND " if tail else " WHERE ")
            + f"{column} IS NOT NULL"
        )
        return query, bound + list(params or [])

    if strategy == STRATEGY_UDF:
        bound.append(encode_vector(vector))
        distance = f"{AN5_VECTOR_FUNCTIONS[metric]}({column}, ?)"
        return rank(f"SELECT *, {distance} AS distance FROM {table}{tail}"), bound + list(params or [])

    bound.append(json.dumps(list(vector)))
    query = (
        "WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v FROM json_each(?) je) "
        + rank(f"SELECT *, {_json_distance_expr(metric, column)} AS distance FROM {table}{tail}")
    )
    return query, bound + list(params or [])


# ─── Capabilities ──────────────────────────────────────────────────────────────────


def plan_sqlite_vector_strategies(
    capabilities: Dict[str, bool],
    declared_type: Optional[str],
    preference: Optional[str] = None,
) -> List[str]:
    """The ordered strategies to try for this connection.

    `declared_type` is the column's DDL type: the JSON strategy only reaches rows
    stored as text, so a `BLOB` column drops it from the order.
    """
    if preference and preference != "auto":
        # `memory` is the caller's own path, not a query, so it yields no plan.
        return [] if preference == STRATEGY_MEMORY else [preference]
    available: List[str] = []
    if capabilities.get("vec"):
        available.append(STRATEGY_SQLITE_VEC)
    if capabilities.get("udf"):
        available.append(STRATEGY_UDF)
    if capabilities.get("json1"):
        available.append(STRATEGY_SQL)
    declared = str(declared_type or "").upper()
    if declared and not any(token in declared for token in ("TEXT", "CHAR", "CLOB", "STRING", "JSON")):
        # A BLOB column has no JSON to read, so json_each can only produce NULLs.
        return [s for s in available if s != STRATEGY_SQL]
    return available


def read_sqlite_column_type(
    exec_fn: Callable[[str, List], List[Dict]],
    table: str,
    column: str,
) -> Optional[str]:
    """Reads a vector column's declared DDL type, or None when it is not found."""
    try:
        rows = exec_fn("SELECT type FROM pragma_table_info(?) WHERE name = ?", [table, column])
    except Exception:
        return None
    value = rows[0].get("type") if rows else None
    return str(value) if value else None


class SqliteVectorSupport:
    """Registers the distance functions and loads sqlite-vec for a connection."""

    def __init__(
        self,
        native: Optional[Callable[[], Any]] = None,
        register_function: Optional[Callable[[str, Callable], None]] = None,
        sqlite_vec: Optional[str] = None,
    ):
        self._native = native
        self._register_function = register_function
        self._sqlite_vec = sqlite_vec
        self._capabilities: Optional[Dict[str, bool]] = None
        # Declared column types and the "any binary row" probe, keyed by column.
        # Both cost a query and neither changes while a schema is in use; a stale
        # answer is still safe, because a strategy that fails falls through to the
        # next one rather than reporting a wrong result.
        self._column_types: Dict[str, Optional[str]] = {}
        self._has_binary_rows: Dict[str, bool] = {}

    def column_type(self, exec_fn, table: str, column: str) -> Optional[str]:
        """The column's declared DDL type, remembered per column."""
        key = f"{table}.{column}"
        if key not in self._column_types:
            self._column_types[key] = read_sqlite_column_type(exec_fn, table, column)
        return self._column_types[key]

    def has_binary_rows(self, exec_fn, table: str, column: str, tail: str, params: List) -> bool:
        """Whether any row stores raw bytes, which `json_each` cannot read.

        Checked only for the `sql` strategy, where a legacy JSON column that has
        since taken new float32 rows would otherwise rank just the old ones.
        """
        key = f"{table}.{column}"
        if key not in self._has_binary_rows:
            clause = (tail + " AND ") if tail else " WHERE "
            try:
                rows = exec_fn(
                    f"SELECT 1 FROM {table}{clause}typeof({column}) = 'blob' LIMIT 1",
                    list(params))
                self._has_binary_rows[key] = bool(rows)
            except Exception:
                self._has_binary_rows[key] = False
        return self._has_binary_rows[key]

    def capabilities(self) -> Dict[str, bool]:
        """Probes once and caches the answer."""
        if self._capabilities is not None:
            return self._capabilities

        caps = {"vec": False, "udf": False, "json1": False}
        native = self._native() if self._native else None
        if native is not None:
            if self._sqlite_vec and hasattr(native, "enable_load_extension"):
                try:
                    native.enable_load_extension(True)
                    native.load_extension(self._sqlite_vec)
                except Exception:
                    pass
                finally:
                    try:
                        native.enable_load_extension(False)
                    except Exception:
                        pass
            try:
                native.execute("SELECT vec_version()").fetchone()
                caps["vec"] = True
            except Exception:
                caps["vec"] = False
            try:
                native.execute("SELECT an5_vector_version()").fetchone()
                caps["udf"] = True
                caps["vec"] = False
            except Exception:
                pass

        if self._register_function and not caps["udf"]:
            try:
                for metric, name in AN5_VECTOR_FUNCTIONS.items():
                    self._register_function(name, make_distance_function(metric))
                caps["udf"] = True
            except Exception:
                caps["udf"] = False

        self._capabilities = caps
        return caps

    def probe(self, exec_fn: Callable[[str, List], List[Dict]]) -> Dict[str, bool]:
        """Confirms JSON1 before a query is built that needs it."""
        caps = self.capabilities()
        if not caps["json1"]:
            try:
                exec_fn("SELECT json_valid('[1]') AS an5_json_ok", [])
                caps["json1"] = True
            except Exception:
                caps["json1"] = False
        return caps


def run_sqlite_vector_search(
    exec_fn: Callable[[str, List], List[Dict]],
    table: str,
    raw_table: str,
    column: str,
    raw_column: str,
    vector: Sequence[float],
    metric: str,
    take: int,
    tail: str = "",
    params: Optional[List] = None,
    support: Optional[SqliteVectorSupport] = None,
    preference: Optional[str] = None,
) -> Optional[List[Dict]]:
    """Ranks a SQLite table inside the database.

    Returns None when the connection offers no strategy, so the caller can fall
    back to scoring in memory.
    """
    if vector is None or len(vector) == 0:
        return None

    if support is not None:
        caps = support.probe(exec_fn)
    else:
        try:
            exec_fn("SELECT json_valid('[1]') AS an5_json_ok", [])
            caps = {"vec": False, "udf": False, "json1": True}
        except Exception:
            caps = {"vec": False, "udf": False, "json1": False}

    declared = (support.column_type(exec_fn, raw_table, raw_column)
                if support is not None
                else read_sqlite_column_type(exec_fn, raw_table, raw_column))
    for strategy in plan_sqlite_vector_strategies(caps, declared, preference):
        if strategy == STRATEGY_SQL:
            binary = (support.has_binary_rows(exec_fn, raw_table, raw_column, tail, list(params or []))
                      if support is not None
                      else bool(exec_fn("SELECT 1 FROM " + table + (tail + " AND " if tail else " WHERE ")
                                        + f"typeof({column}) = 'blob' LIMIT 1", list(params or []))))
            if binary:
                continue
        query, bound = build_sqlite_vector_query(
            strategy, metric, table, column, vector, take, tail, list(params or [])
        )
        try:
            return exec_fn(query, bound)
        except Exception:
            # The driver advertised the capability but the query failed, e.g. an
            # extension that did not really load. The next strategy is cheaper
            # than reporting the failure, and memory is the last resort.
            continue
    return None
