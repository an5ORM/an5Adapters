"""Standalone Python runtime adapter for AN5 ORM."""

from typing import Dict, List, Optional, Any

try:
    from .base import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE, detect_dialect, set_adapter_metadata
    from .mssql import connect as connect_mssql
    from .postgres import connect as connect_postgres
    from .sqlite import connect as connect_sqlite, is_memory as is_sqlite_memory
    from .table_client import AdapterTableClient, ViewClient
except ImportError:
    from base import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE, detect_dialect, set_adapter_metadata
    from mssql import connect as connect_mssql
    from postgres import connect as connect_postgres
    from sqlite import connect as connect_sqlite, is_memory as is_sqlite_memory
    from table_client import AdapterTableClient, ViewClient

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
        # The open connection of `transaction()`, when there is one. Every
        # statement in the callback has to use this very connection, otherwise a
        # rollback returns to a different, already committed connection — that
        # is "the error was raised but the data is still there".
        self._txn_conn = None
        # Long-lived connection for in-memory databases, because `:memory:` is
        # gone as soon as every connection is closed.
        self._conn = None

    def _connect(self):
        if self._dialect == DIALECT_POSTGRES:
            return connect_postgres(self._conn_str)
        if self._dialect == DIALECT_SQLITE:
            return connect_sqlite(self._conn_str)
        return connect_mssql(self._conn_str)

    def _acquire(self):
        """Returns (connection, whether we opened it and must close it)."""
        if self._txn_conn is not None:
            return self._txn_conn, False
        if self._dialect == DIALECT_SQLITE and is_sqlite_memory(self._conn_str):
            if self._conn is None:
                self._conn = self._connect()
            return self._conn, False
        return self._connect(), True

    def close(self):
        """Closes the long-lived connection (in-memory databases only)."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _to_dicts(self, cursor, query: str) -> List[Dict]:
        if cursor.description:
            cols = [col[0] for col in cursor.description]
            rows = cursor.fetchall() if cursor.description else []
            return [dict(zip(cols, row)) for row in rows]
        return []

    def exec(self, query: str, params: Optional[List] = None) -> List[Dict]:
        conn, owned = self._acquire()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params or [])
            return self._to_dicts(cursor, query)
        finally:
            if owned:
                conn.close()

    def execute(self, query: str, params: Optional[List] = None) -> int:
        conn, owned = self._acquire()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params or [])
            return cursor.rowcount
        finally:
            if owned:
                conn.close()

    def query_raw(self, query: str, *values) -> List[Dict]:
        return self.exec(query, list(values))

    def execute_raw(self, query: str, *values) -> int:
        return self.execute(query, list(values))

    def table(self, model_name: str) -> AdapterTableClient[Any]:
        return AdapterTableClient(self, model_name)

    def view(self, view_name: str) -> ViewClient:
        return ViewClient(self, view_name)

    def query_proc(self, proc_name: str, params: Optional[List] = None) -> List[Dict]:
        if self._dialect == DIALECT_SQLITE:
            # SQLite has no stored procedures. This used to fall through to the
            # MSSQL branch and generate `EXEC ...`, which is not valid SQL, and
            # the error only surfaced at the call. Saying so beats sending wrong
            # SQL.
            raise NotImplementedError(
                "SQLite has no stored procedures. Use the generated table client "
                "(db.<model>.*) or db.exec() with a parameterised query."
            )
        if self._dialect == DIALECT_POSTGRES:
            placeholders = ", ".join(["%s"] * len(params or []))
            sql = f"CALL {proc_name}({placeholders})" if placeholders else f"CALL {proc_name}()"
        else:
            placeholders = ", ".join(["?"] * len(params or []))
            sql = f"EXEC {proc_name} {placeholders}" if placeholders else f"EXEC {proc_name}"
        return self.exec(sql, params or [])

    def execute_proc(self, proc_name: str, params: Optional[List] = None) -> int:
        if self._dialect == DIALECT_SQLITE:
            raise NotImplementedError(
                "SQLite has no stored procedures. Use the generated table client "
                "(db.<model>.*) or db.execute() with a parameterised query."
            )
        if self._dialect == DIALECT_POSTGRES:
            placeholders = ", ".join(["%s"] * len(params or []))
            sql = f"CALL {proc_name}({placeholders})" if placeholders else f"CALL {proc_name}()"
        else:
            placeholders = ", ".join(["?"] * len(params or []))
            sql = f"EXEC {proc_name} {placeholders}" if placeholders else f"EXEC {proc_name}"
        return self.execute(sql, params or [])

    def __getattr__(self, model_name: str) -> AdapterTableClient:
        return self.table(model_name)

    def transaction(self, fn):
        if self._txn_conn is not None:
            raise RuntimeError("Nested transaction() is not supported")
        # In-memory database: the connection holding the data has to be reused.
        # Opening a new one here points at a different, empty database — the
        # table just created disappears and every statement in the transaction
        # fails.
        conn = self._conn if self._conn is not None else self._connect()
        owned = self._conn is None
        if self._dialect == DIALECT_SQLITE:
            # `sqlite3.Connection` has no `autocommit` attribute; transactions
            # are driven by `isolation_level`. The provider opens at `None`
            # (autocommit), so to get a transaction it has to be set back to `""`
            # and sqlite3 opens an implicit BEGIN before each DML statement —
            # only then do `commit()`/`rollback()` do anything.
            conn.isolation_level = ""
        else:
            conn.autocommit = False
        self._txn_conn = conn
        try:
            result = fn(self)
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            self._txn_conn = None
            if self._dialect == DIALECT_POSTGRES:
                conn.autocommit = True
            elif self._dialect == DIALECT_SQLITE:
                conn.isolation_level = None
            if owned:
                conn.close()

def create_an5_adapter(connection_string: str) -> An5Adapter:
    return An5Adapter(connection_string)

__all__ = [
    "An5Adapter",
    "AdapterTableClient",
    "ViewClient",
    "create_an5_adapter",
    "DIALECT_MSSQL",
    "DIALECT_POSTGRES",
    "DIALECT_SQLITE",
    "_detect_dialect",
    "_parse_connection_string",
    "set_adapter_metadata",
]
