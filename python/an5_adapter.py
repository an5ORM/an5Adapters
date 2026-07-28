"""Standalone Python runtime adapter for AN5 ORM."""

from typing import Dict, List, Optional

try:
    from .base import DIALECT_MSSQL, DIALECT_POSTGRES, detect_dialect, set_adapter_metadata
    from .mssql import connect as connect_mssql
    from .postgres import connect as connect_postgres
    from .table_client import AdapterTableClient
except ImportError:
    from base import DIALECT_MSSQL, DIALECT_POSTGRES, detect_dialect, set_adapter_metadata
    from mssql import connect as connect_mssql
    from postgres import connect as connect_postgres
    from table_client import AdapterTableClient

# Backward-compatible aliases used by tests and older imports.
_detect_dialect = detect_dialect
try:
    from .mssql import parse_connection_string as _parse_connection_string
except ImportError:
    from mssql import parse_connection_string as _parse_connection_string

class An5Adapter:
    def __init__(self, connection_string: str):
        self._dialect = detect_dialect(connection_string)
        self._conn_str = connection_string

    def _connect(self):
        if self._dialect == DIALECT_POSTGRES:
            return connect_postgres(self._conn_str)
        return connect_mssql(self._conn_str)

    def _to_dicts(self, cursor, query: str) -> List[Dict]:
        if cursor.description:
            cols = [col[0] for col in cursor.description]
            rows = cursor.fetchall() if cursor.description else []
            return [dict(zip(cols, row)) for row in rows]
        return []

    def exec(self, query: str, params: Optional[List] = None) -> List[Dict]:
        conn = self._connect()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params or [])
            return self._to_dicts(cursor, query)
        finally:
            conn.close()

    def execute(self, query: str, params: Optional[List] = None) -> int:
        conn = self._connect()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params or [])
            return cursor.rowcount
        finally:
            conn.close()

    def query_raw(self, query: str, *values) -> List[Dict]:
        return self.exec(query, list(values))

    def execute_raw(self, query: str, *values) -> int:
        return self.execute(query, list(values))

    def table(self, model_name: str) -> AdapterTableClient:
        return AdapterTableClient(self, model_name)

    def __getattr__(self, model_name: str) -> AdapterTableClient:
        return self.table(model_name)

    def transaction(self, fn):
        conn = self._connect()
        conn.autocommit = False
        try:
            result = fn(self)
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            if self._dialect == DIALECT_POSTGRES:
                conn.autocommit = True
            conn.close()

def create_an5_adapter(connection_string: str) -> An5Adapter:
    return An5Adapter(connection_string)

__all__ = [
    "An5Adapter",
    "AdapterTableClient",
    "create_an5_adapter",
    "DIALECT_MSSQL",
    "DIALECT_POSTGRES",
    "_detect_dialect",
    "_parse_connection_string",
    "set_adapter_metadata",
]
