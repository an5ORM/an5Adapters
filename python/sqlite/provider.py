"""SQLite provider — dùng `sqlite3` của thư viện chuẩn, không cần driver cài thêm.

Vì sao thêm: `base/dialects.py` đã có `DIALECT_SQLITE` và tầng SQL đã dùng
placeholder `?` cho nó, nhưng không có provider nên `An5Adapter._connect` rơi về
MSSQL — mọi câu lệnh sẽ mang `WITH (NOLOCK)` và `OFFSET ... FETCH NEXT`, SQL mà
SQLite không hiểu, lỗi ngay ở câu đầu tiên.

Vì sao `isolation_level=None`: `sqlite3` mặc định mở transaction ngầm trước mỗi
câu DML, nên `An5Adapter.exec` (mở/đóng connection mỗi lần) sẽ để lại transaction
treo. `None` = autocommit, khớp với `pyodbc.connect(..., autocommit=True)` của
provider MSSQL.
"""

import sqlite3
from typing import Tuple

# Bỏ wrapper `sqlite:`/`sqlite://`/`sqlite:///` trước, rồi mới xét `file:`.
# Phải làm hai bước vì `sqlite:file::memory:?cache=shared` chỉ thành URI sau khi
# đã cắt `sqlite:`; xét một lượt sẽ bỏ sót nên sqlite3 tưởng đó là tên tệp.
_SQLITE_PREFIXES = ("sqlite:///", "sqlite://", "sqlite:")
_FILE_PREFIX = "file:"


def parse_connection_string(url: str) -> Tuple[str, bool]:
    """Trả về (đường dẫn/URI, có_phải_URI_cho_sqlite3).

    Chấp nhận `sqlite:///path`, `sqlite:path`, `file:path` và đường dẫn trần.
    `file:` phải trả về URI=True vì sqlite3 chỉ hiểu URI khi bật cờ `uri`.
    """
    value = (url or "").strip()
    for prefix in _SQLITE_PREFIXES:
        if value.lower().startswith(prefix):
            value = value[len(prefix):]
            break
    is_uri = value.lower().startswith(_FILE_PREFIX)
    if is_uri:
        # Giữ nguyên tiền tố `file:` — sqlite3 cần đúng dạng URI đầy đủ
        # (`file::memory:?cache=shared`), cắt đi thành `:memory:?cache=shared`
        # sẽ không còn là URI hợp lệ.
        return value, True
    # `sqlite:///C:/path/x.db` trên Windows rơi còn `/C:/path/x.db`; dấu gạch chéo
    # đầu là của URL chứ không phải của đường dẫn.
    if len(value) > 2 and value[0] == "/" and value[2] == ":":
        value = value[1:]
    return value or ":memory:", is_uri


def is_memory(url: str) -> bool:
    """DB trong bộ nhớ không sống sót qua lúc mọi connection đóng.

    Adapter mở/đóng connection cho từng lệnh, nên với `:memory:` thuần dữ liệu sẽ
    biến mất sau câu đầu tiên (bảng vừa CREATE không còn). Vì vậy loại này phải được
    adapter giữ một connection lâu dài; xem `An5Adapter._acquire`.
    """
    target, is_uri = parse_connection_string(url)
    if is_uri:
        # `parse_connection_string` trả về URI nguyên vẹn (kèm `file:`).
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
    # `NOLOCK` không tồn tại; bật WAL để nhiều reader/ghi song song không khoá
    # chặn nhau, và bật foreign_keys vì SQLite mặc định TẮT (khác mọi dialect khác).
    conn.execute("PRAGMA foreign_keys = ON")
    if not is_memory(connection_string) and not is_uri:
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


def placeholder() -> str:
    return "?"
