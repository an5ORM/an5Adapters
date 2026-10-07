r"""SQLite vector search test for the Python adapter.

Run: python test/python/sqlite_vector.py     (from the an5Adapters root)

A real SQLite file backs every case, so the codec, the strategy plan and the
generated SQL are exercised rather than mocked. The mirror of this coverage for
the TypeScript runtime is test/sqlite-vector.test.js; the module docstring in
`base/vectors.py` is the shared specification for all runtimes.
"""

import json
import os
import sqlite3
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python"))

from an5_adapter import create_an5_adapter  # noqa: E402
from base import set_adapter_metadata  # noqa: E402
from base.vectors import (  # noqa: E402
    AN5_VECTOR_FUNCTIONS,
    SQLITE_VEC_FUNCTIONS,
    decode_vector,
    encode_vector,
    is_vector_field,
    parse_vector,
    plan_sqlite_vector_strategies,
    vector_distance,
)

failures = []


def check(name, got, want):
    if got == want:
        print(f"  OK   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}\n         got:  {got!r}\n         want: {want!r}")


def check_true(name, value):
    check(name, bool(value), True)


VECTORS = {"d1": [1.0, 0.0, 0.0], "d2": [0.8, 0.2, 0.0], "d3": [0.0, 1.0, 0.0]}

