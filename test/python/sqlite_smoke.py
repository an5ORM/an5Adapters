r"""Smoke test SQLite cho Python adapter.

Chạy:  python test/python/sqlite_smoke.py     (từ thư mục gốc an5Adapters)

Vì sao để ngoài `python/`: adapter phải độc lập, nên thư mục đó không được tham
chiếu tới artifact do an5-generator sinh ra (có test chặn: unit.test.js
"adapters do not depend on generated an5-client artifacts"). Metadata ở đây là
bản sao cố ý, mô phỏng đúng hình dạng generator sinh ra — tên bảng có schema
prefix và cờ `isId` — để bắt được lỗi về placeholder/schema/transaction.

Script tự thêm `python/` vào sys.path nên chạy được ngay từ checkout, không cần
cài trước. Khi đã cài package (ví dụ CI cài wheel), import vẫn resolve từ bản
cài đặt — nên chạy bằng cả hai cách là kiểm tra cả lỗi đóng gói: nếu wheel thiếu
subpackage `sqlite`, chỉ `PYTHONPATH` mới che được, và CI cũng cần chạy
không có `PYTHONPATH` để bắt đúng trường hợp đó.
"""

import json
import os
import sys
import tempfile

# `python/` là gốc package (pyproject đặt package-dir = {"" = "python"}), nên đây
# mới là thư mục chứa `an5_adapter.py` — thêm `an5Adapters/` sẽ không import được.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python"))

from an5_adapter import create_an5_adapter  # noqa: E402
from base import DIALECT_MSSQL, DIALECT_POSTGRES, DIALECT_SQLITE, set_adapter_metadata  # noqa: E402
from base.sql import _quote_table  # noqa: E402
from sqlite.provider import is_memory, parse_connection_string  # noqa: E402

DDL = [
    'CREATE TABLE "CatalogType" ('
    ' "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "nameVi" TEXT NOT NULL,'
    ' "nameEn" TEXT, "source" TEXT NOT NULL DEFAULT \'shared\', "updatedAt" TEXT NOT NULL)',
    'CREATE TABLE "Catalog" ('
    ' "id" TEXT PRIMARY KEY,'
    ' "catalogTypeId" TEXT NOT NULL REFERENCES "CatalogType"("id") ON DELETE CASCADE,'
    ' "key" TEXT NOT NULL, "label" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0,'
    ' "enabled" INTEGER NOT NULL DEFAULT 1, "payload" TEXT, "updatedAt" TEXT NOT NULL,'
    ' UNIQUE ("catalogTypeId","key"))',
]

