"""SQLite provider — uses the standard library `sqlite3`, no extra driver needed.

Why it exists: `base/dialects.py` already had `DIALECT_SQLITE` and the SQL layer
already used the `?` placeholder for it, but with no provider `An5Adapter._connect`
fell back to MSSQL — every statement then carried `WITH (NOLOCK)` and
`OFFSET ... FETCH NEXT`, SQL SQLite does not understand, failing on the first one.

Why `isolation_level=None`: `sqlite3` opens an implicit transaction before each DML
statement by default, so `An5Adapter.exec` (which opens/closes a connection per
statement) would leave transactions dangling. `None` means autocommit, matching the
`pyodbc.connect(..., autocommit=True)` of the MSSQL provider.
"""

import sqlite3
from typing import Tuple

# Strip the `sqlite:`/`sqlite://`/`sqlite:///` wrapper first, only then look for
# `file:`. Two steps are required because `sqlite:file::memory:?cache=shared` only
# becomes a URI after `sqlite:` is removed; checking once would miss it and sqlite3
# would treat the whole thing as a file name.
_SQLITE_PREFIXES = ("sqlite:///", "sqlite://", "sqlite:")
_FILE_PREFIX = "file:"


def parse_connection_string(url: str) -> Tuple[str, bool]:
    """Returns (path/URI, whether sqlite3 should treat it as a URI).

    Accepts `sqlite:///path`, `sqlite:path`, `file:path` and a bare path.
    `file:` has to return URI=True because sqlite3 only understands URIs with the
    `uri` flag on.
    """
    value = (url or "").strip()
    for prefix in _SQLITE_PREFIXES:
        if value.lower().startswith(prefix):
            value = value[len(prefix):]
            break
    is_uri = value.lower().startswith(_FILE_PREFIX)
    if is_uri:
        # Keep the `file:` prefix — sqlite3 needs the full URI form
        # (`file::memory:?cache=shared`); without it `:memory:?cache=shared` is
        # no longer a valid URI.
        return value, True
    # On Windows `sqlite:///C:/path/x.db` is left with `/C:/path/x.db`; the
    # leading slash belongs to the URL, not to the path.
    if len(value) > 2 and value[0] == "/" and value[2] == ":":
        value = value[1:]
    return value or ":memory:", is_uri


def is_memory(url: str) -> bool:
    """An in-memory database does not survive every connection being closed.

    The adapter opens/closes a connection per statement, so with a plain
    `:memory:` the data disappears after the first statement (the table just
    CREATEd is gone). The adapter therefore has to hold a long-lived connection
    for this case; see `An5Adapter._acquire`.
    """
    target, is_uri = parse_connection_string(url)
    if is_uri:
        # `parse_connection_string` returns the whole URI (with `file:`).
        inner = target[len(_FILE_PREFIX):] if target.lower().startswith(_FILE_PREFIX) else target
        return inner.startswith(":memory:") or "mode=memory" in inner
    return target == ":memory:"

def connect(connection_string: str):
    target, is_uri = parse_connection_string(connection_string)
    conn = sqlite3.connect(
        target,
        isolation_level=None,
        check_same_thread=False,
        uri=is_uri,
    )
    # There is no `NOLOCK`; WAL lets concurrent readers and writers proceed
    # without blocking each other, and foreign_keys is enabled because SQLite
    # defaults it OFF (unlike every other dialect).
    conn.execute("PRAGMA foreign_keys = ON")
    if not is_memory(connection_string) and not is_uri:
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


def placeholder() -> str:
    return "?"