DOCUMENT_FIELDS = [
    {"name": "id", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": True},
    {"name": "title", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
    {"name": "embedding", "sql": "VECTOR(3)", "isOptional": True, "hasDefault": False, "isId": False},
]

METADATA = {
    "model_to_table": {"document": "documents", "documents": "documents"},
    "model_fields": {"document": DOCUMENT_FIELDS, "documents": DOCUMENT_FIELDS},
    "model_descriptions": {},
    "relation_map": {},
}


def make_db(declared="BLOB", store="blob"):
    """A SQLite file with a `VECTOR(n)`-style column and three documents."""
    handle, path = tempfile.mkstemp(prefix="an5-vec-", suffix=".sqlite3")
    os.close(handle)
    os.remove(path)
    conn = sqlite3.connect(path)
    conn.execute(f"CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding {declared})")
    for doc_id, vector in VECTORS.items():
        if store == "blob":
            value = encode_vector(vector)
        elif store == "json":
            value = json.dumps(vector)
        else:
            value = None
        conn.execute(
            "INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)",
            (doc_id, f"doc {doc_id}", value),
        )
    conn.commit()
    conn.close()
    return path


def cleanup(path):
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)


def test_codec():
    print("codec")
    check("encode_vector writes little-endian float32", list(encode_vector([1.0])[:4]), [0x00, 0x00, 0x80, 0x3F])
    check("encode_vector length", len(encode_vector([1.0, 2.0, 3.0])), 12)
    check("decode_vector round-trips", decode_vector(encode_vector([0.25, -0.5, 3.0])), [0.25, -0.5, 3.0])
    check("decode_vector reads legacy JSON text", decode_vector("[1, 0, 0]"), [1.0, 0.0, 0.0])
    check("decode_vector passes a list through", decode_vector([1, 2]), [1.0, 2.0])
    check("decode_vector rejects junk", decode_vector("not json"), None)
    check("decode_vector rejects a partial blob", decode_vector(b"\x00\x00\x00"), None)
    check("decode_vector of None", decode_vector(None), None)
    check("parse_vector of empty text", parse_vector(""), None)

    check("cosine of a vector with itself", round(vector_distance([1, 0], [1, 0], "cosine"), 9), 0.0)
    check("cosine of orthogonal vectors", round(vector_distance([1, 0], [0, 1], "cosine"), 9), 1.0)
    check("euclidean distance", round(vector_distance([0, 3], [4, 0], "euclidean"), 9), 5.0)
    check("dot distance is negated", vector_distance([1, 2], [2, 4], "dot"), -10.0)
    check("mismatched dimensions", vector_distance([1, 2], [1, 2, 3], "cosine"), None)

    check_true("is_vector_field on a VECTOR column", is_vector_field(DOCUMENT_FIELDS[2]))
    check("is_vector_field on a TEXT column", is_vector_field(DOCUMENT_FIELDS[1]), False)
    check("is_vector_field on None", is_vector_field(None), False)


def test_plan():
    print("strategy plan")
    all_caps = {"vec": True, "udf": True, "json1": True}
    check("sqlite-vec and the driver function come first", plan_sqlite_vector_strategies(all_caps, "BLOB"),
          ["sqlite-vec", "udf"])
    check("a BLOB column drops the JSON strategy", plan_sqlite_vector_strategies({"vec": False, "udf": False, "json1": True}, "BLOB"),
          [])
    check("a TEXT column keeps the JSON strategy", plan_sqlite_vector_strategies({"vec": False, "udf": False, "json1": True}, "TEXT"),
          ["sql"])
    check("no capability means no plan", plan_sqlite_vector_strategies({"vec": False, "udf": False, "json1": False}, "TEXT"),
          [])
    check("a pinned strategy wins", plan_sqlite_vector_strategies(all_caps, "BLOB", "udf"), ["udf"])
    check("the memory strategy is handled by the caller", plan_sqlite_vector_strategies(all_caps, "BLOB", "memory"), [])

    check("the registered function names are stable", AN5_VECTOR_FUNCTIONS,
          {"cosine": "an5_vec_cosine", "euclidean": "an5_vec_l2", "dot": "an5_vec_ip"})
    check("the extension function names are stable", SQLITE_VEC_FUNCTIONS,
          {"cosine": "vec_distance_cosine", "euclidean": "vec_distance_l2", "dot": "vec_distance_ip"})


def test_search(strategy, declared, store, expected_ids):
    path = make_db(declared, store)
    try:
        db = create_an5_adapter(f"sqlite:///{path}", vector_strategy=strategy)
        rows = db.document.vector_search([1.0, 0.0, 0.0], take=3)
        check(f"{strategy}: row order", [r["id"] for r in rows], expected_ids)
        check(f"{strategy}: distance is a number", all(isinstance(r["distance"], float) for r in rows), True)
        db.close()
    finally:
        cleanup(path)


def test_search_strategies():
    print("search strategies")
    test_search("udf", "BLOB", "blob", ["d1", "d2", "d3"])
    test_search("sql", "TEXT", "json", ["d1", "d2", "d3"])
    test_search("memory", "BLOB", "blob", ["d1", "d2", "d3"])
    test_search("auto", "BLOB", "blob", ["d1", "d2", "d3"])
    test_search("auto", "TEXT", "json", ["d1", "d2", "d3"])


def test_metrics_and_filters():
    print("metrics, filters and odd rows")
    path = make_db()
    try:
        conn = sqlite3.connect(path)
        # A row with a different dimension, and one with no vector at all.
        conn.execute("INSERT INTO documents VALUES (?, ?, ?)", ("d4", "wrong size", encode_vector([1.0, 0.0, 0.0, 1.0])))
        conn.execute("INSERT INTO documents VALUES (?, ?, ?)", ("d5", "no vector", None))
        conn.commit()
        conn.close()

        for metric in ("cosine", "euclidean", "dot"):
            db = create_an5_adapter(f"sqlite:///{path}")
            rows = db.document.vector_search([1.0, 0.0, 0.0], take=9, distance_metric=metric)
            check(f"{metric}: row order", [r["id"] for r in rows], ["d1", "d2", "d3"])
            db.close()

        db = create_an5_adapter(f"sqlite:///{path}")
        rows = db.document.vector_search([1.0, 0.0, 0.0], take=5, where={"id": {"in": ["d1", "d3"]}})
        check("a where filter applies", sorted(r["id"] for r in rows), ["d1", "d3"])
        db.close()
    finally:
        cleanup(path)


def test_round_trip():
    print("column round trip")
    path = make_db()
    try:
        db = create_an5_adapter(f"sqlite:///{path}")
        created = db.document.create({"id": "d9", "title": "written", "embedding": [0.25, 0.5, 1.0]})
        check("create returns numbers", created["embedding"], [0.25, 0.5, 1.0])
        rows = db.document.find_many(where={"id": "d9"})
        check("find_many returns numbers", rows[0]["embedding"], [0.25, 0.5, 1.0])

        conn = sqlite3.connect(path)
        stored = conn.execute("SELECT typeof(embedding) FROM documents WHERE id = ?", ("d9",)).fetchone()[0]
        conn.close()
        check("a list is written as a BLOB", stored, "blob")

        db.document.update(where={"id": "d1"}, data={"embedding": [0.5, 0.5, 0.0]})
        check("update encodes", db.document.find_first(where={"id": "d1"})["embedding"], [0.5, 0.5, 0.0])
        db.document.update_many(where={"id": "d2"}, data={"embedding": [0.0, 0.0, 1.0]})
        check("update_many encodes", db.document.find_first(where={"id": "d2"})["embedding"], [0.0, 0.0, 1.0])

        db.document.create_many([
            {"id": "m1", "title": "a", "embedding": [1.0, 0.0, 0.0]},
            {"id": "m2", "title": "b", "embedding": [0.0, 1.0, 0.0]},
        ])
        rows = db.document.find_many(where={"id": {"in": ["m1", "m2"]}}, order_by={"id": "asc"})
        check("create_many encodes", [r["embedding"] for r in rows], [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        check("a non-vector column is untouched", rows[0]["title"], "a")
        db.close()
    finally:
        cleanup(path)

    # A column written as JSON text by an older version still reads as numbers.
    path = make_db("TEXT", "json")
    try:
        db = create_an5_adapter(f"sqlite:///{path}")
        check("legacy JSON text decodes", db.document.find_first(where={"id": "d1"})["embedding"], [1.0, 0.0, 0.0])
        db.close()
    finally:
        cleanup(path)


def main():
    set_adapter_metadata(METADATA)
    test_codec()
    test_plan()
    test_search_strategies()
    test_metrics_and_filters()
    test_round_trip()
    native_path = os.environ.get("AN5_NATIVE_VECTOR_PATH")
    if native_path:
        path = make_db()
        try:
            db = create_an5_adapter(f"sqlite:///{path}", sqlite_vec=native_path)
            check("native C extension is loaded", db.exec("SELECT an5_vector_version() AS v")[0]["v"], "an5-vector/1")
            single = struct.unpack("<f", struct.pack("<f", 0.1))[0]
            measured = db.exec("SELECT an5_vec_ip('[0.1]', '[0.1]') AS d")[0]["d"]
            check_true("Python preserves the C function instead of replacing it", abs(measured + single * single) < 1e-12)
            for metric in ("cosine", "euclidean", "dot"):
                rows = db.document.vector_search([1, 0, 0], take=2, where={"id": {"in": ["d1", "d2"]}}, distance_metric=metric)
                check(f"native {metric}: row order", [r["id"] for r in rows], ["d1", "d2"])
            db.close()
        finally:
            cleanup(path)
    print()
    if failures:
        print(f"{len(failures)} CHECK FAIL:")
        for name in failures:
            print("  -", name)
        return 1
    print("ALL CHECK PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