METADATA = {
    "model_to_table": {"catalogType": "[main].[CatalogType]", "catalog": "[main].[Catalog]"},
    "model_fields": {
        "catalogType": [
            {"name": "id", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": True},
            {"name": "key", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "nameVi", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "nameEn", "sql": "TEXT", "isOptional": True, "hasDefault": False, "isId": False},
            {"name": "source", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "updatedAt", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": False},
        ],
        "catalog": [
            {"name": "id", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": True},
            {"name": "catalogTypeId", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "key", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "label", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "position", "sql": "INTEGER", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "enabled", "sql": "INTEGER", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "payload", "sql": "TEXT", "isOptional": True, "hasDefault": False, "isId": False},
            {"name": "updatedAt", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": False},
        ],
    },
    "relation_map": {
        "catalog": {"type": {"modelName": "catalogType", "foreignKey": "catalogTypeId", "localKey": "id"}},
    },
}

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
    else:
        print(f"  ok   {label} = {got!r}")


def test_parsing():
    print("\n[connection string]")
    check("sqlite path", parse_connection_string("sqlite:///C:/db/catalog.db"), ("C:/db/catalog.db", False))
    check("bare path", parse_connection_string("catalog.db"), ("catalog.db", False))
    check("memory", parse_connection_string("sqlite:///:memory:"), (":memory:", False))
    check("file uri kept", parse_connection_string("sqlite:file::memory:?cache=shared"),
          ("file::memory:?cache=shared", True))
    check("is_memory(:memory:)", is_memory("sqlite:///:memory:"), True)
    check("is_memory(file mem)", is_memory("sqlite:file::memory:?cache=shared"), True)
    check("is_memory(file)", is_memory("sqlite:///C:/db/catalog.db"), False)


def test_quoting():
    print("\n[quoting: MSSQL khong doi, Postgres/SQLite boc lai]")
    check("mssql qualified", _quote_table("[main].[Catalog]", DIALECT_MSSQL), "[main].[Catalog]")
    check("mssql plain", _quote_table("Catalog", DIALECT_MSSQL), "[Catalog]")
    check("sqlite qualified", _quote_table("[main].[Catalog]", DIALECT_SQLITE), '"main"."Catalog"')
    check("sqlite plain", _quote_table("Catalog", DIALECT_SQLITE), '"Catalog"')
    check("postgres qualified", _quote_table("[main].[Catalog]", DIALECT_POSTGRES), '"main"."Catalog"')
    check("dotted literal kept", _quote_table("[odd].[na.me]", DIALECT_SQLITE), '"odd"."na.me"')


def test_crud(url, label):
    print(f"\n[crud: {label}]")
    db = create_an5_adapter(url)
    check("dialect", db._dialect, "sqlite")
    for stmt in DDL:
        db.execute(stmt)
    print("  ok   DDL")

    db.catalogType.create(data={
        "id": "t1", "key": "dyeSystem", "nameVi": "Hệ thuống nhuộm", "nameEn": "Dye system",
        "source": "shared", "updatedAt": "2026-01-01T00:00:00"})
    db.catalog.create(data={
        "id": "c1", "catalogTypeId": "t1", "key": "XF", "label": "Hệ XF", "position": 3,
        "enabled": True, "payload": json.dumps(["XF2"]), "updatedAt": "2026-01-01T00:00:00"})
    db.catalog.create(data={
        "id": "c2", "catalogTypeId": "t1", "key": "ACE", "label": "Hệ ACE", "position": 1,
        "enabled": True, "payload": None, "updatedAt": "2026-01-01T00:00:00"})
    check("find_many order_by", [r["key"] for r in db.catalog.find_many(
        where={"catalogTypeId": "t1"}, order_by={"position": "asc"})], ["ACE", "XF"])
    check("find_first payload", json.loads(db.catalog.find_first(where={"key": "XF"})["payload"]), ["XF2"])
    check("count", db.catalog.count(where={"enabled": True}), 2)
    check("contains", [r["key"] for r in db.catalog.find_many(where={"label": {"contains": "Hệ"}})],
          ["XF", "ACE"])

    db.catalog.update({"id": "c1"}, {"label": "Hệ XF (đã sửa)"})
    check("update", db.catalog.find_first(where={"id": "c1"})["label"], "Hệ XF (đã sửa)")

    try:
        db.catalog.create(data={"id": "c3", "catalogTypeId": "t1", "key": "XF", "label": "trùng",
                                "position": 9, "enabled": True, "updatedAt": "x"})
        check("unique chặn trùng", "không chặn", "IntegrityError")
    except Exception as exc:
        check("unique chặn trùng", type(exc).__name__, "IntegrityError")

    try:
        db.query_proc("some_proc")
        check("query_proc", "không ném lỗi", "NotImplementedError")
    except NotImplementedError:
        check("query_proc", "NotImplementedError", "NotImplementedError")

    def boom(_db):
        db.catalog.create(data={"id": "c9", "catalogTypeId": "t1", "key": "RB", "label": "x",
                                "position": 0, "enabled": True, "updatedAt": "x"})
        raise RuntimeError("co loi")

    try:
        db.transaction(boom)
    except RuntimeError:
        pass
    check("rollback hieu luc", db.catalog.count(where={"key": "RB"}), 0)

    db.transaction(lambda _d: db.catalog.update({"id": "c2"}, {"label": "commit OK"}))
    check("commit", db.catalog.find_first(where={"id": "c2"})["label"], "commit OK")

    try:
        db.transaction(lambda _d: db.transaction(lambda _d: None))
        check("nested transaction", "không ném lỗi", "RuntimeError")
    except RuntimeError:
        check("nested transaction", "RuntimeError", "RuntimeError")

    db.close()


def main():
    set_adapter_metadata(METADATA)
    test_parsing()
    test_quoting()
    test_crud("sqlite:///:memory:", "bo nho")
    path = os.path.join(tempfile.gettempdir(), "an5_sqlite_smoke.db")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    try:
        test_crud(f"sqlite:///{path}", "file thuoc")
    finally:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(path + suffix):
                os.remove(path + suffix)

    print()
    if failures:
        print(f"{len(failures)} CHECK FAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("TAT CA CHECK PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
